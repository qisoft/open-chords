"""Canonical, file-backed audio decode at the analysis-sidecar module seam."""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import threading
import time
import wave
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO, Final

CANONICAL_CHANNELS: Final = 1
CANONICAL_SAMPLE_FORMAT: Final = "s16le"
CANONICAL_SAMPLE_RATE: Final = 48_000
INPUT_PATH: Final = Path("input/source-media")
OUTPUT_PATH: Final = Path("artifacts/canonical.wav")
MANIFEST_PATH: Final = Path("artifacts/decode-manifest.json")
MAX_TOOL_OUTPUT_BYTES: Final = 64 * 1024
TOOL_TIMEOUT_SECONDS: Final = 30


class CanonicalDecodeError(RuntimeError):
    """A stable failure at the canonical-decode boundary."""


class CanonicalDecodeCancelled(CanonicalDecodeError):
    """Canonical decode stopped cooperatively before publication."""


@dataclass(frozen=True)
class NativeToolchain:
    ffmpeg: Path
    ffprobe: Path


@dataclass(frozen=True)
class CanonicalDecodeConfig:
    platform_profile: str


@dataclass(frozen=True)
class ArtifactDescriptor:
    byte_size: int
    path: str
    sha256: str


@dataclass(frozen=True)
class _ToolResult:
    stdout: bytes
    stderr: bytes


def decode_canonical(
    workspace: Path,
    toolchain: NativeToolchain,
    config: CanonicalDecodeConfig,
    cancellation: threading.Event | None = None,
) -> ArtifactDescriptor:
    """Decode the fixed staged input and publish a deterministic manifest."""

    workspace = workspace.resolve(strict=True)
    input_path = _workspace_file(workspace, INPUT_PATH, must_exist=True)
    output_path = _workspace_file(workspace, OUTPUT_PATH)
    manifest_path = _workspace_file(workspace, MANIFEST_PATH)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    temporary_output = output_path.with_suffix(".wav.partial")
    temporary_manifest = manifest_path.with_suffix(".json.partial")
    artifacts = (temporary_output, output_path, temporary_manifest, manifest_path)
    for artifact in artifacts:
        artifact.unlink(missing_ok=True)
    ffmpeg = _exact_executable(toolchain.ffmpeg)
    ffprobe = _exact_executable(toolchain.ffprobe)
    input_descriptor = _file_descriptor(workspace, input_path)
    cancellation = cancellation or threading.Event()
    try:
        _raise_if_cancelled(cancellation)
        probe = _probe_audio(ffprobe, input_path, cancellation)
        if not probe.get("streams"):
            raise CanonicalDecodeError("staged media has no decodable audio stream")
        _run_tool(
            [
                str(ffmpeg),
                "-nostdin",
                "-hide_banner",
                "-loglevel",
                "error",
                "-nostats",
                "-protocol_whitelist",
                "file,pipe",
                "-probesize",
                "1048576",
                "-analyzeduration",
                "5000000",
                "-fflags",
                "+bitexact",
                "-flags:a",
                "+bitexact",
                "-i",
                str(input_path),
                "-map",
                "0:a:0",
                "-map_metadata",
                "-1",
                "-vn",
                "-sn",
                "-dn",
                "-threads",
                "1",
                "-ac",
                str(CANONICAL_CHANNELS),
                "-ar",
                str(CANONICAL_SAMPLE_RATE),
                "-sample_fmt",
                "s16",
                "-c:a",
                "pcm_s16le",
                "-f",
                "wav",
                "-y",
                str(temporary_output),
            ],
            cancellation,
        )
        _raise_if_cancelled(cancellation)
        os.replace(temporary_output, output_path)
        canonical_audio = _inspect_canonical_wav(output_path)
        _raise_if_cancelled(cancellation)
        if _file_descriptor(workspace, input_path) != input_descriptor:
            raise CanonicalDecodeError("staged media changed during canonical decode")
        configuration = {
            "audioStream": "0:a:0",
            "channels": CANONICAL_CHANNELS,
            "platformProfile": config.platform_profile,
            "sampleFormat": CANONICAL_SAMPLE_FORMAT,
            "sampleRate": CANONICAL_SAMPLE_RATE,
            "schemaVersion": 1,
        }
        manifest = {
            "artifact": _descriptor_json(_file_descriptor(workspace, output_path)),
            "canonicalAudio": canonical_audio,
            "configuration": {
                "sha256": _sha256_bytes(_canonical_json(configuration)),
                "value": configuration,
            },
            "input": _descriptor_json(input_descriptor),
            "schemaVersion": 1,
            "tools": {
                "ffmpeg": _tool_identity(ffmpeg, "-version", cancellation),
                "ffprobe": _tool_identity(ffprobe, "-version", cancellation),
            },
        }
        manifest_bytes = _canonical_json(manifest)
        _raise_if_cancelled(cancellation)
        _write_atomic(manifest_path, manifest_bytes)
        _raise_if_cancelled(cancellation)
        return _file_descriptor(workspace, manifest_path)
    except Exception:
        for artifact in artifacts:
            artifact.unlink(missing_ok=True)
        raise
    finally:
        temporary_output.unlink(missing_ok=True)
        temporary_manifest.unlink(missing_ok=True)


def _probe_audio(
    ffprobe: Path,
    input_path: Path,
    cancellation: threading.Event,
) -> dict[str, object]:
    result = _run_tool(
        [
            str(ffprobe),
            "-v",
            "error",
            "-protocol_whitelist",
            "file,pipe",
            "-probesize",
            "1048576",
            "-analyzeduration",
            "5000000",
            "-select_streams",
            "a:0",
            "-show_entries",
            "stream=codec_name,codec_type,sample_rate,channels,channel_layout",
            "-of",
            "json",
            str(input_path),
        ],
        cancellation,
    )
    try:
        parsed = json.loads(result.stdout)
    except (json.JSONDecodeError, UnicodeDecodeError) as error:
        raise CanonicalDecodeError("ffprobe returned invalid bounded JSON") from error
    if not isinstance(parsed, dict):
        raise CanonicalDecodeError("ffprobe returned an invalid result")
    return parsed


def _run_tool(arguments: list[str], cancellation: threading.Event) -> _ToolResult:
    _raise_if_cancelled(cancellation)
    process = subprocess.Popen(
        arguments,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=_tool_environment(),
        shell=False,
    )
    stdout = bytearray()
    stderr = bytearray()
    exceeded = threading.Event()

    def capture(stream: BinaryIO, target: bytearray) -> None:
        while chunk := stream.read(4096):
            remaining = MAX_TOOL_OUTPUT_BYTES - len(target)
            if remaining > 0:
                target.extend(chunk[:remaining])
            if len(chunk) > remaining:
                exceeded.set()
                process.kill()
                return

    readers = [
        threading.Thread(target=capture, args=(process.stdout, stdout), daemon=True),
        threading.Thread(target=capture, args=(process.stderr, stderr), daemon=True),
    ]
    for reader in readers:
        reader.start()
    deadline = time.monotonic() + TOOL_TIMEOUT_SECONDS
    cancelled = False
    timed_out = False
    return_code: int
    try:
        while True:
            if cancellation.is_set():
                cancelled = True
                process.kill()
                break
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                timed_out = True
                process.kill()
                break
            try:
                return_code = process.wait(timeout=min(0.05, remaining))
                break
            except subprocess.TimeoutExpired:
                continue
        if cancelled or timed_out:
            return_code = process.wait()
    finally:
        for reader in readers:
            reader.join(timeout=1)
        process.stdout.close()
        process.stderr.close()
    if cancelled:
        raise CanonicalDecodeCancelled("canonical decode was cancelled")
    if timed_out:
        raise CanonicalDecodeError("native media tool exceeded its deadline")
    if exceeded.is_set():
        raise CanonicalDecodeError("native media tool exceeded its output budget")
    if return_code != 0:
        raise CanonicalDecodeError(f"native media tool failed with exit code {return_code}")
    return _ToolResult(bytes(stdout), bytes(stderr))


def _tool_environment() -> dict[str, str]:
    environment = {"LANG": "C", "LC_ALL": "C"}
    if os.name == "nt":
        environment["SYSTEMROOT"] = os.environ.get("SYSTEMROOT", "C:\\Windows")
    return environment


def _inspect_canonical_wav(path: Path) -> dict[str, int | str]:
    try:
        with wave.open(str(path), "rb") as audio:
            if (
                audio.getnchannels() != CANONICAL_CHANNELS
                or audio.getsampwidth() != 2
                or audio.getframerate() != CANONICAL_SAMPLE_RATE
                or audio.getcomptype() != "NONE"
            ):
                raise CanonicalDecodeError("FFmpeg output violated the canonical PCM profile")
            sample_count = audio.getnframes()
    except (EOFError, wave.Error) as error:
        raise CanonicalDecodeError("FFmpeg output is not a valid canonical WAV") from error
    return {
        "channels": CANONICAL_CHANNELS,
        "sampleCount": sample_count,
        "sampleFormat": CANONICAL_SAMPLE_FORMAT,
        "sampleRate": CANONICAL_SAMPLE_RATE,
    }


def _tool_identity(
    path: Path,
    version_argument: str,
    cancellation: threading.Event,
) -> dict[str, str]:
    version_lines = (
        _run_tool([str(path), version_argument], cancellation)
        .stdout.decode("utf-8", "replace")
        .splitlines()
    )
    if not version_lines:
        raise CanonicalDecodeError("native media tool did not report its version")
    configuration = next(
        (line.removeprefix("configuration:").strip() for line in version_lines if line.startswith("configuration:")),
        "unreported",
    )
    return {
        "configuration": configuration[:4096],
        "path": path.name,
        "sha256": _sha256_file(path),
        "version": version_lines[0][:512],
    }


def _exact_executable(path: Path) -> Path:
    if not path.is_absolute():
        raise CanonicalDecodeError("native media tool path must be absolute")
    resolved = path.resolve(strict=True)
    if not resolved.is_file():
        raise CanonicalDecodeError("native media tool is not a file")
    return resolved


def _workspace_file(workspace: Path, relative: Path, must_exist: bool = False) -> Path:
    candidate = workspace / relative
    if must_exist:
        candidate = candidate.resolve(strict=True)
    else:
        candidate = candidate.resolve(strict=False)
    if not candidate.is_relative_to(workspace):
        raise CanonicalDecodeError("job artifact escaped its workspace")
    if must_exist and not candidate.is_file():
        raise CanonicalDecodeError("staged media is not a regular file")
    return candidate


def _file_descriptor(workspace: Path, path: Path) -> ArtifactDescriptor:
    return ArtifactDescriptor(
        byte_size=path.stat().st_size,
        path=path.relative_to(workspace).as_posix(),
        sha256=_sha256_file(path),
    )


def _descriptor_json(descriptor: ArtifactDescriptor) -> dict[str, int | str]:
    return {
        "byteSize": descriptor.byte_size,
        "path": descriptor.path,
        "sha256": descriptor.sha256,
    }


def _write_atomic(path: Path, content: bytes) -> None:
    temporary = path.with_suffix(f"{path.suffix}.partial")
    temporary.write_bytes(content)
    os.replace(temporary, path)


def _canonical_json(value: object) -> bytes:
    return (json.dumps(value, ensure_ascii=True, separators=(",", ":"), sort_keys=True) + "\n").encode()


def _sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as file:
        while chunk := file.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _raise_if_cancelled(cancellation: threading.Event, *artifacts: Path) -> None:
    if not cancellation.is_set():
        return
    for artifact in artifacts:
        artifact.unlink(missing_ok=True)
    raise CanonicalDecodeCancelled("canonical decode was cancelled")

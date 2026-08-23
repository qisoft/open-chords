"""Canonical, file-backed audio decode at the analysis-sidecar module seam."""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import threading
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


@dataclass(frozen=True)
class NativeToolchain:
    ffmpeg: Path
    ffprobe: Path


@dataclass(frozen=True)
class CanonicalDecodeConfig:
    platform_profile: str
    channels: int = CANONICAL_CHANNELS
    sample_format: str = CANONICAL_SAMPLE_FORMAT
    sample_rate: int = CANONICAL_SAMPLE_RATE


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
) -> ArtifactDescriptor:
    """Decode the fixed staged input and publish a deterministic manifest."""

    workspace = workspace.resolve(strict=True)
    input_path = _workspace_file(workspace, INPUT_PATH, must_exist=True)
    output_path = _workspace_file(workspace, OUTPUT_PATH)
    manifest_path = _workspace_file(workspace, MANIFEST_PATH)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    ffmpeg = _exact_executable(toolchain.ffmpeg)
    ffprobe = _exact_executable(toolchain.ffprobe)
    input_descriptor = _file_descriptor(workspace, input_path)

    probe = _probe_audio(ffprobe, input_path)
    if not probe.get("streams"):
        raise CanonicalDecodeError("staged media has no decodable audio stream")

    temporary_output = output_path.with_suffix(".wav.partial")
    temporary_output.unlink(missing_ok=True)
    try:
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
                str(config.channels),
                "-ar",
                str(config.sample_rate),
                "-sample_fmt",
                "s16",
                "-c:a",
                "pcm_s16le",
                "-f",
                "wav",
                "-y",
                str(temporary_output),
            ]
        )
        os.replace(temporary_output, output_path)
    finally:
        temporary_output.unlink(missing_ok=True)

    canonical_audio = _inspect_canonical_wav(output_path, config)
    if _file_descriptor(workspace, input_path) != input_descriptor:
        output_path.unlink(missing_ok=True)
        raise CanonicalDecodeError("staged media changed during canonical decode")
    configuration = {
        "audioStream": "0:a:0",
        "channels": config.channels,
        "platformProfile": config.platform_profile,
        "sampleFormat": config.sample_format,
        "sampleRate": config.sample_rate,
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
            "ffmpeg": _tool_identity(ffmpeg, "-version"),
            "ffprobe": _tool_identity(ffprobe, "-version"),
        },
    }
    manifest_bytes = _canonical_json(manifest)
    _write_atomic(manifest_path, manifest_bytes)
    return _file_descriptor(workspace, manifest_path)


def _probe_audio(ffprobe: Path, input_path: Path) -> dict[str, object]:
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
        ]
    )
    try:
        parsed = json.loads(result.stdout)
    except (json.JSONDecodeError, UnicodeDecodeError) as error:
        raise CanonicalDecodeError("ffprobe returned invalid bounded JSON") from error
    if not isinstance(parsed, dict):
        raise CanonicalDecodeError("ffprobe returned an invalid result")
    return parsed


def _run_tool(arguments: list[str]) -> _ToolResult:
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
    try:
        return_code = process.wait(timeout=TOOL_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired as error:
        process.kill()
        process.wait()
        raise CanonicalDecodeError("native media tool exceeded its deadline") from error
    finally:
        for reader in readers:
            reader.join(timeout=1)
        process.stdout.close()
        process.stderr.close()
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


def _inspect_canonical_wav(path: Path, config: CanonicalDecodeConfig) -> dict[str, int | str]:
    try:
        with wave.open(str(path), "rb") as audio:
            if (
                audio.getnchannels() != config.channels
                or audio.getsampwidth() != 2
                or audio.getframerate() != config.sample_rate
                or audio.getcomptype() != "NONE"
            ):
                raise CanonicalDecodeError("FFmpeg output violated the canonical PCM profile")
            sample_count = audio.getnframes()
    except (EOFError, wave.Error) as error:
        raise CanonicalDecodeError("FFmpeg output is not a valid canonical WAV") from error
    return {
        "channels": config.channels,
        "sampleCount": sample_count,
        "sampleFormat": config.sample_format,
        "sampleRate": config.sample_rate,
    }


def _tool_identity(path: Path, version_argument: str) -> dict[str, str]:
    version_lines = (
        _run_tool([str(path), version_argument])
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

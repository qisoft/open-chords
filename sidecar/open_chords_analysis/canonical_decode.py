"""Canonical, file-backed audio decode at the analysis-sidecar module seam."""

from __future__ import annotations

import ctypes
import hashlib
import json
import os
import subprocess
import sys
import threading
import time
import wave
from dataclasses import dataclass
from enum import Enum
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


class CanonicalDecodeFailureCode(str, Enum):
    DECODE = "canonical_decode_failed"
    PREPARE = "canonical_prepare_failed"
    PROBE = "canonical_probe_failed"
    PROBE_EXECUTION = "canonical_probe_execution_failed"
    PROBE_EXIT = "canonical_probe_exit_failed"
    PROBE_LOADER_INIT = "canonical_probe_loader_init_failed"
    PROBE_LOADER_INVALID_IMAGE = "canonical_probe_loader_invalid_image"
    PROBE_LOADER_MISSING = "canonical_probe_loader_missing"
    PROBE_LOADER_SYMBOL = "canonical_probe_loader_symbol_missing"
    PROBE_OUTPUT_LIMIT = "canonical_probe_output_limit_failed"
    PROBE_PROCESS_CLEANUP = "canonical_probe_process_cleanup_failed"
    PROBE_PROCESS = "canonical_probe_process_failed"
    PROBE_OUTPUT = "canonical_probe_output_failed"
    PROBE_RUNTIME = "canonical_probe_runtime_failed"
    PROBE_SPAWN = "canonical_probe_spawn_failed"
    PROBE_STREAM = "canonical_probe_stream_missing"
    PROBE_TIMEOUT = "canonical_probe_timeout_failed"
    TRANSCODE = "canonical_transcode_failed"
    ARTIFACT_VALIDATION = "canonical_artifact_validation_failed"
    TOOL_IDENTITY = "canonical_tool_identity_failed"
    PUBLICATION = "canonical_publication_failed"
    CLEANUP = "canonical_cleanup_failed"


class CanonicalDecodeError(RuntimeError):
    """A stable failure at the canonical-decode boundary."""

    def __init__(
        self,
        message: str,
        *,
        code: CanonicalDecodeFailureCode = CanonicalDecodeFailureCode.DECODE,
    ) -> None:
        super().__init__(message)
        self.code = code


class CanonicalDecodeCancelled(CanonicalDecodeError):
    """Canonical decode stopped cooperatively before publication."""


class _NativeToolRuntimeError(RuntimeError):
    """Frozen runtime preparation failed before a native tool spawn."""


class _NativeToolSpawnError(RuntimeError):
    """The operating system rejected a native tool spawn."""


class _NativeToolExitError(RuntimeError):
    """A native tool returned a nonzero process status."""

    def __init__(self, return_code: int) -> None:
        super().__init__("native media tool returned a nonzero process status")
        self.return_code = return_code


class _NativeToolOutputLimitError(RuntimeError):
    """A native tool exceeded the bounded capture budget."""


class _NativeToolTimeoutError(RuntimeError):
    """A native tool exceeded its process deadline."""


class _NativeToolCleanupError(RuntimeError):
    """A native tool process could not be fully reaped and closed."""


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

    artifacts: tuple[Path, ...] = ()
    failure_code = CanonicalDecodeFailureCode.PREPARE
    try:
        workspace = workspace.resolve(strict=True)
        output_path = _workspace_file(workspace, OUTPUT_PATH)
        manifest_path = _workspace_file(workspace, MANIFEST_PATH)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        temporary_output = output_path.with_suffix(".wav.partial")
        temporary_manifest = manifest_path.with_suffix(".json.partial")
        artifacts = (temporary_output, output_path, temporary_manifest, manifest_path)
        if cleanup_error := _cleanup_artifacts(artifacts):
            failure_code = CanonicalDecodeFailureCode.CLEANUP
            raise cleanup_error
        input_path = _workspace_file(workspace, INPUT_PATH, must_exist=True)
        ffmpeg = _exact_executable(toolchain.ffmpeg)
        ffprobe = _exact_executable(toolchain.ffprobe)
        input_descriptor = _file_descriptor(workspace, input_path)
        cancellation = cancellation or threading.Event()
        _raise_if_cancelled(cancellation)
        failure_code = CanonicalDecodeFailureCode.PROBE
        probe = _probe_audio(ffprobe, input_path, cancellation)
        if not probe.get("streams"):
            raise CanonicalDecodeError(
                "staged media has no decodable audio stream",
                code=CanonicalDecodeFailureCode.PROBE_STREAM,
            )
        failure_code = CanonicalDecodeFailureCode.TRANSCODE
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
        failure_code = CanonicalDecodeFailureCode.ARTIFACT_VALIDATION
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
        failure_code = CanonicalDecodeFailureCode.TOOL_IDENTITY
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
        failure_code = CanonicalDecodeFailureCode.PUBLICATION
        manifest_bytes = _canonical_json(manifest)
        _raise_if_cancelled(cancellation)
        _write_atomic(manifest_path, manifest_bytes)
        _raise_if_cancelled(cancellation)
        return _file_descriptor(workspace, manifest_path)
    except CanonicalDecodeCancelled:
        if cleanup_error := _cleanup_artifacts(artifacts):
            raise CanonicalDecodeError(
                "Canonical media cleanup failed",
                code=CanonicalDecodeFailureCode.CLEANUP,
            ) from cleanup_error
        raise
    except Exception as error:
        if cleanup_error := _cleanup_artifacts(artifacts):
            raise CanonicalDecodeError(
                "Canonical media cleanup failed",
                code=CanonicalDecodeFailureCode.CLEANUP,
            ) from cleanup_error
        bounded_code = (
            error.code
            if isinstance(error, CanonicalDecodeError)
            and error.code is not CanonicalDecodeFailureCode.DECODE
            else failure_code
        )
        raise CanonicalDecodeError("Canonical media decode failed", code=bounded_code) from error


def _probe_audio(
    ffprobe: Path,
    input_path: Path,
    cancellation: threading.Event,
) -> dict[str, object]:
    try:
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
                "stream=codec_type",
                "-of",
                "json",
                str(input_path),
            ],
            cancellation,
        )
    except CanonicalDecodeCancelled:
        raise
    except _NativeToolRuntimeError as error:
        raise CanonicalDecodeError(
            "ffprobe runtime preparation failed",
            code=CanonicalDecodeFailureCode.PROBE_RUNTIME,
        ) from error
    except _NativeToolSpawnError as error:
        raise CanonicalDecodeError(
            "ffprobe process spawn failed",
            code=CanonicalDecodeFailureCode.PROBE_SPAWN,
        ) from error
    except _NativeToolTimeoutError as error:
        raise CanonicalDecodeError(
            "ffprobe process timed out",
            code=CanonicalDecodeFailureCode.PROBE_TIMEOUT,
        ) from error
    except _NativeToolOutputLimitError as error:
        raise CanonicalDecodeError(
            "ffprobe output exceeded its bound",
            code=CanonicalDecodeFailureCode.PROBE_OUTPUT_LIMIT,
        ) from error
    except _NativeToolCleanupError as error:
        raise CanonicalDecodeError(
            "ffprobe process cleanup failed",
            code=CanonicalDecodeFailureCode.PROBE_PROCESS_CLEANUP,
        ) from error
    except _NativeToolExitError as error:
        loader_codes = {
            0xC000007B: CanonicalDecodeFailureCode.PROBE_LOADER_INVALID_IMAGE,
            0xC000012F: CanonicalDecodeFailureCode.PROBE_LOADER_INVALID_IMAGE,
            0xC0000135: CanonicalDecodeFailureCode.PROBE_LOADER_MISSING,
            0xC0000138: CanonicalDecodeFailureCode.PROBE_LOADER_SYMBOL,
            0xC0000139: CanonicalDecodeFailureCode.PROBE_LOADER_SYMBOL,
            0xC0000142: CanonicalDecodeFailureCode.PROBE_LOADER_INIT,
        }
        code = loader_codes.get(
            error.return_code & 0xFFFFFFFF,
            CanonicalDecodeFailureCode.PROBE_EXIT,
        )
        raise CanonicalDecodeError("ffprobe exited unsuccessfully", code=code) from error
    except CanonicalDecodeError as error:
        raise CanonicalDecodeError(
            "ffprobe process failed",
            code=CanonicalDecodeFailureCode.PROBE_PROCESS,
        ) from error
    except Exception as error:
        raise CanonicalDecodeError(
            "ffprobe execution failed",
            code=CanonicalDecodeFailureCode.PROBE_EXECUTION,
        ) from error
    try:
        parsed = json.loads(result.stdout)
    except (json.JSONDecodeError, UnicodeDecodeError) as error:
        raise CanonicalDecodeError(
            "ffprobe returned invalid bounded JSON",
            code=CanonicalDecodeFailureCode.PROBE_OUTPUT,
        ) from error
    if not isinstance(parsed, dict):
        raise CanonicalDecodeError(
            "ffprobe returned an invalid result",
            code=CanonicalDecodeFailureCode.PROBE_OUTPUT,
        )
    if not set(parsed).issubset({"programs", "stream_groups", "streams"}):
        raise CanonicalDecodeError(
            "ffprobe returned unexpected result fields",
            code=CanonicalDecodeFailureCode.PROBE_OUTPUT,
        )
    if any(parsed.get(field, []) != [] for field in ("programs", "stream_groups")):
        raise CanonicalDecodeError(
            "ffprobe returned unexpected grouped streams",
            code=CanonicalDecodeFailureCode.PROBE_OUTPUT,
        )
    streams = parsed.get("streams")
    if (
        not isinstance(streams, list)
        or len(streams) > 1
        or any(not _is_bounded_audio_stream(stream) for stream in streams)
    ):
        raise CanonicalDecodeError(
            "ffprobe returned an invalid stream result",
            code=CanonicalDecodeFailureCode.PROBE_OUTPUT,
        )
    return parsed


def _is_bounded_audio_stream(stream: object) -> bool:
    return isinstance(stream, dict) and stream == {"codec_type": "audio"}


def _run_tool(arguments: list[str], cancellation: threading.Event) -> _ToolResult:
    _raise_if_cancelled(cancellation)
    try:
        _sanitize_external_tool_runtime()
    except Exception as error:
        raise _NativeToolRuntimeError("native tool runtime preparation failed") from error
    try:
        process = subprocess.Popen(
            arguments,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=_tool_environment(),
            shell=False,
        )
    except Exception as error:
        raise _NativeToolSpawnError("native tool process spawn failed") from error
    started_readers: list[threading.Thread] = []
    reaped = False
    primary_error: BaseException | None = None
    try:
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
        cancelled = False
        timed_out = False
        return_code: int | None = None
        for reader in readers:
            reader.start()
            started_readers.append(reader)
        deadline = time.monotonic() + TOOL_TIMEOUT_SECONDS
        while True:
            if cancellation.is_set():
                cancelled = True
                break
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                timed_out = True
                break
            try:
                return_code = process.wait(timeout=min(0.05, remaining))
                reaped = True
                break
            except subprocess.TimeoutExpired:
                continue
    except BaseException as error:
        primary_error = error
        raise
    finally:
        if cleanup_error := _cleanup_native_process(
            process,
            started_readers,
            reaped=reaped,
        ):
            if primary_error is not None:
                raise primary_error from cleanup_error
            raise cleanup_error
    if cancelled:
        raise CanonicalDecodeCancelled("canonical decode was cancelled")
    if timed_out:
        raise _NativeToolTimeoutError("native media tool exceeded its deadline")
    if return_code is None:
        raise RuntimeError("native media tool ended without a process status")
    if exceeded.is_set():
        raise _NativeToolOutputLimitError("native media tool exceeded its output budget")
    if return_code != 0:
        raise _NativeToolExitError(return_code)
    return _ToolResult(bytes(stdout), bytes(stderr))


def _cleanup_native_process(
    process: subprocess.Popen[bytes],
    readers: list[threading.Thread],
    *,
    reaped: bool,
) -> _NativeToolCleanupError | None:
    cleanup_failed = False
    if not reaped:
        for _attempt in range(2):
            try:
                process.kill()
            except Exception:
                pass
            try:
                process.wait(timeout=1)
                reaped = True
                break
            except Exception:
                continue
        if not reaped:
            cleanup_failed = True
    for reader in readers:
        try:
            reader.join(timeout=1)
            if reader.is_alive():
                cleanup_failed = True
        except Exception:
            cleanup_failed = True
    for pipe in (process.stdout, process.stderr):
        try:
            pipe.close()
        except Exception:
            cleanup_failed = True
    return _NativeToolCleanupError("native media tool cleanup failed") if cleanup_failed else None


def _sanitize_external_tool_runtime() -> None:
    if sys.platform != "win32" or not getattr(sys, "frozen", False):
        return
    # PyInstaller's bundle directory must not affect the pinned external tools' DLL resolution.
    if ctypes.windll.kernel32.SetDllDirectoryW(None) == 0:
        raise OSError("failed to restore the Windows DLL search path")


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


def _raise_if_cancelled(cancellation: threading.Event) -> None:
    if not cancellation.is_set():
        return
    raise CanonicalDecodeCancelled("canonical decode was cancelled")


def _cleanup_artifacts(artifacts: tuple[Path, ...]) -> OSError | None:
    first_error: OSError | None = None
    for artifact in artifacts:
        try:
            artifact.unlink(missing_ok=True)
        except OSError as error:
            first_error = first_error or error
    return first_error

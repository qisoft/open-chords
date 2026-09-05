"""Versioned stdin/stdout protocol for one frozen analysis session."""

from __future__ import annotations

import hashlib
import json
import os
import re
import stat
import struct
import sys
import threading
from dataclasses import dataclass
from pathlib import Path
from queue import Empty, Queue
from typing import BinaryIO, Final

from .canonical_decode import (
    ArtifactDescriptor,
    CanonicalDecodeConfig,
    CanonicalDecodeCancelled,
    CanonicalDecodeError,
    CanonicalDecodeFailureCode,
    NativeToolchain,
    decode_canonical,
)
from .analysis_profiles import PROFILE_SETTINGS

MAX_FRAME_BYTES: Final = 1024 * 1024
MAX_ID_BYTES: Final = 256
PROTOCOL_VERSION: Final = 1
HEARTBEAT_INTERVAL_SECONDS: Final = 5
TERMINAL_CONTROL_ARBITRATION_SECONDS: Final = 0.1
SHA256_PATTERN: Final = re.compile(r"^[a-f0-9]{64}$")
ANALYSIS_RECIPE_PATH: Final = Path("input/analysis-recipe.json")
ANALYSIS_RESULT_PATH: Final = Path("artifacts/analysis-result.json")
MAX_ANALYSIS_RECIPE_BYTES: Final = 1024 * 1024
MAX_ANALYSIS_RESULT_BYTES: Final = 16 * 1024 * 1024


class ProtocolError(RuntimeError):
    """A malformed or unsupported sidecar protocol message."""


class AnalysisExecutionError(RuntimeError):
    """The staged Recipe could not produce a complete analysis candidate."""

    def __init__(self, kind: str) -> None:
        super().__init__(kind)
        self.kind = kind


class _CleanInputEnd(ProtocolError):
    """The control stream closed between complete frames."""


@dataclass(frozen=True)
class FrozenRuntime:
    manifest_hash: str
    platform_profile: str
    toolchain: NativeToolchain


@dataclass(frozen=True)
class _Start:
    job_id: str
    manifest_hash: str
    nonce: str
    request_id: str


@dataclass(frozen=True)
class _Cancel:
    job_id: str
    nonce: str
    request_id: str
    sequence: int


def serve_one_session(
    stdin: BinaryIO,
    stdout: BinaryIO,
    workspace: Path,
    runtime: FrozenRuntime,
    *,
    workspace_is_current_directory: bool = False,
) -> None:
    """Read one start frame, publish one result/error, and return."""

    start = _parse_start(_read_frame(stdin))
    _write_frame(
        stdout,
        {
            "capabilities": [
                "analysis",
                "canonical_decode",
                "cpu_analysis",
                *[f"profile:{profile}" for profile in sorted(PROFILE_SETTINGS)],
            ],
            "manifestHash": runtime.manifest_hash,
            "nonce": start.nonce,
            "protocolVersion": PROTOCOL_VERSION,
            "sequence": 0,
            "type": "handshake",
        },
    )
    if start.manifest_hash != runtime.manifest_hash:
        return
    cancellation = threading.Event()
    events: Queue[tuple[str, object]] = Queue()
    analysis_import_error: Exception | None = None
    sequence = 1
    preload_probe = Path("preload-proof.json")
    preload_probe_enabled = preload_probe.is_file()
    if (workspace / ANALYSIS_RECIPE_PATH).exists():
        preload_finished = threading.Event()
        preload_output_errors: list[Exception] = []
        preload_sequence = [sequence]

        def write_preload_heartbeats() -> None:
            while not preload_finished.wait(HEARTBEAT_INTERVAL_SECONDS):
                try:
                    if preload_probe_enabled:
                        _write_execution_probe(preload_probe)
                    _write_frame(
                        stdout,
                        {
                            "nonce": start.nonce,
                            "sequence": preload_sequence[0],
                            "type": "heartbeat",
                        },
                    )
                    preload_sequence[0] += 1
                except Exception as error:
                    preload_output_errors.append(error)
                    return

        preload_heartbeat_thread = threading.Thread(
            target=write_preload_heartbeats,
            daemon=True,
        )
        preload_heartbeat_thread.start()
        try:
            # Import NumPy, SciPy, Librosa, and Numba on the interpreter's main
            # thread. Their frozen Windows initialization is not a safe first
            # import from the decode worker inside AppContainer.
            _preload_cpu_analysis()
        except Exception as error:
            analysis_import_error = error
        finally:
            preload_finished.set()
            preload_heartbeat_thread.join()
        if preload_output_errors:
            raise preload_output_errors[0]
        sequence = preload_sequence[0]

    def read_control() -> None:
        try:
            control = _parse_cancel(_read_frame(stdin, allow_clean_eof=True))
        except _CleanInputEnd:
            return
        except ProtocolError as error:
            cancellation.set()
            events.put(("control_error", error))
            return
        except Exception as error:
            cancellation.set()
            events.put(("control_error", error))
            return
        cancellation.set()
        events.put(("cancel", control))

    def run_decode() -> None:
        try:
            decode_kwargs = (
                {"workspace_is_current_directory": True}
                if workspace_is_current_directory
                else {}
            )
            artifact = decode_canonical(
                workspace,
                runtime.toolchain,
                CanonicalDecodeConfig(platform_profile=runtime.platform_profile),
                cancellation,
                **decode_kwargs,
            )
            recipe_path = workspace / ANALYSIS_RECIPE_PATH
            if recipe_path.exists():
                if cancellation.is_set():
                    raise CanonicalDecodeCancelled("analysis cancelled before CPU processing")
                try:
                    if analysis_import_error is not None:
                        raise analysis_import_error
                    candidate = _analyze_decoded(workspace)
                    if cancellation.is_set():
                        raise CanonicalDecodeCancelled("analysis cancelled before publication")
                    artifact = _publish_analysis_result(
                        workspace, candidate,
                        workspace_is_current_directory=workspace_is_current_directory,
                    )
                except CanonicalDecodeCancelled:
                    raise
                except Exception as error:
                    raise AnalysisExecutionError(
                        _analysis_failure_kind(error, workspace)
                    ) from error
        except CanonicalDecodeCancelled as error:
            events.put(("decode_cancelled", error))
        except CanonicalDecodeError as error:
            events.put(("decode_error", error))
        except AnalysisExecutionError as error:
            events.put(("analysis_error", error))
        except Exception as error:
            events.put(("decode_error", error))
        else:
            events.put(("result", artifact))

    control_thread = threading.Thread(target=read_control, daemon=True)
    control_thread.start()
    decode_thread = threading.Thread(target=run_decode, daemon=True)
    decode_thread.start()
    cancel_received = False
    decode_finished = False
    decode_cleanup_failed = False
    while True:
        try:
            event, payload = events.get(timeout=HEARTBEAT_INTERVAL_SECONDS)
        except Empty:
            if not cancel_received and not decode_finished:
                if preload_probe_enabled:
                    _write_execution_probe(preload_probe)
                _write_frame(
                    stdout,
                    {"nonce": start.nonce, "sequence": sequence, "type": "heartbeat"},
                )
                sequence += 1
            continue
        if event == "control_error":
            decode_thread.join(timeout=1)
            raise payload if isinstance(payload, Exception) else ProtocolError("invalid control")
        if event == "cancel":
            cancel = payload
            if not isinstance(cancel, _Cancel) or not _cancel_matches(cancel, start, sequence):
                raise ProtocolError("sidecar cancel did not match the active session")
            cancel_received = True
            _write_frame(stdout, {**_identity(start, sequence), "type": "cancel_ack"})
            sequence += 1
            if decode_finished:
                _write_cleanup_terminal(
                    stdout,
                    start,
                    sequence,
                    workspace,
                    force_failure=decode_cleanup_failed,
                )
                return
            continue
        if event == "result":
            decode_finished = True
            if not cancel_received:
                control_thread.join(timeout=TERMINAL_CONTROL_ARBITRATION_SECONDS)
                if cancellation.is_set():
                    events.put(("result", payload))
                    continue
            if cancel_received:
                _write_cleanup_terminal(stdout, start, sequence, workspace)
                return
            if not isinstance(payload, ArtifactDescriptor):
                raise ProtocolError("canonical decode returned an invalid descriptor")
            _write_frame(
                stdout,
                {**_identity(start, sequence), "artifact": _descriptor_json(payload), "type": "result"},
            )
            return
        if event in {"decode_cancelled", "decode_error", "analysis_error"}:
            decode_finished = True
            decode_cleanup_failed = (
                isinstance(payload, CanonicalDecodeError)
                and payload.code is CanonicalDecodeFailureCode.CLEANUP
            )
            if cancel_received:
                _write_cleanup_terminal(
                    stdout,
                    start,
                    sequence,
                    workspace,
                    force_failure=decode_cleanup_failed,
                )
                return
            if cancellation.is_set():
                continue
            _write_frame(
                stdout,
                {
                    **_identity(start, sequence),
                    "code": (
                        "analysis_failed"
                        if event == "analysis_error"
                        else payload.code
                        if isinstance(payload, CanonicalDecodeError)
                        and isinstance(payload.code, CanonicalDecodeFailureCode)
                        else CanonicalDecodeFailureCode.DECODE
                    ),
                    "message": (
                        f"CPU analysis failed [{payload.kind}]"
                        if event == "analysis_error"
                        and isinstance(payload, AnalysisExecutionError)
                        else "CPU analysis failed [unknown]"
                        if event == "analysis_error"
                        else "Canonical media decode failed"
                    ),
                    "type": "error",
                },
            )
            return


def _read_frame(stream: BinaryIO, *, allow_clean_eof: bool = False) -> object:
    header = _read_exact(
        stream,
        4,
        "sidecar input ended before a complete frame header",
        allow_clean_eof=allow_clean_eof,
    )
    length = struct.unpack(">I", header)[0]
    if length > MAX_FRAME_BYTES:
        raise ProtocolError("sidecar input frame exceeds one MiB")
    payload = _read_exact(stream, length, "sidecar input ended before a complete frame")
    try:
        return json.loads(payload)
    except (json.JSONDecodeError, UnicodeDecodeError) as error:
        raise ProtocolError("sidecar input is not valid JSON") from error


def _write_frame(stream: BinaryIO, message: object) -> None:
    payload = json.dumps(message, ensure_ascii=True, separators=(",", ":"), sort_keys=True).encode()
    if len(payload) > MAX_FRAME_BYTES:
        raise ProtocolError("sidecar output frame exceeds one MiB")
    stream.write(struct.pack(">I", len(payload)))
    stream.write(payload)
    stream.flush()


def _parse_start(message: object) -> _Start:
    if not isinstance(message, dict) or set(message) != {
        "jobId",
        "manifestHash",
        "nonce",
        "requestId",
        "sequence",
        "type",
    }:
        raise ProtocolError("invalid sidecar start envelope")
    if (
        message["type"] != "start"
        or type(message["sequence"]) is not int
        or message["sequence"] != 0
    ):
        raise ProtocolError("invalid sidecar start semantics")
    identifiers = [message["jobId"], message["nonce"], message["requestId"]]
    if any(not _valid_identifier(value) for value in identifiers):
        raise ProtocolError("invalid sidecar session identity")
    manifest_hash = message["manifestHash"]
    if not isinstance(manifest_hash, str) or SHA256_PATTERN.fullmatch(manifest_hash) is None:
        raise ProtocolError("invalid sidecar manifest hash")
    return _Start(
        job_id=message["jobId"],
        manifest_hash=manifest_hash,
        nonce=message["nonce"],
        request_id=message["requestId"],
    )


def _parse_cancel(message: object) -> _Cancel:
    if not isinstance(message, dict) or set(message) != {
        "jobId",
        "nonce",
        "requestId",
        "sequence",
        "type",
    }:
        raise ProtocolError("invalid sidecar cancel envelope")
    if message["type"] != "cancel" or type(message["sequence"]) is not int:
        raise ProtocolError("invalid sidecar cancel semantics")
    identifiers = [message["jobId"], message["nonce"], message["requestId"]]
    if any(not _valid_identifier(value) for value in identifiers):
        raise ProtocolError("invalid sidecar cancel identity")
    return _Cancel(
        job_id=message["jobId"],
        nonce=message["nonce"],
        request_id=message["requestId"],
        sequence=message["sequence"],
    )


def _read_exact(
    stream: BinaryIO,
    length: int,
    failure: str,
    *,
    allow_clean_eof: bool = False,
) -> bytes:
    content = bytearray()
    while len(content) < length:
        chunk = stream.read(length - len(content))
        if not chunk:
            if allow_clean_eof and not content:
                raise _CleanInputEnd("sidecar input ended between frames")
            raise ProtocolError(failure)
        content.extend(chunk)
    return bytes(content)


def _valid_identifier(value: object) -> bool:
    if not isinstance(value, str) or not value:
        return False
    try:
        return len(value.encode("utf-8")) <= MAX_ID_BYTES
    except UnicodeEncodeError:
        return False


def _identity(start: _Start, sequence: int) -> dict[str, int | str]:
    return {
        "jobId": start.job_id,
        "nonce": start.nonce,
        "requestId": start.request_id,
        "sequence": sequence,
    }


def _cancel_matches(cancel: _Cancel, start: _Start, sequence: int) -> bool:
    return (
        cancel.job_id == start.job_id
        and cancel.nonce == start.nonce
        and cancel.request_id == start.request_id
        # Main sends the next sequence it has consumed. Heartbeats already
        # written to the pipe may advance our counter before cancel arrives;
        # main drains those frames before accepting the acknowledgement.
        and 1 <= cancel.sequence <= sequence
    )


def _cleanup_decode_artifacts(workspace: Path) -> bool:
    cleanup_succeeded = True
    try:
        workspace_root = workspace.resolve(strict=True)
    except OSError:
        return False
    for relative in (
        "artifacts/canonical.wav.partial",
        "artifacts/canonical.wav",
        "artifacts/decode-manifest.json.partial",
        "artifacts/decode-manifest.json",
        "artifacts/analysis-result.json.partial",
        "artifacts/analysis-result.json",
    ):
        candidate = workspace_root / relative
        try:
            candidate.lstat()
        except FileNotFoundError:
            continue
        except OSError:
            cleanup_succeeded = False
            continue
        try:
            resolved_parent = candidate.parent.resolve(strict=True)
        except OSError:
            cleanup_succeeded = False
            continue
        if not resolved_parent.is_relative_to(workspace_root):
            cleanup_succeeded = False
            continue
        try:
            candidate.unlink(missing_ok=True)
        except OSError:
            cleanup_succeeded = False
    return cleanup_succeeded


def _write_cleanup_terminal(
    stdout: BinaryIO,
    start: _Start,
    sequence: int,
    workspace: Path,
    *,
    force_failure: bool = False,
) -> None:
    cleanup_succeeded = _cleanup_decode_artifacts(workspace)
    if force_failure or not cleanup_succeeded:
        _write_frame(
            stdout,
            {
                **_identity(start, sequence),
                "code": CanonicalDecodeFailureCode.CLEANUP,
                "message": "Canonical media cleanup failed",
                "type": "error",
            },
        )
        return
    _write_frame(stdout, {**_identity(start, sequence), "type": "cleanup_complete"})


def _descriptor_json(descriptor: ArtifactDescriptor) -> dict[str, int | str]:
    return {
        "byteSize": descriptor.byte_size,
        "path": descriptor.path,
        "sha256": descriptor.sha256,
    }


def _analyze_decoded(workspace: Path) -> dict[str, object]:
    from .cpu_analysis import AnalysisConfig, analyze_canonical

    recipe_path = workspace / ANALYSIS_RECIPE_PATH
    if recipe_path.is_symlink() or not recipe_path.is_file():
        raise ProtocolError("analysis Recipe is not a regular file")
    recipe_bytes = recipe_path.read_bytes()
    if not recipe_bytes or len(recipe_bytes) > MAX_ANALYSIS_RECIPE_BYTES:
        raise ProtocolError("analysis Recipe exceeds its bounded size")
    try:
        recipe = json.loads(recipe_bytes)
    except (json.JSONDecodeError, UnicodeDecodeError) as error:
        raise ProtocolError("analysis Recipe is invalid") from error
    result = analyze_canonical(
        workspace / "artifacts" / "canonical.wav",
        AnalysisConfig.from_recipe_document(recipe),
    )
    document = result.to_document()
    # This entry is reached only after staged-input preflight and canonical
    # decode succeed. The CPU module reports its own stages, not those seams.
    document["stageOutcomes"] = [
        {"stage": "preflight", "state": "completed"},
        {"stage": "canonical_decode", "state": "completed"},
        *document["stageOutcomes"],
    ]
    return document


def _write_execution_probe(path: Path) -> None:
    scopes = []
    allowed = {
        "numpy", "scipy", "numba", "librosa", "llvmlite", "joblib",
        "threadpoolctl", "sklearn", "pooch", "soundfile", "threading",
        "ctypes", "importlib", "_frozen_importlib", "_frozen_importlib_external",
        "sidecar", "pathlib", "subprocess", "queue", "os", "ntpath", "tempfile",
        "multiprocessing", "encodings", "logging", "enum", "re",
    }
    for frame in sys._current_frames().values():
        while frame is not None and len(scopes) < 128:
            module = str(frame.f_globals.get("__name__", ""))
            if module.split(".")[0] in allowed:
                scope = f"{module}:{frame.f_lineno}"
                if scope not in scopes:
                    scopes.append(scope)
            frame = frame.f_back
        del frame
    path.write_text(json.dumps(scopes), encoding="utf-8")


def _preload_cpu_analysis() -> None:
    from . import cpu_analysis as _cpu_analysis

    del _cpu_analysis


def _analysis_failure_kind(error: Exception, workspace: Path) -> str:
    module = type(error).__module__
    name = type(error).__name__
    detail = ""
    if isinstance(error, PermissionError):
        scope = _permission_failure_scope(error, workspace)
        error_number = error.errno if isinstance(error.errno, int) else 0
        windows_error = getattr(error, "winerror", None)
        windows_number = windows_error if isinstance(windows_error, int) else 0
        detail = f".{scope}.errno{error_number}.winerror{windows_number}"
    kind = f"{module}.{name}{detail}"
    return kind if re.fullmatch(r"[A-Za-z0-9_.]{1,160}", kind) else "unknown"


def _permission_failure_scope(error: PermissionError, workspace: Path) -> str:
    filename = error.filename
    if not isinstance(filename, (str, bytes, os.PathLike)):
        return "unknown"
    try:
        denied = Path(filename).absolute()
        workspace_root = workspace.absolute()
        if denied.is_relative_to(workspace_root):
            relative = denied.relative_to(workspace_root)
            top = relative.parts[0] if relative.parts else "root"
            return (
                f"workspace.{top}"
                if top in {"artifacts", "checkpoints", "input", "tmp"}
                else "workspace.other"
            )
        runtime_root = Path(sys.executable).absolute().parent
        if denied.is_relative_to(runtime_root):
            return "runtime"
    except (OSError, TypeError, ValueError):
        return "unknown"
    return "outside"


def _publish_analysis_result(
    workspace: Path, candidate: dict[str, object],
    *,
    workspace_is_current_directory: bool = False,
) -> ArtifactDescriptor:
    # The native launcher has already validated the Windows workspace. Reusing
    # its cwd avoids resolving inaccessible AppContainer profile ancestors.
    workspace_root = Path.cwd() if workspace_is_current_directory else workspace.resolve(strict=True)
    result_path = workspace_root / ANALYSIS_RESULT_PATH
    parent_metadata = result_path.parent.lstat()
    if (
        not stat.S_ISDIR(parent_metadata.st_mode)
        or getattr(parent_metadata, "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT
    ):
        # Reject symlinks and Windows reparse points (including junctions).
        raise ProtocolError("analysis result escaped its workspace")
    if (
        not workspace_is_current_directory
        and result_path.parent.resolve(strict=True) != workspace_root / "artifacts"
    ):
        raise ProtocolError("analysis result escaped its workspace")
    try:
        content = json.dumps(
            candidate,
            allow_nan=False,
            ensure_ascii=True,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
    except (TypeError, ValueError) as error:
        raise ProtocolError("analysis result is invalid") from error
    if not content or len(content) > MAX_ANALYSIS_RESULT_BYTES:
        raise ProtocolError("analysis result exceeds its bounded size")
    temporary = result_path.with_suffix(".json.partial")
    temporary.unlink(missing_ok=True)
    result_path.unlink(missing_ok=True)
    try:
        with temporary.open("xb") as output:
            output.write(content)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, result_path)
    except Exception:
        temporary.unlink(missing_ok=True)
        result_path.unlink(missing_ok=True)
        raise
    return ArtifactDescriptor(
        byte_size=len(content),
        path=ANALYSIS_RESULT_PATH.as_posix(),
        sha256=hashlib.sha256(content).hexdigest(),
    )

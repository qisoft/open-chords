"""Versioned stdin/stdout protocol for one frozen analysis session."""

from __future__ import annotations

import json
import re
import struct
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
    NativeToolchain,
    decode_canonical,
)

MAX_FRAME_BYTES: Final = 1024 * 1024
MAX_ID_BYTES: Final = 256
PROTOCOL_VERSION: Final = 1
HEARTBEAT_INTERVAL_SECONDS: Final = 5
SHA256_PATTERN: Final = re.compile(r"^[a-f0-9]{64}$")


class ProtocolError(RuntimeError):
    """A malformed or unsupported sidecar protocol message."""


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
) -> None:
    """Read one start frame, publish one result/error, and return."""

    start = _parse_start(_read_frame(stdin))
    _write_frame(
        stdout,
        {
            "capabilities": ["analysis", "canonical_decode"],
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
            artifact = decode_canonical(
                workspace,
                runtime.toolchain,
                CanonicalDecodeConfig(platform_profile=runtime.platform_profile),
                cancellation,
            )
        except CanonicalDecodeCancelled as error:
            events.put(("decode_cancelled", error))
        except CanonicalDecodeError as error:
            events.put(("decode_error", error))
        except Exception as error:
            events.put(("decode_error", error))
        else:
            events.put(("result", artifact))

    threading.Thread(target=read_control, daemon=True).start()
    decode_thread = threading.Thread(target=run_decode, daemon=True)
    decode_thread.start()
    sequence = 1
    cancel_received = False
    decode_finished = False
    while True:
        try:
            event, payload = events.get(timeout=HEARTBEAT_INTERVAL_SECONDS)
        except Empty:
            if not cancel_received and not decode_finished:
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
                _cleanup_decode_artifacts(workspace)
                _write_frame(stdout, {**_identity(start, sequence), "type": "cleanup_complete"})
                return
            continue
        if event == "result":
            decode_finished = True
            if cancel_received:
                _cleanup_decode_artifacts(workspace)
                _write_frame(stdout, {**_identity(start, sequence), "type": "cleanup_complete"})
                return
            if not isinstance(payload, ArtifactDescriptor):
                raise ProtocolError("canonical decode returned an invalid descriptor")
            _write_frame(
                stdout,
                {**_identity(start, sequence), "artifact": _descriptor_json(payload), "type": "result"},
            )
            return
        if event in {"decode_cancelled", "decode_error"}:
            decode_finished = True
            if cancel_received:
                _cleanup_decode_artifacts(workspace)
                _write_frame(stdout, {**_identity(start, sequence), "type": "cleanup_complete"})
                return
            if cancellation.is_set():
                continue
            _write_frame(
                stdout,
                {
                    **_identity(start, sequence),
                    "code": "canonical_decode_failed",
                    "message": "Canonical media decode failed",
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
    if message["type"] != "start" or message["sequence"] != 0:
        raise ProtocolError("invalid sidecar start semantics")
    identifiers = [message["jobId"], message["nonce"], message["requestId"]]
    if any(
        not isinstance(value, str) or not value or len(value.encode()) > MAX_ID_BYTES
        for value in identifiers
    ):
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
    if message["type"] != "cancel" or not isinstance(message["sequence"], int):
        raise ProtocolError("invalid sidecar cancel semantics")
    identifiers = [message["jobId"], message["nonce"], message["requestId"]]
    if any(
        not isinstance(value, str) or not value or len(value.encode()) > MAX_ID_BYTES
        for value in identifiers
    ):
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
        and cancel.sequence == sequence
    )


def _cleanup_decode_artifacts(workspace: Path) -> None:
    for relative in (
        "artifacts/canonical.wav.partial",
        "artifacts/canonical.wav",
        "artifacts/decode-manifest.json.partial",
        "artifacts/decode-manifest.json",
    ):
        candidate = (workspace / relative).resolve(strict=False)
        if candidate.is_relative_to(workspace.resolve(strict=True)):
            candidate.unlink(missing_ok=True)


def _descriptor_json(descriptor: ArtifactDescriptor) -> dict[str, int | str]:
    return {
        "byteSize": descriptor.byte_size,
        "path": descriptor.path,
        "sha256": descriptor.sha256,
    }

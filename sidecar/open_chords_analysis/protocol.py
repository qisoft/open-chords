"""Versioned stdin/stdout protocol for one frozen analysis session."""

from __future__ import annotations

import json
import re
import struct
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO, Final

from .canonical_decode import (
    ArtifactDescriptor,
    CanonicalDecodeConfig,
    CanonicalDecodeError,
    NativeToolchain,
    decode_canonical,
)

MAX_FRAME_BYTES: Final = 1024 * 1024
MAX_ID_BYTES: Final = 256
PROTOCOL_VERSION: Final = 1
SHA256_PATTERN: Final = re.compile(r"^[a-f0-9]{64}$")


class ProtocolError(RuntimeError):
    """A malformed or unsupported sidecar protocol message."""


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
    identity = {
        "jobId": start.job_id,
        "nonce": start.nonce,
        "requestId": start.request_id,
        "sequence": 1,
    }
    try:
        artifact = decode_canonical(
            workspace,
            runtime.toolchain,
            CanonicalDecodeConfig(platform_profile=runtime.platform_profile),
        )
    except CanonicalDecodeError:
        _write_frame(
            stdout,
            {
                **identity,
                "code": "canonical_decode_failed",
                "message": "Canonical media decode failed",
                "type": "error",
            },
        )
        return
    _write_frame(stdout, {**identity, "artifact": _descriptor_json(artifact), "type": "result"})


def _read_frame(stream: BinaryIO) -> object:
    header = stream.read(4)
    if len(header) != 4:
        raise ProtocolError("sidecar input ended before a complete frame header")
    length = struct.unpack(">I", header)[0]
    if length > MAX_FRAME_BYTES:
        raise ProtocolError("sidecar input frame exceeds one MiB")
    payload = stream.read(length)
    if len(payload) != length:
        raise ProtocolError("sidecar input ended before a complete frame")
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


def _descriptor_json(descriptor: ArtifactDescriptor) -> dict[str, int | str]:
    return {
        "byteSize": descriptor.byte_size,
        "path": descriptor.path,
        "sha256": descriptor.sha256,
    }

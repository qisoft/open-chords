"""PROTOTYPE: length-prefixed JSON IPC shared by broker and extractor worker."""

from __future__ import annotations

import json
import struct
from typing import BinaryIO, Any


MAX_FRAME_BYTES = 8 * 1024 * 1024


def write_frame(stream: BinaryIO, value: dict[str, Any]) -> None:
    payload = json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")
    if len(payload) > MAX_FRAME_BYTES:
        raise ValueError(f"frame exceeds {MAX_FRAME_BYTES} bytes")
    stream.write(struct.pack(">I", len(payload)))
    stream.write(payload)
    stream.flush()


def read_frame(stream: BinaryIO) -> dict[str, Any] | None:
    header = stream.read(4)
    if not header:
        return None
    if len(header) != 4:
        raise EOFError("truncated frame header")
    (length,) = struct.unpack(">I", header)
    if length > MAX_FRAME_BYTES:
        raise ValueError(f"frame exceeds {MAX_FRAME_BYTES} bytes")
    payload = stream.read(length)
    if len(payload) != length:
        raise EOFError("truncated frame payload")
    value = json.loads(payload)
    if not isinstance(value, dict):
        raise ValueError("frame must contain a JSON object")
    return value

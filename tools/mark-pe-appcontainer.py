#!/usr/bin/env python3
"""Set and verify IMAGE_DLLCHARACTERISTICS_APPCONTAINER on PE executables."""

from __future__ import annotations

import argparse
from pathlib import Path
import struct


APPCONTAINER = 0x1000
PE32_MAGIC = 0x10B
PE32_PLUS_MAGIC = 0x20B


def appcontainer_characteristics_offset(data: bytes) -> int:
    if len(data) < 0x40 or data[:2] != b"MZ":
        raise ValueError("invalid DOS header")
    pe_offset = struct.unpack_from("<I", data, 0x3C)[0]
    optional_offset = pe_offset + 24
    characteristics_offset = optional_offset + 0x46
    if characteristics_offset + 2 > len(data) or data[pe_offset : pe_offset + 4] != b"PE\0\0":
        raise ValueError("invalid PE header")
    magic = struct.unpack_from("<H", data, optional_offset)[0]
    if magic not in {PE32_MAGIC, PE32_PLUS_MAGIC}:
        raise ValueError("unsupported PE optional header")
    return characteristics_offset


def mark_appcontainer(path: Path) -> None:
    data = bytearray(path.read_bytes())
    offset = appcontainer_characteristics_offset(data)
    characteristics = struct.unpack_from("<H", data, offset)[0]
    struct.pack_into("<H", data, offset, characteristics | APPCONTAINER)
    path.write_bytes(data)
    if struct.unpack_from("<H", path.read_bytes(), offset)[0] & APPCONTAINER == 0:
        raise RuntimeError("AppContainer characteristic verification failed")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("paths", nargs="+", type=Path)
    arguments = parser.parse_args()
    for path in arguments.paths:
        mark_appcontainer(path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

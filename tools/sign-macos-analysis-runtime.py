#!/usr/bin/env python3
"""Ad-hoc sign the frozen macOS runtime before its manifest is hashed."""

from __future__ import annotations

import argparse
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MACH_O_MAGICS = {
    bytes.fromhex("cafebabe"),
    bytes.fromhex("cafebabf"),
    bytes.fromhex("cefaedfe"),
    bytes.fromhex("cffaedfe"),
    bytes.fromhex("feedface"),
    bytes.fromhex("feedfacf"),
}
SPAWNED_HELPERS = ("open-chords-analysis", "tools/ffmpeg", "tools/ffprobe")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--runtime-root", type=Path, required=True)
    arguments = parser.parse_args()
    runtime_root = arguments.runtime_root.resolve(strict=True)
    native_files = [
        path
        for path in runtime_root.rglob("*")
        if path.is_file() and not path.is_symlink() and is_mach_o(path)
    ]
    for path in sorted(native_files, key=lambda item: len(item.parts), reverse=True):
        subprocess.run(["codesign", "--force", "--sign", "-", str(path)], check=True)
    entitlements = ROOT / "native/macos/analysis-helper.entitlements.plist"
    for relative in SPAWNED_HELPERS:
        helper = runtime_root / relative
        if not helper.is_file() or not is_mach_o(helper):
            raise FileNotFoundError(f"Required Mach-O helper is missing: {relative}")
        subprocess.run(
            [
                "codesign",
                "--force",
                "--sign",
                "-",
                "--entitlements",
                str(entitlements),
                str(helper),
            ],
            check=True,
        )
        subprocess.run(["codesign", "--verify", "--strict", str(helper)], check=True)


def is_mach_o(path: Path) -> bool:
    with path.open("rb") as stream:
        return stream.read(4) in MACH_O_MAGICS


if __name__ == "__main__":
    main()

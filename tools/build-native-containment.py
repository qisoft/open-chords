#!/usr/bin/env python3
"""Build one platform-native analysis containment broker."""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-root", type=Path, required=True)
    arguments = parser.parse_args()
    output_root = arguments.output_root.resolve()
    if output_root.exists():
        shutil.rmtree(output_root)
    output_root.mkdir(parents=True)
    if sys.platform == "darwin":
        build_macos(output_root)
    elif sys.platform == "win32":
        build_windows(output_root)
    elif sys.platform.startswith("linux"):
        build_linux(output_root)
    else:
        raise RuntimeError(f"Unsupported containment platform: {sys.platform}")


def build_macos(output_root: Path) -> None:
    source_root = ROOT / "native/macos"
    bridge = output_root / "open-chords-containment-bridge"
    service = output_root / "OpenChordsAnalysisService.xpc"
    contents = service / "Contents"
    executable = contents / "MacOS/open-chords-analysis-service"
    executable.parent.mkdir(parents=True)
    shutil.copy2(source_root / "Info.plist", contents / "Info.plist")
    common = [
        "clang",
        "-fblocks",
        "-mmacosx-version-min=13.0",
        "-Wall",
        "-Wextra",
        "-Werror",
    ]
    subprocess.run(
        [*common, str(source_root / "containment-bridge.c"), "-o", str(bridge)],
        check=True,
    )
    subprocess.run(
        [
            *common,
            str(source_root / "analysis-service.c"),
            "-framework",
            "Security",
            "-framework",
            "CoreFoundation",
            "-o",
            str(executable),
        ],
        check=True,
    )
    subprocess.run(["codesign", "--force", "--sign", "-", str(bridge)], check=True)
    subprocess.run(
        [
            "codesign",
            "--force",
            "--sign",
            "-",
            "--entitlements",
            str(source_root / "analysis-service.entitlements.plist"),
            str(service),
        ],
        check=True,
    )
    subprocess.run(["codesign", "--verify", "--strict", str(bridge)], check=True)
    subprocess.run(["codesign", "--verify", "--strict", str(service)], check=True)
    files = [path for path in sorted(output_root.rglob("*")) if path.is_file()]
    (output_root / "containment-manifest.json").write_text(
        json.dumps(
            {
                "backend": "macos-xpc-app-sandbox",
                "files": [
                    {
                        "path": path.relative_to(output_root).as_posix(),
                        "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                    }
                    for path in files
                ],
                "version": 1,
            },
            indent=2,
            sort_keys=True,
        )
        + "\n",
        "utf-8",
    )


def build_windows(output_root: Path) -> None:
    executable = output_root / "open-chords-containment-launcher.exe"
    subprocess.run(
        [
            "g++",
            "-std=c++20",
            "-municode",
            "-D_WIN32_WINNT=0x0A00",
            "-O2",
            "-Wall",
            "-Wextra",
            "-Werror",
            "-static-libgcc",
            "-static-libstdc++",
            str(ROOT / "native/windows/containment-launcher.cpp"),
            "-o",
            str(executable),
            "-ladvapi32",
            "-lole32",
            "-luserenv",
        ],
        check=True,
    )
    write_single_file_manifest(output_root, "windows-appcontainer-job", executable)


def build_linux(output_root: Path) -> None:
    executable = output_root / "open-chords-containment-launcher"
    subprocess.run(
        [
            "cc",
            "-std=c17",
            "-O2",
            "-Wall",
            "-Wextra",
            "-Werror",
            str(ROOT / "native/linux/containment-launcher.c"),
            "-o",
            str(executable),
        ],
        check=True,
    )
    write_single_file_manifest(output_root, "linux-landlock-seccomp", executable)


def write_single_file_manifest(output_root: Path, backend: str, executable: Path) -> None:
    (output_root / "containment-manifest.json").write_text(
        json.dumps(
            {
                "backend": backend,
                "files": [
                    {
                        "path": executable.name,
                        "sha256": hashlib.sha256(executable.read_bytes()).hexdigest(),
                    }
                ],
                "version": 1,
            },
            indent=2,
            sort_keys=True,
        )
        + "\n",
        "utf-8",
    )


if __name__ == "__main__":
    main()

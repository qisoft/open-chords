#!/usr/bin/env python3
"""Assemble the complete PyInstaller one-folder analysis runtime."""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import os
import posixpath
import shutil
import subprocess
import sys
import sysconfig
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from sidecar.open_chords_analysis.runtime_manifest import load_frozen_runtime, write_runtime_manifest


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--build-id", required=True)
    parser.add_argument("--native-root", type=Path, required=True)
    parser.add_argument("--output-root", type=Path, required=True)
    parser.add_argument("--platform-profile", required=True)
    arguments = parser.parse_args()

    executable_suffix = ".exe" if os.name == "nt" else ""
    ffmpeg_build = json.loads(
        (ROOT / "sidecar/native/ffmpeg-build.json").read_text("utf-8")
    )
    native_root = arguments.native_root.resolve(strict=True)
    output_root = arguments.output_root.resolve()
    runtime_root = output_root / "open-chords-analysis"
    with tempfile.TemporaryDirectory(prefix="open-chords-pyinstaller-") as temporary:
        temporary_root = Path(temporary)
        subprocess.run(
            [
                sys.executable,
                "-m",
                "PyInstaller",
                "--clean",
                "--noconfirm",
                "--onedir",
                "--name",
                "open-chords-analysis",
                "--distpath",
                str(temporary_root / "dist"),
                "--workpath",
                str(temporary_root / "work"),
                "--specpath",
                str(temporary_root / "spec"),
                "--paths",
                str(ROOT),
                str(ROOT / "sidecar/open_chords_analysis/frozen_entry.py"),
            ],
            check=True,
            cwd=ROOT,
            env={
                **os.environ,
                "PYINSTALLER_CONFIG_DIR": str(temporary_root / "config"),
                "PYTHONHASHSEED": "0",
            },
        )
        assembled = temporary_root / "dist/open-chords-analysis"
        tools = assembled / "tools"
        licenses = assembled / "licenses"
        tools.mkdir()
        licenses.mkdir()
        for name in ("ffmpeg", "ffprobe"):
            source = native_root / "bin" / f"{name}{executable_suffix}"
            shutil.copy2(source, tools / source.name)
        if os.name == "nt":
            for name in ffmpeg_build["windowsRuntimeDlls"]:
                if Path(name).name != name or not name.lower().endswith(".dll"):
                    raise ValueError("invalid reviewed Windows runtime DLL name")
                shutil.copy2(native_root / "bin" / name, tools / name)
            shutil.copy2(
                native_root / "licenses/Winpthreads-Licenses.txt",
                licenses / "Winpthreads-Licenses.txt",
            )
            shutil.copy2(
                native_root / "windows-runtime.json",
                assembled / "windows-runtime.json",
            )
        shutil.copy2(
            native_root / "licenses/FFmpeg-LGPL-2.1.txt",
            licenses / "FFmpeg-LGPL-2.1.txt",
        )
        shutil.copy2(_python_license(), licenses / "CPython-PSF-2.0.txt")
        shutil.copy2(ROOT / "LICENSE", licenses / "Open-Chords-AGPL-3.0.txt")
        pyinstaller_distribution = importlib.metadata.distribution("pyinstaller")
        pyinstaller_license = _pyinstaller_license(pyinstaller_distribution)
        shutil.copy2(
            pyinstaller_distribution.locate_file(pyinstaller_license),
            licenses / "PyInstaller-COPYING.txt",
        )
        shutil.copy2(
            ROOT / "sidecar/native/ffmpeg-build.json",
            assembled / "ffmpeg-build.json",
        )
        shutil.copy2(
            ROOT / "sidecar/native/third-party-native-notices.json",
            licenses / "Third-Party-Native-Notices.json",
        )
        shutil.copy2(
            ROOT / "sidecar/native/THIRD-PARTY-NATIVE-LICENSES.txt",
            licenses / "Third-Party-Native-Licenses.txt",
        )
        inventory = json.loads(
            (ROOT / "sidecar/native/native-dependencies.json").read_text("utf-8")
        )
        native_files = _native_files(assembled)
        _validate_native_closure(assembled, native_files, ffmpeg_build)
        present_components = {entry["component"] for entry in native_files} | {"pyinstaller"}
        inventory["dependencies"] = [
            {**dependency, "present": dependency["component"] in present_components}
            for dependency in _dependencies_for_profile(
                inventory["dependencies"], arguments.platform_profile
            )
        ]
        inventory["nativeFiles"] = native_files
        inventory["observed"] = {
            "python": sys.version.split()[0],
            "pyinstaller": _tool_version([sys.executable, "-m", "PyInstaller", "--version"]),
            "ffmpeg": _tool_version([str(tools / f"ffmpeg{executable_suffix}"), "-version"]),
        }
        (assembled / "native-dependencies.json").write_text(
            json.dumps(inventory, ensure_ascii=True, indent=2, sort_keys=True) + "\n",
            "utf-8",
        )
        write_runtime_manifest(
            assembled,
            build_id=arguments.build_id,
            platform_profile=arguments.platform_profile,
        )
        if runtime_root.exists():
            shutil.rmtree(runtime_root)
        output_root.mkdir(parents=True, exist_ok=True)
        shutil.move(assembled, runtime_root)
        load_frozen_runtime(runtime_root)


def _tool_version(command: list[str]) -> str:
    result = subprocess.run(
        command,
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
    )
    return result.stdout.splitlines()[0][:512]


def _python_license() -> Path:
    return _find_python_license(
        Path(sys.executable).resolve(),
        Path(sysconfig.get_path("stdlib")),
    )


def _pyinstaller_license(distribution: importlib.metadata.Distribution) -> Path:
    license_file = next(
        (
            file
            for file in distribution.files or []
            if file.name == "COPYING.txt" and "licenses" in file.parts
        ),
        None,
    )
    if license_file is None:
        raise FileNotFoundError("PyInstaller COPYING.txt was not found in distribution metadata")
    return license_file


def _find_python_license(executable: Path, stdlib: Path) -> Path:
    stdlib_license = stdlib / "LICENSE.txt"
    if stdlib_license.is_file():
        return stdlib_license
    for parent in executable.parents:
        for name in ("LICENSE", "LICENSE.txt"):
            candidate = parent / name
            if candidate.is_file():
                return candidate
    raise FileNotFoundError("CPython LICENSE was not found beside the exact build interpreter")


def _native_files(runtime_root: Path) -> list[dict[str, str]]:
    entries: list[dict[str, str]] = []
    for path in sorted(runtime_root.rglob("*")):
        if path.is_symlink() or not path.is_file():
            continue
        relative = path.relative_to(runtime_root).as_posix()
        binary_format = _native_format(path)
        component = _native_component(relative, binary_format)
        if component is None:
            continue
        entries.append(
            {
                "component": component,
                "format": binary_format or "native-extension",
                "path": relative,
                "sha256": _sha256(path),
            }
        )
    return entries


def _native_component(relative: str, binary_format: str | None) -> str | None:
    lower = relative.lower()
    name = Path(lower).name
    if lower in {"open-chords-analysis", "open-chords-analysis.exe"}:
        return "open-chords-sidecar"
    if lower in {"tools/ffmpeg", "tools/ffmpeg.exe", "tools/ffprobe", "tools/ffprobe.exe"}:
        return "ffmpeg"
    if lower == "tools/libwinpthread-1.dll" and binary_format == "pe":
        return "winpthreads"
    if "libssl" in name or "libcrypto" in name:
        return "openssl"
    if "liblzma" in name:
        return "xz"
    if "libzstd" in name:
        return "zstd"
    if "libmpdec" in name:
        return "mpdecimal"
    if "libffi" in name:
        return "libffi"
    if "libbz2" in name or name == "bz2.dll":
        return "bzip2"
    if name in {"zlib.dll", "zlib1.dll"}:
        return "zlib"
    if "expat" in name and name.endswith((".dll", ".dylib")):
        return "expat"
    if (
        binary_format == "pe"
        and name.endswith(".dll")
        and name.startswith(("vcruntime", "msvcp", "ucrtbase", "api-ms-win-"))
    ):
        return "msvc-runtime"
    if (
        lower.startswith("_internal/python.framework/versions/")
        and name == "python"
    ):
        return "cpython"
    if lower.startswith("_internal/") and (
        name == "python"
        or (name.startswith("python3") and name.endswith(".dll"))
        or name.endswith((".so", ".pyd"))
    ):
        return "cpython"
    if binary_format is not None or name.endswith((".dll", ".dylib", ".exe", ".pyd", ".so")):
        raise RuntimeError(f"Unclassified native runtime file: {relative}")
    return None


def _validate_native_closure(
    runtime_root: Path,
    native_files: list[dict[str, str]],
    ffmpeg_build: dict[str, object],
) -> None:
    packaged_native_paths = _packaged_native_paths(runtime_root, native_files)
    if sys.platform == "darwin":
        for entry in native_files:
            if entry["format"] != "mach-o":
                continue
            owner = runtime_root / entry["path"]
            identity, dependencies, rpaths = _macho_load_commands(owner)
            for dependency in dependencies:
                if dependency != identity:
                    _validate_macho_dependency(
                        runtime_root,
                        owner,
                        dependency,
                        rpaths,
                        packaged_native_paths,
                    )
        return
    if os.name == "nt":
        packaged_native_paths = {path.lower() for path in packaged_native_paths}
        allowed_system = {
            str(name).lower()
            for name in ffmpeg_build["windowsFrozenRuntimeSystemDlls"]
        }
        inspector = shutil.which("objdump") or "C:/msys64/ucrt64/bin/objdump.exe"
        if not Path(inspector).is_file():
            raise FileNotFoundError("objdump was not found for frozen PE closure validation")
        for entry in native_files:
            if entry["format"] != "pe":
                continue
            dependencies = _pe_dependencies(runtime_root / entry["path"], inspector)
            _validate_pe_dependencies(
                entry["path"], dependencies, packaged_native_paths, allowed_system
            )
        return
    raise RuntimeError("frozen native closure validation has no declared platform profile")


def _packaged_native_paths(
    runtime_root: Path,
    native_files: list[dict[str, str]],
) -> set[str]:
    runtime_root = runtime_root.resolve(strict=True)
    native_paths = {entry["path"] for entry in native_files}
    for path in runtime_root.rglob("*"):
        if not path.is_symlink():
            continue
        resolved = path.resolve(strict=True)
        if not resolved.is_relative_to(runtime_root):
            continue
        resolved_relative = resolved.relative_to(runtime_root).as_posix()
        if resolved_relative in native_paths:
            native_paths.add(path.relative_to(runtime_root).as_posix())
    return native_paths


def _macho_load_commands(path: Path) -> tuple[str | None, list[str], list[str]]:
    dependencies_result = subprocess.run(
        ["otool", "-L", str(path)],
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    identity_result = subprocess.run(
        ["otool", "-D", str(path)],
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    commands_result = subprocess.run(
        ["otool", "-l", str(path)],
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    dependencies = [
        line.strip().split(" (", 1)[0]
        for line in dependencies_result.stdout.splitlines()[1:]
        if line.strip()
    ]
    identity_lines = identity_result.stdout.splitlines()[1:]
    identity = identity_lines[0].strip() if identity_lines else None
    command_lines = commands_result.stdout.splitlines()
    rpaths = [
        command_lines[index + 2].strip().split(" (offset", 1)[0].removeprefix("path ")
        for index, line in enumerate(command_lines[:-2])
        if line.strip() == "cmd LC_RPATH"
    ]
    return identity, dependencies, rpaths


def _validate_macho_dependency(
    runtime_root: Path,
    owner: Path,
    dependency: str,
    rpaths: list[str],
    packaged_paths: set[str],
) -> None:
    if dependency.startswith("/"):
        normalized = posixpath.normpath(dependency)
        if any(
            normalized.startswith(f"{root}/")
            for root in ("/System/Library", "/usr/lib")
        ):
            return
        raise RuntimeError(f"Unreviewed Mach-O dependency for {owner.name}: {dependency}")
    if dependency.startswith("@rpath/"):
        suffix = dependency.removeprefix("@rpath/")
        matches = {
            relative
            for rpath in rpaths
            if (relative := _packaged_macho_candidate(runtime_root, owner, rpath, suffix))
            in packaged_paths
        }
        if len(matches) == 1:
            return
        raise RuntimeError(f"Unresolvable Mach-O dependency for {owner.name}: {dependency}")
    relative_prefixes = {
        "@loader_path/": owner.parent,
        "@executable_path/": runtime_root,
    }
    for prefix, base in relative_prefixes.items():
        if dependency.startswith(prefix):
            candidate = (base / dependency.removeprefix(prefix)).resolve(strict=True)
            relative = candidate.relative_to(runtime_root.resolve(strict=True)).as_posix()
            if relative in packaged_paths:
                return
            break
    raise RuntimeError(f"Unreviewed Mach-O dependency for {owner.name}: {dependency}")


def _packaged_macho_candidate(
    runtime_root: Path,
    owner: Path,
    rpath: str,
    dependency_suffix: str,
) -> str:
    base: Path | None = None
    for token, token_root in (
        ("@loader_path", owner.parent),
        ("@executable_path", runtime_root),
    ):
        if rpath == token:
            base = token_root
            break
        if rpath.startswith(f"{token}/"):
            base = token_root / rpath.removeprefix(f"{token}/")
            break
    if base is None:
        return ""
    candidate = (base / dependency_suffix).resolve(strict=False)
    root = runtime_root.resolve(strict=True)
    if not candidate.is_relative_to(root):
        return ""
    return candidate.relative_to(root).as_posix()


def _pe_dependencies(path: Path, inspector: str) -> list[str]:
    result = subprocess.run(
        [inspector, "-p", str(path)],
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    prefix = "DLL Name:"
    return [line.split(prefix, 1)[1].strip() for line in result.stdout.splitlines() if prefix in line]


def _validate_pe_dependencies(
    owner: str,
    dependencies: list[str],
    packaged_paths: set[str],
    allowed_system: set[str],
) -> None:
    owner_path = Path(owner)
    loader_roots = (
        {owner_path.parent.as_posix()}
        if owner_path.parts[0].lower() == "tools"
        else {"", "_internal", owner_path.parent.as_posix()}
    )
    for dependency in dependencies:
        dependency_lower = dependency.lower()
        if dependency_lower in allowed_system:
            continue
        matches = {
            (Path(root) / dependency).as_posix().removeprefix("./").lower()
            for root in loader_roots
            if (Path(root) / dependency).as_posix().removeprefix("./").lower()
            in packaged_paths
        }
        if len(matches) != 1:
            raise RuntimeError(f"Unpackaged PE dependency for {owner}: {dependency}")


def _dependencies_for_profile(
    dependencies: list[dict[str, object]], platform_profile: str
) -> list[dict[str, object]]:
    return [
        dependency
        for dependency in dependencies
        if "platformProfiles" not in dependency
        or platform_profile in dependency["platformProfiles"]
    ]


def _native_format(path: Path) -> str | None:
    with path.open("rb") as file:
        magic = file.read(4)
    if magic[:2] == b"MZ":
        return "pe"
    if magic == b"\x7fELF":
        return "elf"
    if magic in {
        b"\xfe\xed\xfa\xce",
        b"\xce\xfa\xed\xfe",
        b"\xfe\xed\xfa\xcf",
        b"\xcf\xfa\xed\xfe",
        b"\xca\xfe\xba\xbe",
        b"\xbe\xba\xfe\xca",
        b"\xca\xfe\xba\xbf",
        b"\xbf\xba\xfe\xca",
    }:
        return "mach-o"
    return None


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as file:
        while chunk := file.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


if __name__ == "__main__":
    main()

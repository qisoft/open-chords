#!/usr/bin/env python3
"""Build the release-owned MFA runtime from exact, hash-locked native packages."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def sha(path: Path) -> str:
    with path.open("rb") as file:
        return hashlib.file_digest(file, "sha256").hexdigest()


def run(arguments: list[str], *, env: dict[str, str], timeout: int = 1200) -> None:
    subprocess.run(arguments, env=env, check=True, timeout=timeout)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-root", type=Path, required=True)
    parser.add_argument("--build-root", type=Path, required=True)
    parser.add_argument("--environment", type=Path)
    args = parser.parse_args()
    target = "win-64" if os.name == "nt" else "osx-arm64"
    if target == "osx-arm64" and (platform.system() != "Darwin" or platform.machine() != "arm64"):
        raise SystemExit("Unsupported alignment runtime build target")
    lock_path = ROOT / "sidecar/alignment" / f"{target}.json"
    lock = json.loads(lock_path.read_text("utf8"))
    build = args.build_root.resolve()
    build.mkdir(parents=True, exist_ok=True)
    output = args.output_root.resolve()
    output.mkdir(parents=True, exist_ok=True)
    environment = args.environment.resolve() if args.environment else build / "environment"
    build_env = dict(os.environ)
    for key in ["PYTHONHOME", "PYTHONPATH"]:
        build_env.pop(key, None)
    if args.environment is None:
        archive = build / "micromamba.tar.bz2"
        if not archive.exists() or sha(archive) != lock["micromamba"]["sha256"]:
            with urllib.request.urlopen(lock["micromamba"]["url"], timeout=90) as response, archive.open("wb") as file:
                shutil.copyfileobj(response, file)
        if sha(archive) != lock["micromamba"]["sha256"]:
            raise RuntimeError("Micromamba checksum mismatch")
        name = "Library/bin/micromamba.exe" if os.name == "nt" else "bin/micromamba"
        executable = build / ("micromamba.exe" if os.name == "nt" else "micromamba")
        with tarfile.open(archive) as package:
            member = package.getmember(name)
            if not member.isfile():
                raise RuntimeError("Invalid builder executable")
            with package.extractfile(member) as source, executable.open("wb") as destination:
                shutil.copyfileobj(source, destination)
        executable.chmod(0o700)
        explicit = build / "runtime.explicit"
        explicit.write_text("@EXPLICIT\n" + "\n".join(p["url"] + "#" + p["sha256"] for p in lock["packages"]) + "\n", "utf8")
        run([str(executable), "create", "--no-rc", "--yes", "--root-prefix", str(build / "mamba"), "--prefix", str(environment), "--file", str(explicit)], env=build_env)
    records = [json.loads(path.read_text("utf8")) for path in (environment / "conda-meta").glob("*.json")]
    by_name = {record["name"]: record for record in records}
    for package in lock["packages"]:
        record = by_name.get(package["name"], {})
        cached_archive = Path(record.get("link", {}).get("source", "")).parent / urllib.parse.unquote(package["url"].rsplit("/", 1)[-1])
        verified_hash = record.get("sha256")
        if verified_hash is None and cached_archive.is_file():
            verified_hash = sha(cached_archive)
        if record.get("version") != package["version"] or verified_hash != package["sha256"]:
            raise RuntimeError("Native build environment does not match the release lock")
    python = environment / ("python.exe" if os.name == "nt" else "bin/python")
    search = [environment, environment / "Library/bin", environment / "Scripts"] if os.name == "nt" else [environment / "bin"]
    build_env["PATH"] = os.pathsep.join([str(path) for path in search] + [build_env.get("PATH", "")])
    build_env["CONDA_PREFIX"] = str(environment)
    build_env["MFA_ROOT_DIR"] = str(build / "mfa")
    run([str(python), "-m", "pip", "install", "--disable-pip-version-check", "--require-hashes", "--no-deps", "--only-binary=:all:", "-r", str(ROOT / "sidecar/alignment/requirements-builder.txt")], env=build_env)
    run([str(python), "-m", "PyInstaller", "--noconfirm", "--clean", "--onedir", "--name", "open-chords-alignment", "--copy-metadata", "montreal_forced_aligner", "--copy-metadata", "kalpy-kaldi", "--collect-all", "montreal_forced_aligner", "--collect-all", "kalpy", "--collect-all", "pynini", "--distpath", str(output), "--workpath", str(build / "freeze"), "--specpath", str(build), str(ROOT / "sidecar/alignment/entry.py")], env=build_env)
    runtime = output / "open-chords-alignment"
    # Materialize aliases so artifact verification never follows a runtime symlink.
    for path in list(runtime.rglob("*")):
        if path.is_symlink():
            target_path = path.resolve(strict=True)
            target_path.relative_to(runtime)
            if not target_path.is_file():
                raise RuntimeError("Unsupported runtime alias")
            content = target_path.read_bytes()
            mode = target_path.stat().st_mode
            path.unlink()
            path.write_bytes(content)
            path.chmod(mode)
    notices = runtime / "notices"
    notices.mkdir()
    for record in records:
        cache = Path(record.get("link", {}).get("source", ""))
        license_root = cache / "info/licenses"
        if license_root.is_dir():
            shutil.copytree(license_root, notices / f'{record["name"]}-{record["version"]}')
    (notices / "native-package-lock.json").write_text(json.dumps(lock, indent=2) + "\n", "utf8")
    (notices / "freezer-requirements.txt").write_text((ROOT / "sidecar/alignment/requirements-builder.txt").read_text("utf8"), "utf8")
    if os.name != "nt":
        run([sys.executable, str(ROOT / "tools/sign-macos-analysis-runtime.py"), "--runtime-root", str(runtime), "--helper", "open-chords-alignment"], env=build_env)
    # The probe is release-owned and imports the actual alignment/native interfaces.
    executable = runtime / ("open-chords-alignment.exe" if os.name == "nt" else "open-chords-alignment")
    with tempfile.TemporaryDirectory(prefix="open-chords-mfa-proof-") as temporary:
        clean_env = {"HOME": temporary, "USERPROFILE": temporary, "MFA_ROOT_DIR": temporary, "TEMP": temporary, "TMP": temporary, "APPDATA": temporary, "LOCALAPPDATA": temporary}
        if os.name == "nt":
            clean_env["SystemRoot"] = os.environ["SystemRoot"]
            clean_env["PATH"] = str(Path(os.environ["SystemRoot"]) / "System32")
        else:
            clean_env["PATH"] = "/usr/bin:/bin"
        result = subprocess.run([str(executable), "--probe"], env=clean_env, capture_output=True, text=True, check=True, timeout=180)
        proof = json.loads(result.stdout)
        if proof != {"runtime": "mfa", "version": "3.4.1", "kalpy": "KalpyAligner", "fst": 0}:
            raise RuntimeError("Alignment runtime proof failed")
    files = [{"path": path.relative_to(runtime).as_posix(), "bytes": path.stat().st_size, "sha256": sha(path)} for path in sorted(runtime.rglob("*")) if path.is_file()]
    archive = output / "alignment-runtime-payload.zip"
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as compressed:
        for file in files:
            compressed.write(runtime / file["path"], file["path"])
    info = {"id": "mfa-3.4.1", "available": True, "placement": "bundled", "installedBytes": sum(file["bytes"] for file in files), "transferBytes": archive.stat().st_size}
    manifest = {"info": info, "platform": "win32-x64" if os.name == "nt" else "darwin-arm64", "files": files}
    (runtime / "runtime-info.json").write_text(json.dumps(manifest, indent=2) + "\n", "utf8")
    (output / "measurement.json").write_text(json.dumps({"info": info, "payloadSha256": sha(archive), "lockSha256": sha(lock_path), "probe": proof}, indent=2) + "\n", "utf8")
    print(json.dumps(info))


if __name__ == "__main__":
    main()

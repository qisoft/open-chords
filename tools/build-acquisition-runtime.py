#!/usr/bin/env python3
"""Build the pinned credential-free Extractor Worker and local Deno/EJS runtime."""
from __future__ import annotations

import argparse
import hashlib
from importlib.metadata import version
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import tempfile
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def sha(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-root", type=Path, required=True)
    parser.add_argument("--deno-archive", type=Path)
    args = parser.parse_args()
    profile = "win32-x64" if sys.platform == "win32" and platform.machine().lower() in ("amd64", "x86_64") else "darwin-arm64" if sys.platform == "darwin" and platform.machine() == "arm64" else None
    if not profile:
        raise RuntimeError("Unsupported acquisition runtime platform")
    components = json.loads((ROOT / "sidecar/acquisition/components.json").read_text("utf8"))
    for distribution, component in (("yt-dlp", "ytDlp"), ("yt-dlp-ejs", "ejs")):
        if version(distribution) != components[component]["version"]:
            raise RuntimeError("Extractor component version mismatch")
    output = args.output_root.resolve()
    output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="open-chords-extractor-build-") as temporary:
        build = Path(temporary)
        subprocess.run([sys.executable, "-m", "PyInstaller", "--clean", "--noconfirm", "--onedir", "--name", "open-chords-acquisition", "--collect-all", "yt_dlp", "--collect-all", "yt_dlp_ejs", "--copy-metadata", "yt-dlp", "--copy-metadata", "yt-dlp-ejs", "--distpath", str(build / "dist"), "--workpath", str(build / "work"), "--specpath", str(build), str(ROOT / "sidecar/acquisition/entry.py")], check=True)
        assembled = (build / "dist/open-chords-acquisition").resolve(strict=True)
        runtime = output / "open-chords-acquisition"
        if runtime.exists():
            shutil.rmtree(runtime)
        # Dereference only aliases wholly contained in this newly built tree.
        aliases = [(path, path.resolve(strict=True)) for path in assembled.rglob("*") if path.is_symlink()]
        for path, target in aliases:
            target.relative_to(assembled)
        for path, target in aliases:
            # As in the analysis runtime, keep the loader's Python alias as a real
            # file and drop framework aliases that make codesign see two bundles.
            if "Python.framework" in path.parts:
                path.unlink()
            elif path == assembled / "_internal/Python":
                content, mode = target.read_bytes(), target.stat().st_mode
                path.unlink()
                path.write_bytes(content)
                path.chmod(mode)
        shutil.copytree(assembled, runtime, symlinks=False)
        for private_install_record in runtime.glob("_internal/*.dist-info/direct_url.json"):
            private_install_record.unlink()
        suffix = ".exe" if sys.platform == "win32" else ""
        shutil.copy2(runtime / f"open-chords-acquisition{suffix}", runtime / f"open-chords-extractor-worker{suffix}")
        archive_info = components["deno"]["archives"][profile]
        archive = args.deno_archive or build / archive_info["name"]
        if args.deno_archive is None:
            url = f'https://github.com/denoland/deno/releases/download/v{components["deno"]["version"]}/{archive_info["name"]}'
            with urllib.request.urlopen(url, timeout=60) as response, archive.open("wb") as target:
                shutil.copyfileobj(response, target, length=1024 * 1024)
        if sha(archive) != archive_info["sha256"]:
            raise RuntimeError("Deno archive checksum mismatch")
        with zipfile.ZipFile(archive) as compressed:
            entry = compressed.getinfo(f"deno{suffix}")
            if entry.file_size > 256 * 1024 * 1024:
                raise RuntimeError("Deno binary exceeds archive limit")
            with compressed.open(entry) as source, (runtime / f"deno{suffix}").open("wb") as target:
                shutil.copyfileobj(source, target)
        (runtime / f"deno{suffix}").chmod(0o755)
        notices = runtime / "notices"
        notices.mkdir()
        shutil.copy2(ROOT / "sidecar/acquisition/components.json", notices)
        shutil.copy2(ROOT / "sidecar/acquisition/requirements.txt", notices)
        # Wheel distribution metadata includes the extractor and EJS license texts.
        # Deno's MIT notice is pinned with its release source below.
        shutil.copy2(ROOT / "sidecar/acquisition/DENO-LICENSE.txt", notices)
        if sys.platform == "darwin":
            subprocess.run([sys.executable, str(ROOT / "tools/sign-macos-analysis-runtime.py"), "--runtime-root", str(runtime), "--helper", "open-chords-extractor-worker", "--helper", "deno"], check=True)
        else:
            subprocess.run([sys.executable, str(ROOT / "tools/mark-pe-appcontainer.py"), str(runtime / "open-chords-extractor-worker.exe"), str(runtime / "deno.exe")], check=True)
        files = [{"path": path.relative_to(runtime).as_posix(), "bytes": path.stat().st_size, "sha256": sha(path)} for path in sorted(runtime.rglob("*")) if path.is_file()]
        manifest = {"version": 1, "platform": profile, "components": components, "files": files}
        (runtime / "runtime-info.json").write_text(json.dumps(manifest, indent=2) + "\n", "utf8")
        print(json.dumps({"files": len(files), "bytes": sum(item["bytes"] for item in files), "manifestSha256": sha(runtime / "runtime-info.json")}))


if __name__ == "__main__":
    main()

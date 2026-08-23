"""Content manifest for the complete frozen one-folder sidecar."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from typing import Final

from .canonical_decode import NativeToolchain
from .protocol import FrozenRuntime

MANIFEST_NAME: Final = "runtime-manifest.json"
MAX_MANIFEST_BYTES: Final = 4 * 1024 * 1024


class RuntimeManifestError(RuntimeError):
    """The frozen runtime does not match its immutable manifest."""


def write_runtime_manifest(
    runtime_root: Path,
    *,
    build_id: str,
    platform_profile: str,
) -> str:
    """Write the final manifest after every runtime file is assembled."""

    runtime_root = runtime_root.resolve(strict=True)
    manifest_path = runtime_root / MANIFEST_NAME
    manifest_path.unlink(missing_ok=True)
    files: list[dict[str, int | str]] = []
    for path in sorted(runtime_root.rglob("*"), key=lambda item: item.relative_to(runtime_root).as_posix()):
        relative = path.relative_to(runtime_root).as_posix()
        if path.is_symlink():
            target = os.readlink(path)
            if not path.resolve(strict=True).is_relative_to(runtime_root):
                raise RuntimeManifestError("frozen runtime symbolic link escaped its package")
            files.append({"path": relative, "target": target, "type": "symlink"})
            continue
        if not path.is_file():
            continue
        files.append(
            {
                "byteSize": path.stat().st_size,
                "path": relative,
                "sha256": _sha256_file(path),
                "type": "file",
            }
        )
    manifest = {
        "buildId": build_id,
        "files": files,
        "platformProfile": platform_profile,
        "schemaVersion": 1,
    }
    content = _canonical_json(manifest)
    if len(content) > MAX_MANIFEST_BYTES:
        raise RuntimeManifestError("frozen runtime manifest exceeds four MiB")
    _write_atomic(manifest_path, content)
    return hashlib.sha256(content).hexdigest()


def load_frozen_runtime(runtime_root: Path) -> FrozenRuntime:
    """Verify the complete runtime before exposing its protocol handshake."""

    runtime_root = runtime_root.resolve(strict=True)
    manifest_path = runtime_root / MANIFEST_NAME
    content = manifest_path.read_bytes()
    if len(content) > MAX_MANIFEST_BYTES:
        raise RuntimeManifestError("frozen runtime manifest exceeds four MiB")
    try:
        manifest = json.loads(content)
    except (json.JSONDecodeError, UnicodeDecodeError) as error:
        raise RuntimeManifestError("frozen runtime manifest is invalid JSON") from error
    if not isinstance(manifest, dict) or set(manifest) != {
        "buildId",
        "files",
        "platformProfile",
        "schemaVersion",
    }:
        raise RuntimeManifestError("frozen runtime manifest has an invalid envelope")
    if manifest["schemaVersion"] != 1:
        raise RuntimeManifestError("frozen runtime manifest version is unsupported")
    if not isinstance(manifest["buildId"], str) or not manifest["buildId"]:
        raise RuntimeManifestError("frozen runtime build identity is invalid")
    platform_profile = manifest["platformProfile"]
    if not isinstance(platform_profile, str) or not platform_profile:
        raise RuntimeManifestError("frozen runtime platform profile is invalid")
    files = manifest["files"]
    if not isinstance(files, list) or not files:
        raise RuntimeManifestError("frozen runtime file inventory is empty")
    expected_paths: set[str] = set()
    for entry in files:
        if not isinstance(entry, dict) or entry.get("type") not in {"file", "symlink"}:
            raise RuntimeManifestError("frozen runtime file entry is invalid")
        relative = entry.get("path")
        relative_path = Path(relative) if isinstance(relative, str) else Path()
        if (
            not isinstance(relative, str)
            or not relative
            or relative_path.is_absolute()
            or ".." in relative_path.parts
            or relative in expected_paths
        ):
            raise RuntimeManifestError("frozen runtime file path is invalid")
        candidate = runtime_root / relative_path
        if entry["type"] == "symlink":
            if set(entry) != {"path", "target", "type"} or not candidate.is_symlink():
                raise RuntimeManifestError("frozen runtime symbolic link is invalid")
            if os.readlink(candidate) != entry["target"] or not candidate.resolve(strict=True).is_relative_to(runtime_root):
                raise RuntimeManifestError("frozen runtime symbolic link escaped its package")
            expected_paths.add(relative)
            continue
        if set(entry) != {"byteSize", "path", "sha256", "type"}:
            raise RuntimeManifestError("frozen runtime file entry is invalid")
        resolved = candidate.resolve(strict=True)
        if not resolved.is_relative_to(runtime_root) or not candidate.is_file() or candidate.is_symlink():
            raise RuntimeManifestError("frozen runtime file escaped its package")
        if candidate.stat().st_size != entry["byteSize"] or _sha256_file(candidate) != entry["sha256"]:
            raise RuntimeManifestError(f"frozen runtime hash mismatch for {relative}")
        expected_paths.add(relative)
    actual_paths = {
        path.relative_to(runtime_root).as_posix()
        for path in runtime_root.rglob("*")
        if (path.is_file() or path.is_symlink()) and path.name != MANIFEST_NAME
    }
    if actual_paths != expected_paths:
        raise RuntimeManifestError("frozen runtime contains an unmanifested file")
    executable_suffix = ".exe" if os.name == "nt" else ""
    tools = runtime_root / "tools"
    return FrozenRuntime(
        manifest_hash=hashlib.sha256(content).hexdigest(),
        platform_profile=platform_profile,
        toolchain=NativeToolchain(
            ffmpeg=tools / f"ffmpeg{executable_suffix}",
            ffprobe=tools / f"ffprobe{executable_suffix}",
        ),
    )


def _canonical_json(value: object) -> bytes:
    return (json.dumps(value, ensure_ascii=True, separators=(",", ":"), sort_keys=True) + "\n").encode()


def _write_atomic(path: Path, content: bytes) -> None:
    temporary = path.with_suffix(".json.partial")
    temporary.write_bytes(content)
    os.replace(temporary, path)


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as file:
        while chunk := file.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()

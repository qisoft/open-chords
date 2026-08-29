"""Content manifest for the complete frozen one-folder sidecar."""

from __future__ import annotations

import hashlib
import json
import os
from functools import lru_cache
from pathlib import Path
from collections.abc import Callable
from typing import Final, TypeVar

from .canonical_decode import NativeToolchain
from .protocol import FrozenRuntime

MANIFEST_NAME: Final = "runtime-manifest.json"
MAX_MANIFEST_BYTES: Final = 4 * 1024 * 1024
WINDOWS_FILE_FLAG_BACKUP_SEMANTICS: Final = 0x02000000
WINDOWS_FILE_NAME_OPENED: Final = 0x00000008
WINDOWS_FILE_SHARE_ALL: Final = 0x00000001 | 0x00000002 | 0x00000004
WINDOWS_OPEN_EXISTING: Final = 3
T = TypeVar("T")


class RuntimeManifestError(RuntimeError):
    """The frozen runtime does not match its immutable manifest."""


class RuntimeManifestPermissionError(PermissionError):
    """A stable operation category for a denied frozen-runtime read."""

    def __init__(self, stage: str) -> None:
        super().__init__("frozen runtime access denied")
        self.stage = stage


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
            if not _resolve_runtime_path(path).is_relative_to(runtime_root):
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


def load_frozen_runtime(
    runtime_root: Path,
    *,
    windows_runtime_is_current_directory: bool = False,
) -> FrozenRuntime:
    """Verify the complete runtime before exposing its protocol handshake."""

    # The Windows native launcher has already canonicalized the exact staging
    # root and rejected every reparse point before starting the AppContainer.
    # Avoid opening that directory again from the restricted token: every
    # manifest entry is still handle-resolved and bounded by this absolute root.
    runtime_root = _runtime_root_path(runtime_root)
    manifest_path = runtime_root / MANIFEST_NAME
    if _permission_checked("manifest", manifest_path.stat).st_size > MAX_MANIFEST_BYTES:
        raise RuntimeManifestError("frozen runtime manifest exceeds four MiB")
    content = _permission_checked("manifest", manifest_path.read_bytes)
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
            if set(entry) != {"path", "target", "type"} or not _permission_checked(
                "entry_metadata", candidate.is_symlink
            ):
                raise RuntimeManifestError("frozen runtime symbolic link is invalid")
            target = _permission_checked("entry_metadata", lambda: os.readlink(candidate))
            if target != entry["target"] or not _resolve_runtime_entry(
                candidate,
                runtime_root,
                windows_runtime_is_current_directory=windows_runtime_is_current_directory,
            ).is_relative_to(runtime_root):
                raise RuntimeManifestError("frozen runtime symbolic link escaped its package")
            expected_paths.add(relative)
            continue
        if set(entry) != {"byteSize", "path", "sha256", "type"}:
            raise RuntimeManifestError("frozen runtime file entry is invalid")
        resolved = _resolve_runtime_entry(
            candidate,
            runtime_root,
            windows_runtime_is_current_directory=windows_runtime_is_current_directory,
        )
        if (
            not resolved.is_relative_to(runtime_root)
            or not _permission_checked("entry_metadata", candidate.is_file)
            or _permission_checked("entry_metadata", candidate.is_symlink)
        ):
            raise RuntimeManifestError("frozen runtime file escaped its package")
        if (
            _permission_checked("entry_metadata", candidate.stat).st_size != entry["byteSize"]
            or _permission_checked("entry_content", lambda: _sha256_file(candidate))
            != entry["sha256"]
        ):
            raise RuntimeManifestError(f"frozen runtime hash mismatch for {relative}")
        expected_paths.add(relative)
    actual_paths = _permission_checked(
        "inventory",
        lambda: {
            relative
            for relative in (
                path.relative_to(runtime_root).as_posix()
                for path in runtime_root.rglob("*")
                if path.is_file() or path.is_symlink()
            )
            if relative != MANIFEST_NAME
        },
    )
    if actual_paths != expected_paths:
        raise RuntimeManifestError("frozen runtime contains an unmanifested file")
    executable_suffix = ".exe" if os.name == "nt" else ""
    tools = runtime_root / "tools"
    required_paths = {
        f"open-chords-analysis{executable_suffix}",
        f"tools/ffmpeg{executable_suffix}",
        f"tools/ffprobe{executable_suffix}",
    }
    required_regular_files = {
        entry["path"]
        for entry in files
        if entry["path"] in required_paths and entry["type"] == "file"
    }
    if required_regular_files != required_paths:
        raise RuntimeManifestError("frozen runtime manifest misses a required executable")
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


def _resolve_runtime_path(path: Path, *, stage: str = "entry_metadata") -> Path:
    try:
        return _resolve_windows_path(path) if os.name == "nt" else path.resolve(strict=True)
    except PermissionError as error:
        raise RuntimeManifestPermissionError(stage) from error
    except (OSError, RuntimeError) as error:
        raise RuntimeManifestError("frozen runtime path could not be resolved") from error


def _runtime_root_path(path: Path, *, windows: bool | None = None) -> Path:
    if windows is None:
        windows = os.name == "nt"
    return Path(os.path.abspath(path)) if windows else _resolve_runtime_path(path, stage="root")


def _resolve_runtime_entry(
    path: Path,
    runtime_root: Path,
    *,
    windows_runtime_is_current_directory: bool = False,
) -> Path:
    if os.name == "nt" and windows_runtime_is_current_directory:
        relative = path.relative_to(runtime_root)
        return _resolve_windows_path(relative, preserve_relative=True)
    return _resolve_runtime_path(path)


@lru_cache(maxsize=1)
def _windows_path_api() -> tuple[object, object]:
    import ctypes
    from ctypes import wintypes

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateFileW.argtypes = [
        wintypes.LPCWSTR,
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.LPVOID,
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.HANDLE,
    ]
    kernel32.CreateFileW.restype = wintypes.HANDLE
    kernel32.GetFinalPathNameByHandleW.argtypes = [
        wintypes.HANDLE,
        wintypes.LPWSTR,
        wintypes.DWORD,
        wintypes.DWORD,
    ]
    kernel32.GetFinalPathNameByHandleW.restype = wintypes.DWORD
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel32.CloseHandle.restype = wintypes.BOOL
    return ctypes, kernel32


def _resolve_windows_path(
    path: Path,
    *,
    api: tuple[object, object] | None = None,
    preserve_relative: bool = False,
) -> Path:
    """Resolve a Windows path without CPython's exclusive directory handle."""

    ctypes, kernel32 = api if api is not None else _windows_path_api()
    opened_path = os.fspath(path) if preserve_relative else os.path.abspath(path)
    handle = kernel32.CreateFileW(
        opened_path,
        0,
        WINDOWS_FILE_SHARE_ALL,
        None,
        WINDOWS_OPEN_EXISTING,
        WINDOWS_FILE_FLAG_BACKUP_SEMANTICS,
        None,
    )
    if handle == ctypes.c_void_p(-1).value:
        error = ctypes.WinError(ctypes.get_last_error())
        error.filename = opened_path
        raise error
    try:
        size = 32_768
        while True:
            buffer = ctypes.create_unicode_buffer(size)
            # The native broker has already rejected reparse points and protected the
            # staged tree. FILE_NAME_OPENED avoids re-walking shared ancestors that
            # the exact AppContainer SID intentionally cannot enumerate.
            length = kernel32.GetFinalPathNameByHandleW(
                handle, buffer, size, WINDOWS_FILE_NAME_OPENED
            )
            if length == 0:
                error = ctypes.WinError(ctypes.get_last_error())
                error.filename = opened_path
                raise error
            if length < size:
                return Path(_strip_windows_extended_prefix(buffer.value))
            size = length + 1
    finally:
        kernel32.CloseHandle(handle)


def _strip_windows_extended_prefix(path: str) -> str:
    if path.startswith("\\\\?\\UNC\\"):
        return "\\\\" + path[8:]
    if path.startswith("\\\\?\\"):
        return path[4:]
    return path


def _permission_checked(stage: str, operation: Callable[[], T]) -> T:
    try:
        return operation()
    except PermissionError as error:
        raise RuntimeManifestPermissionError(stage) from error


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

from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from sidecar.open_chords_analysis.runtime_manifest import (
    RuntimeManifestError,
    RuntimeManifestPermissionError,
    WINDOWS_FILE_FLAG_BACKUP_SEMANTICS,
    WINDOWS_FILE_NAME_OPENED,
    WINDOWS_FILE_SHARE_ALL,
    WINDOWS_OPEN_EXISTING,
    _permission_checked,
    _resolve_runtime_path,
    _resolve_windows_path,
    _runtime_root_path,
    _strip_windows_extended_prefix,
    load_frozen_runtime,
    write_runtime_manifest,
)
from sidecar.open_chords_analysis.__main__ import _runtime_permission_failure_code


class _FakeBuffer:
    def __init__(self) -> None:
        self.value = ""


class _FakeCtypes:
    @staticmethod
    def c_void_p(value: int) -> object:
        return type("FakePointer", (), {"value": value})()

    @staticmethod
    def create_unicode_buffer(_size: int) -> _FakeBuffer:
        return _FakeBuffer()

    @staticmethod
    def get_last_error() -> int:
        return 5

    @staticmethod
    def WinError(code: int) -> PermissionError:
        error = PermissionError(code, "access denied")
        error.winerror = code
        return error


class _FakeKernel32:
    def __init__(
        self,
        *,
        final_paths: list[str | None] | None = None,
        open_handle: int | None = None,
        required_sizes: list[int] | None = None,
    ) -> None:
        self.handle = 73
        self.open_handle = self.handle if open_handle is None else open_handle
        self.final_paths = final_paths or [r"\\?\C:\runtime"]
        self.required_sizes = required_sizes or []
        self.create_calls: list[tuple[object, ...]] = []
        self.buffer_sizes: list[int] = []
        self.final_path_flags: list[int] = []
        self.closed_handles: list[int] = []

    def CreateFileW(self, *args: object) -> int:
        self.create_calls.append(args)
        return self.open_handle

    def GetFinalPathNameByHandleW(
        self, _handle: int, buffer: _FakeBuffer, size: int, flags: int
    ) -> int:
        index = len(self.buffer_sizes)
        self.buffer_sizes.append(size)
        self.final_path_flags.append(flags)
        if index < len(self.required_sizes):
            return self.required_sizes[index]
        value = self.final_paths[index]
        if value is None:
            return 0
        buffer.value = value
        return len(value)

    def CloseHandle(self, handle: int) -> bool:
        self.closed_handles.append(handle)
        return True


class RuntimeManifestTests(unittest.TestCase):
    def test_strips_only_windows_extended_path_prefixes(self) -> None:
        self.assertEqual(
            _strip_windows_extended_prefix(r"\\?\C:\runtime"), r"C:\runtime"
        )
        self.assertEqual(
            _strip_windows_extended_prefix(r"\\?\UNC\server\share\runtime"),
            r"\\server\share\runtime",
        )
        self.assertEqual(
            _strip_windows_extended_prefix(r"C:\runtime"), r"C:\runtime"
        )

    def test_windows_runtime_resolution_uses_the_shared_handle_resolver(self) -> None:
        path = Path("runtime")
        resolved = Path("resolved-runtime")
        with (
            patch("sidecar.open_chords_analysis.runtime_manifest.os.name", "nt"),
            patch(
                "sidecar.open_chords_analysis.runtime_manifest._resolve_windows_path",
                return_value=resolved,
            ) as resolve_windows,
        ):
            self.assertEqual(_resolve_runtime_path(path, stage="root"), resolved)

        resolve_windows.assert_called_once_with(path)

    def test_windows_shared_handle_resolver_uses_exact_flags_and_closes(self) -> None:
        ctypes = _FakeCtypes()
        kernel32 = _FakeKernel32(
            final_paths=[None, r"\\?\C:\runtime"], required_sizes=[40_000]
        )

        resolved = _resolve_windows_path(
            Path("runtime"), api=(ctypes, kernel32)
        )

        self.assertEqual(resolved, Path(r"C:\runtime"))
        self.assertEqual(
            kernel32.create_calls[0][1:],
            (
                0,
                WINDOWS_FILE_SHARE_ALL,
                None,
                WINDOWS_OPEN_EXISTING,
                WINDOWS_FILE_FLAG_BACKUP_SEMANTICS,
                None,
            ),
        )
        self.assertEqual(kernel32.buffer_sizes, [32_768, 40_001])
        self.assertEqual(
            kernel32.final_path_flags,
            [WINDOWS_FILE_NAME_OPENED, WINDOWS_FILE_NAME_OPENED],
        )
        self.assertEqual(kernel32.closed_handles, [kernel32.handle])

    def test_windows_shared_handle_resolver_reports_open_failure(self) -> None:
        ctypes = _FakeCtypes()
        kernel32 = _FakeKernel32(open_handle=ctypes.c_void_p(-1).value)

        with self.assertRaises(PermissionError):
            _resolve_windows_path(Path("runtime"), api=(ctypes, kernel32))

        self.assertEqual(kernel32.closed_handles, [])

    def test_windows_runtime_root_uses_native_prevalidated_absolute_path(self) -> None:
        runtime_root = Path("runtime")
        with patch(
            "sidecar.open_chords_analysis.runtime_manifest._resolve_windows_path",
            side_effect=AssertionError("must not reopen the prevalidated root"),
        ) as resolve:
            resolved = _runtime_root_path(runtime_root, windows=True)

        self.assertEqual(resolved, Path(os.path.abspath(runtime_root)))
        resolve.assert_not_called()

    def test_windows_shared_handle_resolver_closes_after_final_path_failure(self) -> None:
        ctypes = _FakeCtypes()
        kernel32 = _FakeKernel32(final_paths=[None], required_sizes=[0])

        with self.assertRaises(PermissionError):
            _resolve_windows_path(Path("runtime"), api=(ctypes, kernel32))

        self.assertEqual(kernel32.closed_handles, [kernel32.handle])

    def test_preserves_only_the_runtime_permission_operation_category(self) -> None:
        def denied() -> None:
            raise PermissionError(13, "private path", "/private/source")

        with self.assertRaises(RuntimeManifestPermissionError) as raised:
            _permission_checked("entry_content", denied)

        self.assertEqual(raised.exception.stage, "entry_content")
        self.assertNotIn("private", str(raised.exception))

    def test_classifies_a_denied_symlink_target_read_as_entry_metadata(self) -> None:
        with tempfile.TemporaryDirectory(prefix="open-chords-runtime-link-denial-") as temporary:
            runtime_root = self._runtime_root(Path(temporary))
            target = runtime_root / "payload.bin"
            target.write_bytes(b"payload")
            link = runtime_root / "payload-link"
            try:
                link.symlink_to(target.name)
            except (NotImplementedError, OSError) as error:
                self.skipTest(f"symbolic links are unavailable: {error}")
            write_runtime_manifest(runtime_root, build_id="test-build", platform_profile="test")
            original_readlink = os.readlink

            def denied_runtime_link(path: str | os.PathLike[str]) -> str:
                if Path(path).name == link.name:
                    raise PermissionError(13, "private path", str(link))
                return original_readlink(path)

            with (
                patch(
                    "sidecar.open_chords_analysis.runtime_manifest.os.readlink",
                    side_effect=denied_runtime_link,
                ),
                self.assertRaises(RuntimeManifestPermissionError) as raised,
            ):
                load_frozen_runtime(runtime_root)

            self.assertEqual(raised.exception.stage, "entry_metadata")
            self.assertNotIn("private", str(raised.exception))

    def test_classifies_runtime_permission_failures_without_exposing_paths(self) -> None:
        runtime_root = Path("runtime").resolve()

        cases = {
            runtime_root: "sidecar_runtime_root_permission_denied",
            runtime_root / "runtime-manifest.json": "sidecar_runtime_manifest_permission_denied",
            runtime_root / "tools/ffprobe.exe": "sidecar_runtime_tool_permission_denied",
            runtime_root / "_internal/python313.dll": "sidecar_runtime_file_permission_denied",
        }
        for denied_path, expected in cases.items():
            with self.subTest(denied_path=denied_path.name):
                error = PermissionError(13, "denied", str(denied_path))
                self.assertEqual(_runtime_permission_failure_code(error, runtime_root), expected)

        self.assertEqual(
            _runtime_permission_failure_code(PermissionError(13, "denied"), runtime_root),
            "sidecar_runtime_root_permission_denied",
        )

    def test_manifest_identifies_and_verifies_every_runtime_file(self) -> None:
        with tempfile.TemporaryDirectory(prefix="open-chords-runtime-") as temporary:
            runtime_root = Path(temporary)
            tools = runtime_root / "tools"
            tools.mkdir()
            executable_suffix = ".exe" if os.name == "nt" else ""
            (runtime_root / f"open-chords-analysis{executable_suffix}").write_bytes(b"sidecar")
            ffmpeg = tools / f"ffmpeg{executable_suffix}"
            ffmpeg.write_bytes(b"ffmpeg")
            (tools / f"ffprobe{executable_suffix}").write_bytes(b"ffprobe")
            (runtime_root / "native-dependencies.json").write_text("{}\n", "utf-8")

            expected_hash = write_runtime_manifest(
                runtime_root,
                build_id="test-build",
                platform_profile="darwin-arm64-test",
            )
            runtime = load_frozen_runtime(runtime_root)

            self.assertEqual(runtime.manifest_hash, expected_hash)
            self.assertEqual(runtime.platform_profile, "darwin-arm64-test")
            self.assertTrue(os.path.samefile(runtime.toolchain.ffmpeg, ffmpeg))

            ffmpeg.write_bytes(b"changed")
            with self.assertRaisesRegex(RuntimeManifestError, "hash mismatch"):
                load_frozen_runtime(runtime_root)

    def test_verifies_nested_file_named_like_the_root_manifest(self) -> None:
        with tempfile.TemporaryDirectory(prefix="open-chords-runtime-nested-manifest-") as temporary:
            runtime_root = self._runtime_root(Path(temporary))
            nested_manifest = runtime_root / "_internal/runtime-manifest.json"
            nested_manifest.parent.mkdir()
            nested_manifest.write_text("nested runtime data\n", "utf-8")

            write_runtime_manifest(runtime_root, build_id="test-build", platform_profile="test")

            load_frozen_runtime(runtime_root)
            nested_manifest.write_text("changed\n", "utf-8")
            with self.assertRaisesRegex(RuntimeManifestError, "hash mismatch"):
                load_frozen_runtime(runtime_root)

    def test_rejects_extra_and_missing_required_runtime_files(self) -> None:
        with tempfile.TemporaryDirectory(prefix="open-chords-runtime-required-") as temporary:
            runtime_root = self._runtime_root(Path(temporary))
            write_runtime_manifest(runtime_root, build_id="test-build", platform_profile="test")
            (runtime_root / "extra.bin").write_bytes(b"extra")
            with self.assertRaisesRegex(RuntimeManifestError, "unmanifested"):
                load_frozen_runtime(runtime_root)

        with tempfile.TemporaryDirectory(prefix="open-chords-runtime-missing-tool-") as temporary:
            runtime_root = Path(temporary)
            suffix = ".exe" if os.name == "nt" else ""
            (runtime_root / f"open-chords-analysis{suffix}").write_bytes(b"sidecar")
            write_runtime_manifest(runtime_root, build_id="test-build", platform_profile="test")
            with self.assertRaisesRegex(RuntimeManifestError, "required executable"):
                load_frozen_runtime(runtime_root)

    def test_rejects_oversized_manifest_before_reading_it(self) -> None:
        with tempfile.TemporaryDirectory(prefix="open-chords-runtime-large-manifest-") as temporary:
            runtime_root = Path(temporary)
            manifest_path = runtime_root / "runtime-manifest.json"
            manifest_path.write_bytes(b"x" * (4 * 1024 * 1024 + 1))

            with (
                patch.object(Path, "read_bytes", side_effect=AssertionError("manifest was read")),
                self.assertRaisesRegex(RuntimeManifestError, "exceeds four MiB"),
            ):
                load_frozen_runtime(runtime_root)

    def test_wraps_unresolvable_runtime_symlinks(self) -> None:
        with tempfile.TemporaryDirectory(prefix="open-chords-runtime-broken-link-") as temporary:
            runtime_root = self._runtime_root(Path(temporary))
            broken_link = runtime_root / "_internal-link"
            try:
                broken_link.symlink_to("missing-target")
            except (NotImplementedError, OSError) as error:
                self.skipTest(f"symbolic links are unavailable: {error}")

            with self.assertRaisesRegex(RuntimeManifestError, "could not be resolved"):
                write_runtime_manifest(runtime_root, build_id="test-build", platform_profile="test")

    def test_rejects_a_required_executable_symlink(self) -> None:
        with tempfile.TemporaryDirectory(prefix="open-chords-runtime-required-link-") as temporary:
            runtime_root = self._runtime_root(Path(temporary))
            suffix = ".exe" if os.name == "nt" else ""
            executable = runtime_root / f"open-chords-analysis{suffix}"
            target = runtime_root / "sidecar.bin"
            executable.replace(target)
            try:
                executable.symlink_to(target.name)
            except (NotImplementedError, OSError) as error:
                self.skipTest(f"symbolic links are unavailable: {error}")

            write_runtime_manifest(runtime_root, build_id="test-build", platform_profile="test")
            with self.assertRaisesRegex(RuntimeManifestError, "required executable"):
                load_frozen_runtime(runtime_root)

    @staticmethod
    def _runtime_root(runtime_root: Path) -> Path:
        tools = runtime_root / "tools"
        tools.mkdir()
        suffix = ".exe" if os.name == "nt" else ""
        (runtime_root / f"open-chords-analysis{suffix}").write_bytes(b"sidecar")
        (tools / f"ffmpeg{suffix}").write_bytes(b"ffmpeg")
        (tools / f"ffprobe{suffix}").write_bytes(b"ffprobe")
        return runtime_root


if __name__ == "__main__":
    unittest.main()

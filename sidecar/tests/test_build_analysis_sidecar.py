from __future__ import annotations

import json
import runpy
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


class BuildAnalysisSidecarTests(unittest.TestCase):
    def test_reads_bounded_pre_mark_native_version_metadata(self) -> None:
        bounded_version_file = runpy.run_path(
            Path(__file__).resolve().parents[2] / "tools/build-analysis-sidecar.py"
        )["_bounded_version_file"]

        with tempfile.TemporaryDirectory() as temporary:
            version_file = Path(temporary) / "ffmpeg-version.txt"
            version_file.write_text("ffmpeg version reviewed\nconfiguration\n", "utf-8")
            self.assertEqual(bounded_version_file(version_file), "ffmpeg version reviewed")
            version_file.write_text("x" * 513, "utf-8")
            with self.assertRaisesRegex(ValueError, "version metadata is invalid"):
                bounded_version_file(version_file)

    @unittest.skipUnless(sys.platform == "darwin", "macOS codesign bundle semantics")
    def test_materializes_pyinstaller_symlinks_for_nested_bundle_signing(self) -> None:
        materialize = runpy.run_path(
            Path(__file__).resolve().parents[2] / "tools/build-analysis-sidecar.py"
        )["_materialize_macos_runtime_symlinks"]

        with tempfile.TemporaryDirectory(prefix="open-chords-python-alias-") as temporary:
            runtime = Path(temporary)
            target = runtime / "_internal/Python.framework/Versions/3.13/Python"
            target.parent.mkdir(parents=True)
            target.write_bytes(b"signed-python")
            alias = runtime / "_internal/Python"
            alias.symlink_to("Python.framework/Versions/3.13/Python")
            current = runtime / "_internal/Python.framework/Versions/Current"
            current.symlink_to("3.13", target_is_directory=True)
            framework_alias = runtime / "_internal/Python.framework/Python"
            framework_alias.symlink_to("Versions/Current/Python")

            materialize(runtime)

            self.assertFalse(alias.is_symlink())
            self.assertEqual(alias.read_bytes(), b"signed-python")
            self.assertFalse(current.is_symlink())
            self.assertFalse(current.exists())
            self.assertFalse(framework_alias.is_symlink())
            self.assertFalse(framework_alias.exists())

    def test_reports_missing_pyinstaller_license_with_context(self) -> None:
        pyinstaller_license = runpy.run_path(
            Path(__file__).resolve().parents[2] / "tools/build-analysis-sidecar.py"
        )["_pyinstaller_license"]

        with self.assertRaisesRegex(FileNotFoundError, "PyInstaller COPYING.txt"):
            pyinstaller_license(SimpleNamespace(files=[]))

    def test_finds_setup_python_and_ancestor_license_layouts(self) -> None:
        find_python_license = runpy.run_path(
            Path(__file__).resolve().parents[2] / "tools/build-analysis-sidecar.py"
        )["_find_python_license"]

        with tempfile.TemporaryDirectory(prefix="open-chords-python-license-") as temporary:
            root = Path(temporary)
            executable = root / "framework/Versions/3.13/bin/python"
            stdlib = root / "framework/Versions/3.13/lib/python3.13"
            stdlib.mkdir(parents=True)
            setup_python_license = stdlib / "LICENSE.txt"
            setup_python_license.write_text("setup-python license", "utf-8")
            self.assertEqual(find_python_license(executable, stdlib), setup_python_license)

            setup_python_license.unlink()
            ancestor_license = root / "framework/Versions/3.13/LICENSE"
            ancestor_license.write_text("framework license", "utf-8")
            self.assertEqual(find_python_license(executable, stdlib), ancestor_license)

    def test_classifies_all_windows_api_set_forwarders_as_msvc_runtime(self) -> None:
        native_component = runpy.run_path(
            Path(__file__).resolve().parents[2] / "tools/build-analysis-sidecar.py"
        )["_native_component"]

        self.assertEqual(
            native_component("_internal/api-ms-win-core-console-l1-1-0.dll", "pe"),
            "msvc-runtime",
        )
        self.assertEqual(
            native_component("_internal/api-ms-win-crt-runtime-l1-1-0.dll", "pe"),
            "msvc-runtime",
        )
        self.assertIsNone(
            native_component("_internal/api-ms-win-not-a-dll.txt", None),
        )
        with self.assertRaisesRegex(RuntimeError, "Unclassified native runtime file"):
            native_component("_internal/api-ms-win-not-actually-pe.dll", None)
        with self.assertRaisesRegex(RuntimeError, "Unclassified native runtime file"):
            native_component("_internal/unreviewed-runtime.dll", "pe")

    def test_classifies_only_the_reviewed_winpthreads_runtime(self) -> None:
        native_component = runpy.run_path(
            Path(__file__).resolve().parents[2] / "tools/build-analysis-sidecar.py"
        )["_native_component"]

        self.assertEqual(
            native_component("tools/libwinpthread-1.dll", "pe"),
            "winpthreads",
        )
        with self.assertRaisesRegex(RuntimeError, "Unclassified native runtime file"):
            native_component("tools/unreviewed-runtime.dll", "pe")

    def test_classifies_cpu_analysis_native_extensions_by_distribution(self) -> None:
        native_component = runpy.run_path(
            Path(__file__).resolve().parents[2] / "tools/build-analysis-sidecar.py"
        )["_native_component"]

        self.assertEqual(
            native_component(
                "_internal/numpy/_core/_multiarray_umath.cpython-313-darwin.so",
                "mach-o",
            ),
            "numpy",
        )
        self.assertEqual(
            native_component("_internal/scipy/signal/_sigtools.cp313-win_amd64.pyd", "pe"),
            "scipy",
        )
        self.assertEqual(
            native_component("_internal/numpy.libs/libopenblas.dll", "pe"),
            "numpy",
        )
        self.assertEqual(
            native_component("_internal/scipy.libs/libopenblas.dll", "pe"),
            "scipy",
        )
        self.assertEqual(
            native_component("_internal/llvmlite/binding/libllvmlite.dylib", "mach-o"),
            "llvmlite",
        )
        self.assertEqual(
            native_component("_internal/_cffi_backend.cp313-win_amd64.pyd", "pe"),
            "cffi",
        )
        self.assertEqual(
            native_component("_internal/_soundfile_data/libsndfile_x64.dll", "pe"),
            "soundfile",
        )

    def test_excludes_terminal_modules_from_the_headless_runtime(self) -> None:
        excluded_modules = runpy.run_path(
            Path(__file__).resolve().parents[2] / "tools/build-analysis-sidecar.py"
        )["PYINSTALLER_EXCLUDED_MODULES"]

        self.assertGreaterEqual(
            set(excluded_modules),
            {"_curses", "_curses_panel", "curses", "readline"},
        )

    def test_collects_exact_analysis_dependency_licenses(self) -> None:
        module = runpy.run_path(
            Path(__file__).resolve().parents[2] / "tools/build-analysis-sidecar.py"
        )

        with tempfile.TemporaryDirectory(prefix="open-chords-analysis-licenses-") as temporary:
            output = Path(temporary) / "licenses.txt"
            versions = module["_write_python_analysis_licenses"](output)

            self.assertEqual(versions["librosa"], "0.11.0")
            self.assertIn("===== librosa 0.11.0 =====", output.read_text("utf-8"))
            self.assertIn("===== numpy ", output.read_text("utf-8"))
            self.assertGreater(output.stat().st_size, 1_000)

    def test_filters_platform_specific_dependency_authority(self) -> None:
        dependencies_for_profile = runpy.run_path(
            Path(__file__).resolve().parents[2] / "tools/build-analysis-sidecar.py"
        )["_dependencies_for_profile"]
        dependencies = [
            {"component": "shared"},
            {"component": "windows", "platformProfiles": ["windows-server-2025-x64"]},
        ]

        self.assertEqual(
            [
                dependency["component"]
                for dependency in dependencies_for_profile(
                    dependencies, "windows-server-2025-x64"
                )
            ],
            ["shared", "windows"],
        )
        self.assertEqual(
            [
                dependency["component"]
                for dependency in dependencies_for_profile(dependencies, "darwin-arm64")
            ],
            ["shared"],
        )

    @unittest.skipUnless(sys.platform == "darwin", "Mach-O paths require macOS semantics")
    def test_rejects_unpackaged_macho_dependencies(self) -> None:
        validate_dependency = runpy.run_path(
            Path(__file__).resolve().parents[2] / "tools/build-analysis-sidecar.py"
        )["_validate_macho_dependency"]

        with tempfile.TemporaryDirectory(prefix="open-chords-macho-closure-") as temporary:
            runtime_root = Path(temporary).resolve()
            owner = runtime_root / "_internal/python3.13/lib-dynload/_ssl.so"
            owner.parent.mkdir(parents=True)
            owner.write_bytes(b"sidecar")
            packaged_library = runtime_root / "_internal/libcrypto.3.dylib"
            packaged_library.write_bytes(b"crypto")
            validate_dependency(
                runtime_root,
                owner,
                "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation",
                [],
                {"_internal/libcrypto.3.dylib", "_internal/python3.13/lib-dynload/_ssl.so"},
            )
            validate_dependency(
                runtime_root,
                owner,
                "@rpath/libcrypto.3.dylib",
                ["@loader_path/../.."],
                {"_internal/libcrypto.3.dylib", "_internal/python3.13/lib-dynload/_ssl.so"},
            )
            unrelated_library = runtime_root / "unrelated/libmissing.dylib"
            unrelated_library.parent.mkdir()
            unrelated_library.write_bytes(b"unrelated")
            with self.assertRaisesRegex(RuntimeError, "Unresolvable Mach-O dependency"):
                validate_dependency(
                    runtime_root,
                    owner,
                    "@rpath/libmissing.dylib",
                    ["@loader_path/../.."],
                    {
                        "_internal/python3.13/lib-dynload/_ssl.so",
                        "unrelated/libmissing.dylib",
                    },
                )
            with self.assertRaisesRegex(RuntimeError, "Unreviewed Mach-O dependency"):
                validate_dependency(
                    runtime_root,
                    owner,
                    "/opt/homebrew/lib/libhost.dylib",
                    [],
                    {"_internal/python3.13/lib-dynload/_ssl.so"},
                )
            with self.assertRaisesRegex(RuntimeError, "Unreviewed Mach-O dependency"):
                validate_dependency(
                    runtime_root,
                    owner,
                    "/usr/lib",
                    [],
                    {"_internal/python3.13/lib-dynload/_ssl.so"},
                )
            with self.assertRaisesRegex(RuntimeError, "Unresolvable Mach-O dependency"):
                validate_dependency(
                    runtime_root,
                    owner,
                    "@rpath/libcrypto.3.dylib",
                    ["@loader_path_fake/.."],
                    {"_internal/libcrypto.3.dylib", "_internal/python3.13/lib-dynload/_ssl.so"},
                )
            with self.assertRaisesRegex(RuntimeError, "Unresolvable Mach-O dependency"):
                validate_dependency(
                    runtime_root,
                    owner,
                    "@rpath/LIBCRYPTO.3.DYLIB",
                    ["@loader_path/../.."],
                    {"_internal/libcrypto.3.dylib", "_internal/python3.13/lib-dynload/_ssl.so"},
                )
            with self.assertRaisesRegex(RuntimeError, "Unreviewed Mach-O dependency"):
                validate_dependency(
                    runtime_root,
                    owner,
                    "/usr/lib/../../opt/host/libevil.dylib",
                    [],
                    {"_internal/python3.13/lib-dynload/_ssl.so"},
                )

    @unittest.skipUnless(sys.platform == "darwin", "Mach-O symlinks require macOS semantics")
    def test_indexes_only_native_files_and_symlinks_to_native_files(self) -> None:
        module = runpy.run_path(
            Path(__file__).resolve().parents[2] / "tools/build-analysis-sidecar.py"
        )
        packaged_native_paths = module["_packaged_native_paths"]
        validate_dependency = module["_validate_macho_dependency"]

        with tempfile.TemporaryDirectory(prefix="open-chords-native-index-") as temporary:
            runtime_root = Path(temporary).resolve()
            internal = runtime_root / "_internal"
            internal.mkdir()
            native = internal / "Python.framework/Versions/3.13/Python"
            native.parent.mkdir(parents=True)
            native.write_bytes(b"native")
            data = internal / "not-a-native-library"
            data.write_text("data", "utf-8")
            link = internal / "Python"
            try:
                link.symlink_to("Python.framework/Versions/3.13/Python")
            except (NotImplementedError, OSError) as error:
                self.skipTest(f"symbolic links are unavailable: {error}")

            indexed = packaged_native_paths(
                runtime_root,
                [
                    {
                        "component": "cpython",
                        "format": "mach-o",
                        "path": native.relative_to(runtime_root).as_posix(),
                        "sha256": "0" * 64,
                    }
                ],
            )

            self.assertIn("_internal/Python", indexed)
            self.assertIn("_internal/Python.framework/Versions/3.13/Python", indexed)
            self.assertNotIn("_internal/not-a-native-library", indexed)
            with self.assertRaisesRegex(RuntimeError, "Unresolvable Mach-O dependency"):
                validate_dependency(
                    runtime_root,
                    native,
                    "@rpath/not-a-native-library",
                    ["@loader_path/../../.."],
                    indexed,
                )

    def test_rejects_unpackaged_pe_dependencies(self) -> None:
        validate_dependencies = runpy.run_path(
            Path(__file__).resolve().parents[2] / "tools/build-analysis-sidecar.py"
        )["_validate_pe_dependencies"]

        validate_dependencies(
            "open-chords-analysis.exe",
            ["KERNEL32.dll", "python313.dll"],
            {"open-chords-analysis.exe", "_internal/python313.dll"},
            {"kernel32.dll"},
        )
        validate_dependencies(
            "_internal/llvmlite/binding/llvmlite.dll",
            ["msvcp140-reviewed.dll"],
            {
                "_internal/llvmlite/binding/llvmlite.dll",
                "_internal/llvmlite.libs/msvcp140-reviewed.dll",
            },
            set(),
        )
        with self.assertRaisesRegex(RuntimeError, "Unpackaged PE dependency"):
            validate_dependencies(
                "tools/ffmpeg.exe",
                ["python313.dll"],
                {"tools/ffmpeg.exe", "unrelated/python313.dll"},
                {"kernel32.dll"},
            )

    def test_allows_reviewed_windows_analysis_system_dependencies(self) -> None:
        module = runpy.run_path(
            Path(__file__).resolve().parents[2] / "tools/build-analysis-sidecar.py"
        )
        manifest = json.loads(
            (
                Path(__file__).resolve().parents[1]
                / "native/ffmpeg-build.json"
            ).read_text("utf-8")
        )

        module["_validate_pe_dependencies"](
            "_internal/_soundfile_data/libsndfile_x64.dll",
            ["SHLWAPI.dll"],
            {"_internal/_soundfile_data/libsndfile_x64.dll"},
            {
                name.lower()
                for name in manifest["windowsFrozenRuntimeSystemDlls"]
            },
        )
        module["_validate_pe_dependencies"](
            "_internal/llvmlite/binding/llvmlite.dll",
            ["ntdll.dll"],
            {"_internal/llvmlite/binding/llvmlite.dll"},
            {
                name.lower()
                for name in manifest["windowsFrozenRuntimeSystemDlls"]
            },
        )

    def test_resolves_windows_objdump_only_from_path(self) -> None:
        module = runpy.run_path(
            Path(__file__).resolve().parents[2] / "tools/build-analysis-sidecar.py"
        )
        windows_objdump = module["_windows_objdump"]

        with patch.object(module["shutil"], "which", return_value=None):
            with self.assertRaisesRegex(FileNotFoundError, "objdump was not found"):
                windows_objdump()
        with patch.object(
            module["shutil"],
            "which",
            return_value="D:/runner-temp/msys64/ucrt64/bin/objdump.exe",
        ):
            self.assertEqual(
                windows_objdump(),
                "D:/runner-temp/msys64/ucrt64/bin/objdump.exe",
            )

    def test_filters_universal_macho_architecture_headers(self) -> None:
        otool_payload_lines = runpy.run_path(
            Path(__file__).resolve().parents[2] / "tools/build-analysis-sidecar.py"
        )["_otool_payload_lines"]

        self.assertEqual(
            otool_payload_lines(
                "\n".join(
                    [
                        "/tmp/Python (architecture arm64):",
                        "    @rpath/Python (compatibility version 3.13.0)",
                        "/tmp/Python (architecture x86_64):",
                        "    @rpath/Python (compatibility version 3.13.0)",
                    ]
                )
            ),
            [
                "@rpath/Python (compatibility version 3.13.0)",
                "@rpath/Python (compatibility version 3.13.0)",
            ],
        )

    def test_keeps_ffmpeg_and_frozen_runtime_system_authorities_separate(self) -> None:
        manifest = json.loads(
            (Path(__file__).resolve().parents[1] / "native/ffmpeg-build.json").read_text("utf-8")
        )

        self.assertNotIn("COMCTL32.dll", manifest["windowsSystemDlls"])
        self.assertIn("COMCTL32.dll", manifest["windowsFrozenRuntimeSystemDlls"])


if __name__ == "__main__":
    unittest.main()

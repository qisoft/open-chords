from __future__ import annotations

import json
import runpy
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace


class BuildAnalysisSidecarTests(unittest.TestCase):
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
                    "/usr/lib/../../opt/host/libevil.dylib",
                    [],
                    {"_internal/python3.13/lib-dynload/_ssl.so"},
                )

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

            self.assertIn("_internal/python", indexed)
            self.assertIn("_internal/python.framework/versions/3.13/python", indexed)
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
        with self.assertRaisesRegex(RuntimeError, "Unpackaged PE dependency"):
            validate_dependencies(
                "tools/ffmpeg.exe",
                ["python313.dll"],
                {"tools/ffmpeg.exe", "unrelated/python313.dll"},
                {"kernel32.dll"},
            )

    def test_keeps_ffmpeg_and_frozen_runtime_system_authorities_separate(self) -> None:
        manifest = json.loads(
            (Path(__file__).resolve().parents[1] / "native/ffmpeg-build.json").read_text("utf-8")
        )

        self.assertNotIn("COMCTL32.dll", manifest["windowsSystemDlls"])
        self.assertIn("COMCTL32.dll", manifest["windowsFrozenRuntimeSystemDlls"])


if __name__ == "__main__":
    unittest.main()

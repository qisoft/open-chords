from __future__ import annotations

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


if __name__ == "__main__":
    unittest.main()

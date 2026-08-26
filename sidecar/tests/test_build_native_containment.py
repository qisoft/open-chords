import json
import plistlib
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


@unittest.skipUnless(sys.platform == "darwin", "macOS native broker build")
class NativeContainmentBuildTests(unittest.TestCase):
    def test_builds_signed_xpc_service_without_network_entitlements(self) -> None:
        with tempfile.TemporaryDirectory(prefix="open-chords-containment-test-") as temporary:
            output = Path(temporary) / "containment"
            subprocess.run(
                [
                    sys.executable,
                    str(ROOT / "tools/build-native-containment.py"),
                    "--output-root",
                    str(output),
                ],
                check=True,
                cwd=ROOT,
            )
            service = output / "OpenChordsAnalysisService.xpc"
            subprocess.run(["codesign", "--verify", "--strict", str(service)], check=True)
            entitlements = plistlib.loads(
                subprocess.run(
                    ["codesign", "-d", "--entitlements", ":-", str(service)],
                    check=True,
                    stdout=subprocess.PIPE,
                ).stdout
            )
            self.assertIs(entitlements["com.apple.security.app-sandbox"], True)
            self.assertNotIn("com.apple.security.network.client", entitlements)
            self.assertNotIn("com.apple.security.network.server", entitlements)
            manifest = json.loads((output / "containment-manifest.json").read_text("utf-8"))
            self.assertEqual(manifest["backend"], "macos-xpc-app-sandbox")
            self.assertGreaterEqual(len(manifest["files"]), 3)

    def test_signs_spawned_runtime_helpers_for_sandbox_inheritance(self) -> None:
        with tempfile.TemporaryDirectory(prefix="open-chords-runtime-sign-test-") as temporary:
            runtime = Path(temporary) / "runtime"
            (runtime / "tools").mkdir(parents=True)
            for relative in ("open-chords-analysis", "tools/ffmpeg", "tools/ffprobe"):
                shutil.copyfile("/bin/echo", runtime / relative)
                (runtime / relative).chmod(0o755)
            subprocess.run(
                [
                    sys.executable,
                    str(ROOT / "tools/sign-macos-analysis-runtime.py"),
                    "--runtime-root",
                    str(runtime),
                ],
                check=True,
                cwd=ROOT,
            )
            for relative in ("open-chords-analysis", "tools/ffmpeg", "tools/ffprobe"):
                helper = runtime / relative
                subprocess.run(["codesign", "--verify", "--strict", str(helper)], check=True)
                entitlements = plistlib.loads(
                    subprocess.run(
                        ["codesign", "-d", "--entitlements", ":-", str(helper)],
                        check=True,
                        stdout=subprocess.PIPE,
                    ).stdout
                )
                self.assertIs(entitlements["com.apple.security.app-sandbox"], True)
                self.assertIs(entitlements["com.apple.security.inherit"], True)
                self.assertNotIn("com.apple.security.network.client", entitlements)


@unittest.skipUnless(sys.platform == "win32", "Windows native broker build")
class WindowsNativeContainmentBuildTests(unittest.TestCase):
    def test_builds_appcontainer_job_launcher(self) -> None:
        with tempfile.TemporaryDirectory(prefix="open-chords-containment-test-") as temporary:
            output = Path(temporary) / "containment"
            subprocess.run(
                [
                    sys.executable,
                    str(ROOT / "tools/build-native-containment.py"),
                    "--output-root",
                    str(output),
                ],
                check=True,
                cwd=ROOT,
            )
            executable = output / "open-chords-containment-launcher.exe"
            self.assertEqual(executable.read_bytes()[:2], b"MZ")
            manifest = json.loads((output / "containment-manifest.json").read_text("utf-8"))
            self.assertEqual(manifest["backend"], "windows-appcontainer-job")


if __name__ == "__main__":
    unittest.main()

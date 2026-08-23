from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path

from sidecar.open_chords_analysis.runtime_manifest import (
    RuntimeManifestError,
    load_frozen_runtime,
    write_runtime_manifest,
)


class RuntimeManifestTests(unittest.TestCase):
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
            self.assertEqual(runtime.toolchain.ffmpeg, ffmpeg.resolve())

            ffmpeg.write_bytes(b"changed")
            with self.assertRaisesRegex(RuntimeManifestError, "hash mismatch"):
                load_frozen_runtime(runtime_root)


if __name__ == "__main__":
    unittest.main()

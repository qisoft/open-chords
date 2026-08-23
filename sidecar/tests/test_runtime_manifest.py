from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

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

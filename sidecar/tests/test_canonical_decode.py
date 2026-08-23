from __future__ import annotations

import json
import math
import shutil
import tempfile
import unittest
import wave
from pathlib import Path

from sidecar.open_chords_analysis.canonical_decode import (
    CanonicalDecodeConfig,
    NativeToolchain,
    decode_canonical,
)


class CanonicalDecodeTests(unittest.TestCase):
    def test_decodes_the_same_staged_media_deterministically(self) -> None:
        ffmpeg = shutil.which("ffmpeg")
        ffprobe = shutil.which("ffprobe")
        if ffmpeg is None or ffprobe is None:
            self.skipTest("FFmpeg development tools are unavailable")

        with tempfile.TemporaryDirectory(prefix="open-chords-decode-") as temporary:
            root = Path(temporary)
            first = root / "first"
            second = root / "second"
            for workspace in (first, second):
                media = workspace / "input" / "source-media"
                media.parent.mkdir(parents=True)
                self._write_stereo_fixture(media)

            toolchain = NativeToolchain(Path(ffmpeg), Path(ffprobe))
            config = CanonicalDecodeConfig(platform_profile="darwin-arm64-test")
            first_descriptor = decode_canonical(first, toolchain, config)
            second_descriptor = decode_canonical(second, toolchain, config)

            first_manifest = json.loads((first / first_descriptor.path).read_text("utf-8"))
            second_manifest = json.loads((second / second_descriptor.path).read_text("utf-8"))
            self.assertEqual(first_manifest, second_manifest)
            self.assertEqual(
                first_manifest["canonicalAudio"],
                {
                    "channels": 1,
                    "sampleCount": 48_000,
                    "sampleFormat": "s16le",
                    "sampleRate": 48_000,
                },
            )
            self.assertEqual(first_manifest["artifact"]["path"], "artifacts/canonical.wav")
            self.assertRegex(first_descriptor.sha256, r"^[a-f0-9]{64}$")

    @staticmethod
    def _write_stereo_fixture(path: Path) -> None:
        with wave.open(str(path), "wb") as fixture:
            fixture.setnchannels(2)
            fixture.setsampwidth(2)
            fixture.setframerate(44_100)
            frames = bytearray()
            for index in range(44_100):
                left = round(math.sin(index / 17) * 4_000)
                right = round(math.cos(index / 23) * 2_000)
                frames.extend(left.to_bytes(2, "little", signed=True))
                frames.extend(right.to_bytes(2, "little", signed=True))
            fixture.writeframes(frames)


if __name__ == "__main__":
    unittest.main()

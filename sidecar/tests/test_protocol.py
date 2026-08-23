from __future__ import annotations

import io
import json
import math
import shutil
import struct
import tempfile
import unittest
import wave
from pathlib import Path

from sidecar.open_chords_analysis.canonical_decode import NativeToolchain
from sidecar.open_chords_analysis.protocol import FrozenRuntime, serve_one_session


class ProtocolTests(unittest.TestCase):
    def test_returns_only_framed_protocol_and_a_file_descriptor(self) -> None:
        ffmpeg = shutil.which("ffmpeg")
        ffprobe = shutil.which("ffprobe")
        if ffmpeg is None or ffprobe is None:
            self.skipTest("FFmpeg development tools are unavailable")

        with tempfile.TemporaryDirectory(prefix="open-chords-protocol-") as temporary:
            workspace = Path(temporary)
            media = workspace / "input" / "source-media"
            media.parent.mkdir(parents=True)
            self._write_fixture(media)
            manifest_hash = "a" * 64
            request = self._frame(
                {
                    "jobId": "job-protocol",
                    "manifestHash": manifest_hash,
                    "nonce": "nonce-protocol",
                    "requestId": "request-protocol",
                    "sequence": 0,
                    "type": "start",
                }
            )
            output = io.BytesIO()

            serve_one_session(
                io.BytesIO(request),
                output,
                workspace,
                FrozenRuntime(
                    manifest_hash=manifest_hash,
                    platform_profile="darwin-arm64-test",
                    toolchain=NativeToolchain(Path(ffmpeg), Path(ffprobe)),
                ),
            )

            messages = self._messages(output.getvalue())
            self.assertEqual([message["type"] for message in messages], ["handshake", "result"])
            self.assertEqual(messages[0]["manifestHash"], manifest_hash)
            self.assertEqual(messages[1]["artifact"]["path"], "artifacts/decode-manifest.json")
            self.assertNotIn(b"RIFF", output.getvalue())
            descriptor_path = workspace / messages[1]["artifact"]["path"]
            self.assertEqual(descriptor_path.stat().st_size, messages[1]["artifact"]["byteSize"])

    @staticmethod
    def _write_fixture(path: Path) -> None:
        with wave.open(str(path), "wb") as fixture:
            fixture.setnchannels(1)
            fixture.setsampwidth(2)
            fixture.setframerate(48_000)
            fixture.writeframes(
                b"".join(
                    round(math.sin(index / 11) * 3_000).to_bytes(2, "little", signed=True)
                    for index in range(4_800)
                )
            )

    @staticmethod
    def _frame(message: object) -> bytes:
        payload = json.dumps(message, separators=(",", ":")).encode()
        return struct.pack(">I", len(payload)) + payload

    @staticmethod
    def _messages(frames: bytes) -> list[dict[str, object]]:
        messages: list[dict[str, object]] = []
        cursor = 0
        while cursor < len(frames):
            length = struct.unpack(">I", frames[cursor : cursor + 4])[0]
            cursor += 4
            messages.append(json.loads(frames[cursor : cursor + length]))
            cursor += length
        return messages


if __name__ == "__main__":
    unittest.main()

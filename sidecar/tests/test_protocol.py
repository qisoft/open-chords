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
from sidecar.open_chords_analysis.protocol import FrozenRuntime, ProtocolError, serve_one_session


class FragmentedReader(io.BytesIO):
    def __init__(self, content: bytes, fragment_size: int):
        super().__init__(content)
        self.fragment_size = fragment_size

    def read(self, size: int = -1) -> bytes:
        return super().read(min(size, self.fragment_size))


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
                FragmentedReader(request, 2),
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

    def test_manifest_mismatch_stops_after_the_actual_handshake(self) -> None:
        runtime = FrozenRuntime(
            manifest_hash="b" * 64,
            platform_profile="test",
            toolchain=NativeToolchain(Path("/missing/ffmpeg"), Path("/missing/ffprobe")),
        )
        output = io.BytesIO()

        serve_one_session(
            io.BytesIO(self._start_frame(manifest_hash="a" * 64)),
            output,
            Path.cwd(),
            runtime,
        )

        self.assertEqual(
            self._messages(output.getvalue()),
            [
                {
                    "capabilities": ["analysis", "canonical_decode"],
                    "manifestHash": "b" * 64,
                    "nonce": "nonce-protocol",
                    "protocolVersion": 1,
                    "sequence": 0,
                    "type": "handshake",
                }
            ],
        )

    def test_decode_failure_is_bounded_and_redacted(self) -> None:
        ffmpeg = shutil.which("ffmpeg")
        ffprobe = shutil.which("ffprobe")
        if ffmpeg is None or ffprobe is None:
            self.skipTest("FFmpeg development tools are unavailable")
        with tempfile.TemporaryDirectory(prefix="open-chords-protocol-error-") as temporary:
            workspace = Path(temporary)
            media = workspace / "input" / "source-media"
            media.parent.mkdir(parents=True)
            media.write_bytes(b"not media and /private/path must not leak")
            output = io.BytesIO()

            serve_one_session(
                io.BytesIO(self._start_frame()),
                output,
                workspace,
                FrozenRuntime(
                    manifest_hash="a" * 64,
                    platform_profile="test",
                    toolchain=NativeToolchain(Path(ffmpeg), Path(ffprobe)),
                ),
            )

            messages = self._messages(output.getvalue())
            self.assertEqual([message["type"] for message in messages], ["handshake", "error"])
            self.assertEqual(messages[1]["message"], "Canonical media decode failed")
            self.assertNotIn("private", json.dumps(messages))

    def test_cancel_acknowledges_and_cleans_before_exit(self) -> None:
        ffmpeg = shutil.which("ffmpeg")
        ffprobe = shutil.which("ffprobe")
        if ffmpeg is None or ffprobe is None:
            self.skipTest("FFmpeg development tools are unavailable")
        with tempfile.TemporaryDirectory(prefix="open-chords-protocol-cancel-") as temporary:
            workspace = Path(temporary)
            media = workspace / "input" / "source-media"
            media.parent.mkdir(parents=True)
            self._write_fixture(media)
            cancel = self._frame(
                {
                    "jobId": "job-protocol",
                    "nonce": "nonce-protocol",
                    "requestId": "request-protocol",
                    "sequence": 1,
                    "type": "cancel",
                }
            )
            output = io.BytesIO()

            serve_one_session(
                io.BytesIO(self._start_frame() + cancel),
                output,
                workspace,
                FrozenRuntime(
                    manifest_hash="a" * 64,
                    platform_profile="test",
                    toolchain=NativeToolchain(Path(ffmpeg), Path(ffprobe)),
                ),
            )

            self.assertEqual(
                [message["type"] for message in self._messages(output.getvalue())],
                ["handshake", "cancel_ack", "cleanup_complete"],
            )
            self.assertFalse((workspace / "artifacts/canonical.wav").exists())
            self.assertFalse((workspace / "artifacts/decode-manifest.json").exists())

    def test_rejects_an_oversized_input_frame(self) -> None:
        output = io.BytesIO()
        with self.assertRaisesRegex(ProtocolError, "exceeds one MiB"):
            serve_one_session(
                io.BytesIO(struct.pack(">I", 1024 * 1024 + 1)),
                output,
                Path.cwd(),
                FrozenRuntime(
                    manifest_hash="a" * 64,
                    platform_profile="test",
                    toolchain=NativeToolchain(Path("/missing/ffmpeg"), Path("/missing/ffprobe")),
                ),
            )
        self.assertEqual(output.getvalue(), b"")

    def test_rejects_a_truncated_control_frame(self) -> None:
        ffmpeg = shutil.which("ffmpeg")
        ffprobe = shutil.which("ffprobe")
        if ffmpeg is None or ffprobe is None:
            self.skipTest("FFmpeg development tools are unavailable")
        with tempfile.TemporaryDirectory(prefix="open-chords-protocol-truncated-") as temporary:
            workspace = Path(temporary)
            media = workspace / "input" / "source-media"
            media.parent.mkdir(parents=True)
            self._write_fixture(media)
            output = io.BytesIO()

            with self.assertRaisesRegex(ProtocolError, "complete frame header"):
                serve_one_session(
                    io.BytesIO(self._start_frame() + b"\x00\x01"),
                    output,
                    workspace,
                    FrozenRuntime(
                        manifest_hash="a" * 64,
                        platform_profile="test",
                        toolchain=NativeToolchain(Path(ffmpeg), Path(ffprobe)),
                    ),
                )

            self.assertEqual(
                [message["type"] for message in self._messages(output.getvalue())],
                ["handshake"],
            )

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

    @classmethod
    def _start_frame(cls, manifest_hash: str = "a" * 64) -> bytes:
        return cls._frame(
            {
                "jobId": "job-protocol",
                "manifestHash": manifest_hash,
                "nonce": "nonce-protocol",
                "requestId": "request-protocol",
                "sequence": 0,
                "type": "start",
            }
        )

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

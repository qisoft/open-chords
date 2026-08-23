from __future__ import annotations

import io
import json
import math
import shutil
import struct
import tempfile
import threading
import time
import unittest
import wave
from pathlib import Path
from typing import BinaryIO
from unittest.mock import patch

from sidecar.open_chords_analysis import protocol
from sidecar.open_chords_analysis.canonical_decode import (
    CanonicalDecodeCancelled,
    CanonicalDecodeError,
    CanonicalDecodeFailureCode,
    NativeToolchain,
)
from sidecar.open_chords_analysis.protocol import FrozenRuntime, ProtocolError, serve_one_session


class FragmentedReader(io.BytesIO):
    def __init__(self, content: bytes, fragment_size: int):
        super().__init__(content)
        self.fragment_size = fragment_size

    def read(self, size: int = -1) -> bytes:
        return super().read(min(size, self.fragment_size))


class GatedControlReader(io.BytesIO):
    def __init__(self, start: bytes, control: bytes, gate: threading.Event):
        super().__init__(start + control)
        self.start_length = len(start)
        self.gate = gate
        self.waited = False

    def read(self, size: int = -1) -> bytes:
        if not self.waited and self.tell() >= self.start_length:
            self.waited = True
            if not self.gate.wait(timeout=1):
                raise TimeoutError("heartbeat was not written before cancel input was released")
        return super().read(size)


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
            self.assertEqual(messages[1]["code"], "canonical_probe_failed")
            self.assertEqual(messages[1]["message"], "Canonical media decode failed")
            self.assertNotIn("private", json.dumps(messages))

    def test_unrecognized_decode_failure_code_fails_closed(self) -> None:
        failure = CanonicalDecodeError("sensitive internal failure")
        failure.code = "path-derived-private-code"  # type: ignore[assignment]
        output = io.BytesIO()

        with patch(
            "sidecar.open_chords_analysis.protocol.decode_canonical",
            side_effect=failure,
        ):
            serve_one_session(
                io.BytesIO(self._start_frame()),
                output,
                Path.cwd(),
                FrozenRuntime(
                    manifest_hash="a" * 64,
                    platform_profile="test",
                    toolchain=NativeToolchain(Path("/unused/ffmpeg"), Path("/unused/ffprobe")),
                ),
            )

        messages = self._messages(output.getvalue())
        self.assertEqual(messages[1]["code"], "canonical_decode_failed")
        self.assertEqual(messages[1]["message"], "Canonical media decode failed")
        self.assertNotIn("sensitive", json.dumps(messages))

    def test_cleanup_failure_after_cancel_never_reports_cleanup_complete(self) -> None:
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
        failure = CanonicalDecodeError(
            "internal cleanup failure",
            code=CanonicalDecodeFailureCode.CLEANUP,
        )

        with (
            patch(
                "sidecar.open_chords_analysis.protocol.decode_canonical",
                side_effect=failure,
            ),
            patch(
                "sidecar.open_chords_analysis.protocol._cleanup_decode_artifacts",
                return_value=False,
            ),
        ):
            serve_one_session(
                io.BytesIO(self._start_frame() + cancel),
                output,
                Path.cwd(),
                FrozenRuntime(
                    manifest_hash="a" * 64,
                    platform_profile="test",
                    toolchain=NativeToolchain(Path("/unused/ffmpeg"), Path("/unused/ffprobe")),
                ),
            )

        messages = self._messages(output.getvalue())
        self.assertEqual(
            [message["type"] for message in messages],
            ["handshake", "cancel_ack", "error"],
        )
        self.assertEqual(messages[-1]["code"], "canonical_cleanup_failed")

    def test_cancel_cleanup_unlinks_leaf_symlink_without_touching_target(self) -> None:
        with tempfile.TemporaryDirectory(prefix="open-chords-protocol-symlink-") as temporary:
            root = Path(temporary)
            workspace = root / "workspace"
            artifacts = workspace / "artifacts"
            artifacts.mkdir(parents=True)
            outside = root / "outside.wav"
            outside.write_bytes(b"outside")
            link = artifacts / "canonical.wav"
            try:
                link.symlink_to(outside)
            except OSError as error:
                self.skipTest(f"symbolic links are unavailable: {error.__class__.__name__}")

            messages = self._cancelled_session_messages(workspace)

            self.assertEqual(
                [message["type"] for message in messages],
                ["handshake", "cancel_ack", "cleanup_complete"],
            )
            self.assertFalse(link.exists())
            self.assertFalse(link.is_symlink())
            self.assertEqual(outside.read_bytes(), b"outside")

    def test_cancel_cleanup_rejects_escaping_artifacts_directory(self) -> None:
        with tempfile.TemporaryDirectory(prefix="open-chords-protocol-parent-symlink-") as temporary:
            root = Path(temporary)
            workspace = root / "workspace"
            workspace.mkdir()
            outside = root / "outside"
            outside.mkdir()
            outside_artifact = outside / "canonical.wav"
            outside_artifact.write_bytes(b"outside")
            try:
                (workspace / "artifacts").symlink_to(outside, target_is_directory=True)
            except OSError as error:
                self.skipTest(f"symbolic links are unavailable: {error.__class__.__name__}")

            messages = self._cancelled_session_messages(workspace)

            self.assertEqual(
                [message["type"] for message in messages],
                ["handshake", "cancel_ack", "error"],
            )
            self.assertEqual(messages[-1]["code"], "canonical_cleanup_failed")
            self.assertEqual(outside_artifact.read_bytes(), b"outside")

    def test_cancel_cleanup_maps_inspection_error_to_bounded_failure(self) -> None:
        with tempfile.TemporaryDirectory(prefix="open-chords-protocol-inspection-") as temporary:
            workspace = Path(temporary)
            artifact = workspace / "artifacts/canonical.wav"
            artifact.parent.mkdir()
            artifact.write_bytes(b"artifact")
            original_lstat = Path.lstat

            def deny_artifact_inspection(path: Path, *args: object, **kwargs: object) -> object:
                if path.name == "canonical.wav" and path.parent.name == "artifacts":
                    raise PermissionError("injected inspection denial")
                return original_lstat(path, *args, **kwargs)  # type: ignore[arg-type]

            with patch.object(Path, "lstat", new=deny_artifact_inspection):
                messages = self._cancelled_session_messages(workspace)

            self.assertEqual(
                [message["type"] for message in messages],
                ["handshake", "cancel_ack", "error"],
            )
            self.assertEqual(messages[-1]["code"], "canonical_cleanup_failed")

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

    def test_cancel_remains_valid_when_heartbeats_are_already_in_flight(self) -> None:
        start = self._start_frame()
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
        heartbeat_written = threading.Event()
        write_frame = protocol._write_frame

        def write_and_signal(stream: BinaryIO, message: object) -> None:
            write_frame(stream, message)
            if isinstance(message, dict) and message.get("type") == "heartbeat":
                heartbeat_written.set()

        def wait_for_cancel(*args: object) -> object:
            cancellation = args[-1]
            while not cancellation.is_set():  # type: ignore[union-attr]
                time.sleep(0.001)
            raise CanonicalDecodeCancelled("cancelled by test")

        with (
            patch(
                "sidecar.open_chords_analysis.protocol.HEARTBEAT_INTERVAL_SECONDS",
                0.005,
            ),
            patch(
                "sidecar.open_chords_analysis.protocol.decode_canonical",
                side_effect=wait_for_cancel,
            ),
            patch(
                "sidecar.open_chords_analysis.protocol._write_frame",
                side_effect=write_and_signal,
            ),
        ):
            serve_one_session(
                GatedControlReader(start, cancel, heartbeat_written),
                output,
                Path.cwd(),
                FrozenRuntime(
                    manifest_hash="a" * 64,
                    platform_profile="test",
                    toolchain=NativeToolchain(Path("/unused/ffmpeg"), Path("/unused/ffprobe")),
                ),
            )

        messages = self._messages(output.getvalue())
        types = [message["type"] for message in messages]
        self.assertGreaterEqual(types.count("heartbeat"), 1)
        self.assertEqual(types[-2:], ["cancel_ack", "cleanup_complete"])
        self.assertEqual(
            [message["sequence"] for message in messages],
            list(range(len(messages))),
        )

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

    def test_rejects_boolean_start_and_cancel_sequences(self) -> None:
        boolean_start = self._frame(
            {
                "jobId": "job-protocol",
                "manifestHash": "a" * 64,
                "nonce": "nonce-protocol",
                "requestId": "request-protocol",
                "sequence": False,
                "type": "start",
            }
        )
        runtime = FrozenRuntime(
            manifest_hash="a" * 64,
            platform_profile="test",
            toolchain=NativeToolchain(Path("/unused/ffmpeg"), Path("/unused/ffprobe")),
        )
        with self.assertRaisesRegex(ProtocolError, "invalid sidecar start semantics"):
            serve_one_session(io.BytesIO(boolean_start), io.BytesIO(), Path.cwd(), runtime)

        boolean_cancel = self._frame(
            {
                "jobId": "job-protocol",
                "nonce": "nonce-protocol",
                "requestId": "request-protocol",
                "sequence": True,
                "type": "cancel",
            }
        )

        def wait_for_rejection(*args: object) -> object:
            cancellation = args[-1]
            while not cancellation.is_set():  # type: ignore[union-attr]
                time.sleep(0.001)
            raise CanonicalDecodeCancelled("cancelled by test")

        output = io.BytesIO()
        with patch(
            "sidecar.open_chords_analysis.protocol.decode_canonical",
            side_effect=wait_for_rejection,
        ):
            with self.assertRaisesRegex(ProtocolError, "invalid sidecar cancel semantics"):
                serve_one_session(
                    io.BytesIO(self._start_frame() + boolean_cancel),
                    output,
                    Path.cwd(),
                    runtime,
                )
        self.assertEqual(
            [message["type"] for message in self._messages(output.getvalue())],
            ["handshake"],
        )

    def test_enforces_well_formed_256_byte_identifiers(self) -> None:
        runtime = FrozenRuntime(
            manifest_hash="b" * 64,
            platform_profile="test",
            toolchain=NativeToolchain(Path("/unused/ffmpeg"), Path("/unused/ffprobe")),
        )
        accepted = {
            "jobId": "é" * 128,
            "manifestHash": "a" * 64,
            "nonce": "nonce-protocol",
            "requestId": "request-protocol",
            "sequence": 0,
            "type": "start",
        }
        output = io.BytesIO()
        serve_one_session(self._reader(accepted), output, Path.cwd(), runtime)
        self.assertEqual(
            [message["type"] for message in self._messages(output.getvalue())],
            ["handshake"],
        )

        for invalid_identifier in ("é" * 128 + "a", "é" * 129, "\ud800"):
            rejected = {**accepted, "jobId": invalid_identifier}
            with self.assertRaisesRegex(ProtocolError, "invalid sidecar session identity"):
                serve_one_session(self._reader(rejected), io.BytesIO(), Path.cwd(), runtime)

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

    def _cancelled_session_messages(self, workspace: Path) -> list[dict[str, object]]:
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

        def wait_for_cancel(*args: object) -> object:
            cancellation = args[-1]
            while not cancellation.is_set():  # type: ignore[union-attr]
                time.sleep(0.001)
            raise CanonicalDecodeCancelled("cancelled by cleanup test")

        with patch(
            "sidecar.open_chords_analysis.protocol.decode_canonical",
            side_effect=wait_for_cancel,
        ):
            serve_one_session(
                io.BytesIO(self._start_frame() + cancel),
                output,
                workspace,
                FrozenRuntime(
                    manifest_hash="a" * 64,
                    platform_profile="test",
                    toolchain=NativeToolchain(Path("/unused/ffmpeg"), Path("/unused/ffprobe")),
                ),
            )
        return self._messages(output.getvalue())

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
    def _reader(cls, message: object) -> io.BytesIO:
        return io.BytesIO(cls._frame(message))

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

from __future__ import annotations

import json
import math
import shutil
import sys
import tempfile
import threading
import unittest
import wave
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from sidecar.open_chords_analysis.canonical_decode import (
    CanonicalDecodeConfig,
    CanonicalDecodeCancelled,
    CanonicalDecodeError,
    CanonicalDecodeFailureCode,
    NativeToolchain,
    _probe_audio,
    _sanitize_external_tool_runtime,
    decode_canonical,
)


class CanonicalDecodeTests(unittest.TestCase):
    def test_leaves_the_unfrozen_windows_dll_search_path_unchanged(self) -> None:
        set_dll_directory = unittest.mock.Mock(return_value=1)
        windows_api = SimpleNamespace(
            kernel32=SimpleNamespace(SetDllDirectoryW=set_dll_directory),
        )

        with (
            patch("sidecar.open_chords_analysis.canonical_decode.sys.platform", "win32"),
            patch("sidecar.open_chords_analysis.canonical_decode.sys.frozen", False, create=True),
            patch("sidecar.open_chords_analysis.canonical_decode.ctypes.windll", windows_api, create=True),
        ):
            _sanitize_external_tool_runtime()

        set_dll_directory.assert_not_called()

    def test_sanitizes_the_frozen_windows_dll_search_path(self) -> None:
        set_dll_directory = unittest.mock.Mock(return_value=1)
        windows_api = SimpleNamespace(
            kernel32=SimpleNamespace(SetDllDirectoryW=set_dll_directory),
        )

        with (
            patch("sidecar.open_chords_analysis.canonical_decode.sys.platform", "win32"),
            patch("sidecar.open_chords_analysis.canonical_decode.sys.frozen", True, create=True),
            patch("sidecar.open_chords_analysis.canonical_decode.ctypes.windll", windows_api, create=True),
        ):
            _sanitize_external_tool_runtime()

        set_dll_directory.assert_called_once_with(None)

    def test_fails_closed_when_windows_dll_search_path_cannot_be_sanitized(self) -> None:
        windows_api = SimpleNamespace(
            kernel32=SimpleNamespace(SetDllDirectoryW=unittest.mock.Mock(return_value=0)),
        )

        with (
            patch("sidecar.open_chords_analysis.canonical_decode.sys.platform", "win32"),
            patch("sidecar.open_chords_analysis.canonical_decode.sys.frozen", True, create=True),
            patch("sidecar.open_chords_analysis.canonical_decode.ctypes.windll", windows_api, create=True),
            self.assertRaises(OSError) as raised,
        ):
            _sanitize_external_tool_runtime()

        self.assertEqual(str(raised.exception), "failed to restore the Windows DLL search path")

    def test_probe_arguments_match_frozen_diagnostic_fixture(self) -> None:
        fixture_path = Path("tests/fixtures/canonical-probe-arguments.json")
        expected_arguments = json.loads(fixture_path.read_text("utf-8"))["arguments"]
        ffprobe = Path("/tools/ffprobe")
        input_path = Path("/workspace/input/source-media")

        with patch(
            "sidecar.open_chords_analysis.canonical_decode._run_tool",
        ) as run_tool:
            run_tool.return_value.stdout = b'{"streams":[]}'
            _probe_audio(ffprobe, input_path, threading.Event())

        self.assertEqual(
            run_tool.call_args.args[0],
            [str(ffprobe), *expected_arguments, str(input_path)],
        )

    def test_classifies_probe_execution_failure(self) -> None:
        with (
            patch(
                "sidecar.open_chords_analysis.canonical_decode._run_tool",
                side_effect=OSError("injected native execution failure"),
            ),
            self.assertRaises(CanonicalDecodeError) as raised,
        ):
            _probe_audio(Path("/tools/ffprobe"), Path("/workspace/input/source-media"), threading.Event())

        self.assertEqual(raised.exception.code, CanonicalDecodeFailureCode.PROBE_EXECUTION)

    def test_classifies_invalid_probe_output(self) -> None:
        with (
            patch("sidecar.open_chords_analysis.canonical_decode._run_tool") as run_tool,
            self.assertRaises(CanonicalDecodeError) as raised,
        ):
            run_tool.return_value.stdout = b"not-json"
            _probe_audio(Path("/tools/ffprobe"), Path("/workspace/input/source-media"), threading.Event())

        self.assertEqual(raised.exception.code, CanonicalDecodeFailureCode.PROBE_OUTPUT)

    def test_preserves_missing_probe_stream_taxonomy(self) -> None:
        raised = self._decode_with_probe_output(b'{"streams":[]}')
        self.assertEqual(raised.code, CanonicalDecodeFailureCode.PROBE_STREAM)

    def test_rejects_hostile_probe_stream_shapes(self) -> None:
        malformed_outputs = (
            b"{}",
            b'{"streams":"audio"}',
            b'{"streams":{"unexpected":true}}',
            b'{"streams":[42]}',
            b'{"streams":[{}]}',
            b'{"streams":[{"codec_type":"video"}]}',
            b'{"streams":[{"codec_type":"audio","channels":"2"}]}',
            b'{"streams":[{"codec_type":"audio"},{"codec_type":"audio"}]}',
        )
        for output in malformed_outputs:
            with self.subTest(output=output):
                raised = self._decode_with_probe_output(output)
                self.assertEqual(raised.code, CanonicalDecodeFailureCode.PROBE_OUTPUT)

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

    def test_removes_all_artifacts_when_validation_fails_after_decode(self) -> None:
        ffmpeg = shutil.which("ffmpeg")
        ffprobe = shutil.which("ffprobe")
        if ffmpeg is None or ffprobe is None:
            self.skipTest("FFmpeg development tools are unavailable")

        with tempfile.TemporaryDirectory(prefix="open-chords-decode-failure-") as temporary:
            workspace = Path(temporary)
            media = workspace / "input" / "source-media"
            media.parent.mkdir(parents=True)
            self._write_stereo_fixture(media)

            with patch(
                "sidecar.open_chords_analysis.canonical_decode._inspect_canonical_wav",
                side_effect=RuntimeError("fault after publication"),
            ):
                with self.assertRaises(CanonicalDecodeError) as raised:
                    decode_canonical(
                        workspace,
                        NativeToolchain(Path(ffmpeg), Path(ffprobe)),
                        CanonicalDecodeConfig(platform_profile="test"),
                    )
                self.assertEqual(raised.exception.code, "canonical_artifact_validation_failed")

            for relative in (
                "artifacts/canonical.wav.partial",
                "artifacts/canonical.wav",
                "artifacts/decode-manifest.json.partial",
                "artifacts/decode-manifest.json",
            ):
                self.assertFalse((workspace / relative).exists())

    def test_removes_stale_artifacts_before_rejecting_missing_input(self) -> None:
        with tempfile.TemporaryDirectory(prefix="open-chords-decode-missing-") as temporary:
            workspace = Path(temporary)
            artifacts = workspace / "artifacts"
            artifacts.mkdir()
            for name in (
                "canonical.wav.partial",
                "canonical.wav",
                "decode-manifest.json.partial",
                "decode-manifest.json",
            ):
                (artifacts / name).write_bytes(b"stale")

            with self.assertRaises(CanonicalDecodeError) as raised:
                decode_canonical(
                    workspace,
                    NativeToolchain(Path("/unused/ffmpeg"), Path("/unused/ffprobe")),
                    CanonicalDecodeConfig(platform_profile="test"),
                )
            self.assertEqual(raised.exception.code, "canonical_prepare_failed")

            self.assertEqual(list(artifacts.iterdir()), [])

    def test_reports_missing_tool_as_prepare_failure(self) -> None:
        with tempfile.TemporaryDirectory(prefix="open-chords-decode-tool-") as temporary:
            workspace = Path(temporary)
            media = workspace / "input/source-media"
            media.parent.mkdir(parents=True)
            self._write_stereo_fixture(media)

            with self.assertRaises(CanonicalDecodeError) as raised:
                decode_canonical(
                    workspace,
                    NativeToolchain(Path("/missing/ffmpeg"), Path("/missing/ffprobe")),
                    CanonicalDecodeConfig(platform_profile="test"),
                )

            self.assertEqual(raised.exception.code, "canonical_prepare_failed")

    def test_reports_publication_fault_and_removes_artifacts(self) -> None:
        ffmpeg = shutil.which("ffmpeg")
        ffprobe = shutil.which("ffprobe")
        if ffmpeg is None or ffprobe is None:
            self.skipTest("FFmpeg development tools are unavailable")

        with tempfile.TemporaryDirectory(prefix="open-chords-decode-publication-") as temporary:
            workspace = Path(temporary)
            media = workspace / "input/source-media"
            media.parent.mkdir(parents=True)
            self._write_stereo_fixture(media)

            with patch(
                "sidecar.open_chords_analysis.canonical_decode._write_atomic",
                side_effect=OSError("injected publication fault"),
            ):
                with self.assertRaises(CanonicalDecodeError) as raised:
                    decode_canonical(
                        workspace,
                        NativeToolchain(Path(ffmpeg), Path(ffprobe)),
                        CanonicalDecodeConfig(platform_profile="test"),
                    )

            self.assertEqual(raised.exception.code, "canonical_publication_failed")
            self.assertFalse((workspace / "artifacts/canonical.wav").exists())
            self.assertFalse((workspace / "artifacts/decode-manifest.json").exists())

    def test_reports_transcode_fault(self) -> None:
        with tempfile.TemporaryDirectory(prefix="open-chords-decode-transcode-") as temporary:
            workspace = Path(temporary)
            media = workspace / "input/source-media"
            media.parent.mkdir(parents=True)
            self._write_stereo_fixture(media)

            with (
                patch(
                    "sidecar.open_chords_analysis.canonical_decode._probe_audio",
                    return_value={"streams": [{"codec_type": "audio"}]},
                ),
                patch(
                    "sidecar.open_chords_analysis.canonical_decode._run_tool",
                    side_effect=OSError("injected transcode fault"),
                ),
            ):
                with self.assertRaises(CanonicalDecodeError) as raised:
                    decode_canonical(
                        workspace,
                        NativeToolchain(Path(sys.executable), Path(sys.executable)),
                        CanonicalDecodeConfig(platform_profile="test"),
                    )

            self.assertEqual(raised.exception.code, "canonical_transcode_failed")

    def test_reports_tool_identity_fault(self) -> None:
        ffmpeg = shutil.which("ffmpeg")
        ffprobe = shutil.which("ffprobe")
        if ffmpeg is None or ffprobe is None:
            self.skipTest("FFmpeg development tools are unavailable")

        with tempfile.TemporaryDirectory(prefix="open-chords-decode-identity-") as temporary:
            workspace = Path(temporary)
            media = workspace / "input/source-media"
            media.parent.mkdir(parents=True)
            self._write_stereo_fixture(media)

            with patch(
                "sidecar.open_chords_analysis.canonical_decode._tool_identity",
                side_effect=OSError("injected identity fault"),
            ):
                with self.assertRaises(CanonicalDecodeError) as raised:
                    decode_canonical(
                        workspace,
                        NativeToolchain(Path(ffmpeg), Path(ffprobe)),
                        CanonicalDecodeConfig(platform_profile="test"),
                    )

            self.assertEqual(raised.exception.code, "canonical_tool_identity_failed")

    def test_cleanup_failure_attempts_every_artifact_and_replaces_cancellation(self) -> None:
        cancellation = threading.Event()
        attempted_after_cancellation: list[str] = []
        original_unlink = Path.unlink

        def cancel_during_probe(*_args: object, **_kwargs: object) -> object:
            cancellation.set()
            raise CanonicalDecodeCancelled("injected cancellation")

        def fail_one_cleanup(path: Path, *args: object, **kwargs: object) -> None:
            if cancellation.is_set():
                attempted_after_cancellation.append(path.name)
                if path.name == "canonical.wav":
                    raise PermissionError("injected cleanup denial")
            original_unlink(path, *args, **kwargs)  # type: ignore[arg-type]

        with tempfile.TemporaryDirectory(prefix="open-chords-decode-cleanup-") as temporary:
            workspace = Path(temporary)
            media = workspace / "input/source-media"
            media.parent.mkdir(parents=True)
            self._write_stereo_fixture(media)

            with (
                patch(
                    "sidecar.open_chords_analysis.canonical_decode._probe_audio",
                    side_effect=cancel_during_probe,
                ),
                patch.object(Path, "unlink", new=fail_one_cleanup),
            ):
                with self.assertRaises(CanonicalDecodeError) as raised:
                    decode_canonical(
                        workspace,
                        NativeToolchain(Path(sys.executable), Path(sys.executable)),
                        CanonicalDecodeConfig(platform_profile="test"),
                        cancellation,
                    )

            self.assertEqual(raised.exception.code, CanonicalDecodeFailureCode.CLEANUP)
            self.assertEqual(
                set(attempted_after_cancellation),
                {
                    "canonical.wav.partial",
                    "canonical.wav",
                    "decode-manifest.json.partial",
                    "decode-manifest.json",
                },
            )

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

    def _decode_with_probe_output(self, output: bytes) -> CanonicalDecodeError:
        with tempfile.TemporaryDirectory(prefix="open-chords-decode-probe-") as temporary:
            workspace = Path(temporary)
            media = workspace / "input/source-media"
            media.parent.mkdir(parents=True)
            self._write_stereo_fixture(media)

            with (
                patch("sidecar.open_chords_analysis.canonical_decode._run_tool") as run_tool,
                self.assertRaises(CanonicalDecodeError) as raised,
            ):
                run_tool.return_value.stdout = output
                decode_canonical(
                    workspace,
                    NativeToolchain(Path(sys.executable), Path(sys.executable)),
                    CanonicalDecodeConfig(platform_profile="test"),
                )
        return raised.exception


if __name__ == "__main__":
    unittest.main()

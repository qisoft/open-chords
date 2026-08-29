from __future__ import annotations

import io
import json
import math
import shutil
import subprocess
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
    _NativeToolExitError,
    _NativeToolCleanupError,
    _NativeToolOutputLimitError,
    _NativeToolTimeoutError,
    _exact_executable,
    _probe_audio,
    _run_tool,
    _sanitize_external_tool_runtime,
    decode_canonical,
)


class CanonicalDecodeTests(unittest.TestCase):
    def test_manifest_verified_tool_reuses_the_runtime_path_proof(self) -> None:
        with tempfile.TemporaryDirectory(prefix="open-chords-verified-tool-") as temporary:
            runtime_root = Path(temporary)
            tool = runtime_root / "tools" / "ffmpeg.exe"
            tool.parent.mkdir()
            tool.write_bytes(b"tool")

            with patch.object(
                Path,
                "resolve",
                side_effect=AssertionError("must not resolve a verified tool again"),
            ) as resolve:
                self.assertEqual(_exact_executable(tool, runtime_root), tool)

            resolve.assert_not_called()

    def test_native_tools_receive_eof_without_opening_the_null_device(self) -> None:
        stdin = io.BytesIO()
        process = SimpleNamespace(
            kill=unittest.mock.Mock(),
            stdin=stdin,
            stderr=io.BytesIO(),
            stdout=io.BytesIO(),
            wait=unittest.mock.Mock(return_value=0),
        )
        with patch(
            "sidecar.open_chords_analysis.canonical_decode.subprocess.Popen",
            return_value=process,
        ) as launch:
            _run_tool([sys.executable, "-V"], threading.Event())

        self.assertIs(launch.call_args.kwargs["stdin"], subprocess.PIPE)
        self.assertTrue(stdin.closed)

    def test_reaps_native_process_when_delivering_stdin_eof_fails(self) -> None:
        stdin = SimpleNamespace(
            close=unittest.mock.Mock(
                side_effect=[OSError("injected stdin close failure"), None],
            ),
        )
        stdout = io.BytesIO()
        stderr = io.BytesIO()
        process = SimpleNamespace(
            kill=unittest.mock.Mock(),
            stdin=stdin,
            stderr=stderr,
            stdout=stdout,
            wait=unittest.mock.Mock(return_value=0),
        )
        with (
            patch("sidecar.open_chords_analysis.canonical_decode.subprocess.Popen", return_value=process),
            self.assertRaisesRegex(OSError, "stdin close failure"),
        ):
            _run_tool([sys.executable, "-V"], threading.Event())

        process.kill.assert_called_once_with()
        process.wait.assert_called_once_with(timeout=1)
        self.assertEqual(stdin.close.call_count, 2)
        self.assertTrue(stdout.closed)
        self.assertTrue(stderr.closed)

    def test_cancellation_survives_kill_race_after_successful_reap(self) -> None:
        process = SimpleNamespace(
            kill=unittest.mock.Mock(side_effect=ProcessLookupError("already exited")),
            stderr=io.BytesIO(),
            stdout=io.BytesIO(),
            wait=unittest.mock.Mock(return_value=0),
        )
        cancellation = unittest.mock.Mock()
        cancellation.is_set.side_effect = [False, True]
        with (
            patch("sidecar.open_chords_analysis.canonical_decode.subprocess.Popen", return_value=process),
            self.assertRaises(CanonicalDecodeCancelled),
        ):
            _run_tool([sys.executable, "-V"], cancellation)

        process.wait.assert_called_once_with(timeout=1)

    def test_timeout_survives_kill_race_after_successful_reap(self) -> None:
        process = SimpleNamespace(
            kill=unittest.mock.Mock(side_effect=ProcessLookupError("already exited")),
            stderr=io.BytesIO(),
            stdout=io.BytesIO(),
            wait=unittest.mock.Mock(return_value=0),
        )
        with (
            patch("sidecar.open_chords_analysis.canonical_decode.subprocess.Popen", return_value=process),
            patch("sidecar.open_chords_analysis.canonical_decode.time.monotonic", side_effect=[0, 31]),
            self.assertRaises(_NativeToolTimeoutError),
        ):
            _run_tool([sys.executable, "-V"], threading.Event())

        process.wait.assert_called_once_with(timeout=1)

    def test_reaps_native_process_when_reader_construction_fails(self) -> None:
        stdout = io.BytesIO()
        stderr = io.BytesIO()
        process = SimpleNamespace(
            kill=unittest.mock.Mock(),
            stderr=stderr,
            stdout=stdout,
            wait=unittest.mock.Mock(return_value=0),
        )
        with (
            patch("sidecar.open_chords_analysis.canonical_decode.subprocess.Popen", return_value=process),
            patch(
                "sidecar.open_chords_analysis.canonical_decode.threading.Thread",
                side_effect=RuntimeError("injected reader construction failure"),
            ),
            self.assertRaises(RuntimeError),
        ):
            _run_tool([sys.executable, "-V"], threading.Event())

        process.kill.assert_called_once_with()
        process.wait.assert_called_once_with(timeout=1)
        self.assertTrue(stdout.closed)
        self.assertTrue(stderr.closed)

    def test_cancellation_uses_only_bounded_reap_attempts(self) -> None:
        process = SimpleNamespace(
            kill=unittest.mock.Mock(),
            stderr=io.BytesIO(),
            stdout=io.BytesIO(),
            wait=unittest.mock.Mock(
                side_effect=[subprocess.TimeoutExpired("ffprobe", 1), 0],
            ),
        )
        cancellation = unittest.mock.Mock()
        cancellation.is_set.side_effect = [False, True]
        with (
            patch("sidecar.open_chords_analysis.canonical_decode.subprocess.Popen", return_value=process),
            self.assertRaises(CanonicalDecodeCancelled),
        ):
            _run_tool([sys.executable, "-V"], cancellation)

        self.assertEqual(process.kill.call_count, 2)
        self.assertEqual(process.wait.call_count, 2)
        self.assertTrue(all(call.kwargs == {"timeout": 1} for call in process.wait.call_args_list))

    def test_timeout_uses_only_a_bounded_reap(self) -> None:
        process = SimpleNamespace(
            kill=unittest.mock.Mock(),
            stderr=io.BytesIO(),
            stdout=io.BytesIO(),
            wait=unittest.mock.Mock(return_value=0),
        )
        with (
            patch("sidecar.open_chords_analysis.canonical_decode.subprocess.Popen", return_value=process),
            patch("sidecar.open_chords_analysis.canonical_decode.time.monotonic", side_effect=[0, 31]),
            self.assertRaises(_NativeToolTimeoutError),
        ):
            _run_tool([sys.executable, "-V"], threading.Event())

        process.kill.assert_called_once_with()
        process.wait.assert_called_once_with(timeout=1)

    def test_cleanup_attempts_every_action_after_kill_and_wait_errors(self) -> None:
        stdout = SimpleNamespace(
            close=unittest.mock.Mock(side_effect=OSError("injected stdout close failure")),
            read=unittest.mock.Mock(return_value=b""),
        )
        stderr = SimpleNamespace(
            close=unittest.mock.Mock(side_effect=OSError("injected stderr close failure")),
            read=unittest.mock.Mock(return_value=b""),
        )
        process = SimpleNamespace(
            kill=unittest.mock.Mock(side_effect=OSError("injected kill failure")),
            stderr=stderr,
            stdout=stdout,
            wait=unittest.mock.Mock(side_effect=OSError("injected reap failure")),
        )
        with (
            patch("sidecar.open_chords_analysis.canonical_decode.subprocess.Popen", return_value=process),
            patch(
                "sidecar.open_chords_analysis.canonical_decode.threading.Thread.start",
                side_effect=RuntimeError("injected reader start failure"),
            ),
            self.assertRaisesRegex(RuntimeError, "reader start failure") as raised,
        ):
            _run_tool([sys.executable, "-V"], threading.Event())

        self.assertIsInstance(raised.exception.__cause__, _NativeToolCleanupError)
        self.assertEqual(process.kill.call_count, 2)
        self.assertEqual(process.wait.call_count, 2)
        stdout.close.assert_called_once_with()
        stderr.close.assert_called_once_with()

    def test_cleanup_closes_every_pipe_after_reader_join_error(self) -> None:
        stdout = io.BytesIO()
        stderr = io.BytesIO()
        process = SimpleNamespace(
            kill=unittest.mock.Mock(),
            stderr=stderr,
            stdout=stdout,
            wait=unittest.mock.Mock(return_value=0),
        )
        with (
            patch("sidecar.open_chords_analysis.canonical_decode.subprocess.Popen", return_value=process),
            patch(
                "sidecar.open_chords_analysis.canonical_decode.threading.Thread.join",
                side_effect=RuntimeError("injected reader join failure"),
            ),
            self.assertRaises(_NativeToolCleanupError),
        ):
            _run_tool([sys.executable, "-V"], threading.Event())

        self.assertTrue(stdout.closed)
        self.assertTrue(stderr.closed)

    def test_reaps_native_process_when_reader_start_fails(self) -> None:
        process = SimpleNamespace(
            kill=unittest.mock.Mock(),
            stderr=io.BytesIO(),
            stdout=io.BytesIO(),
            wait=unittest.mock.Mock(return_value=0),
        )
        with (
            patch("sidecar.open_chords_analysis.canonical_decode.subprocess.Popen", return_value=process),
            patch(
                "sidecar.open_chords_analysis.canonical_decode.threading.Thread.start",
                side_effect=RuntimeError("injected reader start failure"),
            ),
            self.assertRaises(RuntimeError),
        ):
            _run_tool([sys.executable, "-V"], threading.Event())

        process.kill.assert_called_once_with()
        process.wait.assert_called_once_with(timeout=1)

    def test_reaps_native_process_when_wait_fails(self) -> None:
        process = SimpleNamespace(
            kill=unittest.mock.Mock(),
            stderr=io.BytesIO(),
            stdout=io.BytesIO(),
            wait=unittest.mock.Mock(side_effect=[RuntimeError("injected wait failure"), 0]),
        )
        with (
            patch("sidecar.open_chords_analysis.canonical_decode.subprocess.Popen", return_value=process),
            self.assertRaises(RuntimeError),
        ):
            _run_tool([sys.executable, "-V"], threading.Event())

        process.kill.assert_called_once_with()
        self.assertEqual(process.wait.call_count, 2)
        self.assertEqual(process.wait.call_args_list[-1], unittest.mock.call(timeout=1))

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
        fixture_path = Path(__file__).resolve().parents[2] / "tests/fixtures/canonical-probe-arguments.json"
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

    def test_classifies_probe_runtime_failure(self) -> None:
        with (
            patch(
                "sidecar.open_chords_analysis.canonical_decode._sanitize_external_tool_runtime",
                side_effect=OSError("injected runtime preparation failure"),
            ),
            self.assertRaises(CanonicalDecodeError) as raised,
        ):
            _probe_audio(Path(sys.executable), Path("/workspace/input/source-media"), threading.Event())

        self.assertEqual(raised.exception.code, CanonicalDecodeFailureCode.PROBE_RUNTIME)

    def test_classifies_probe_spawn_failure(self) -> None:
        with (
            patch(
                "sidecar.open_chords_analysis.canonical_decode.subprocess.Popen",
                side_effect=OSError("injected process spawn failure"),
            ),
            self.assertRaises(CanonicalDecodeError) as raised,
        ):
            _probe_audio(Path(sys.executable), Path("/workspace/input/source-media"), threading.Event())

        self.assertEqual(raised.exception.code, CanonicalDecodeFailureCode.PROBE_SPAWN)

    def test_classifies_probe_process_failure(self) -> None:
        with (
            patch(
                "sidecar.open_chords_analysis.canonical_decode._run_tool",
                side_effect=CanonicalDecodeError("injected nonzero process outcome"),
            ),
            self.assertRaises(CanonicalDecodeError) as raised,
        ):
            _probe_audio(Path("/tools/ffprobe"), Path("/workspace/input/source-media"), threading.Event())

        self.assertEqual(raised.exception.code, CanonicalDecodeFailureCode.PROBE_PROCESS)

    def test_classifies_probe_process_outcomes(self) -> None:
        cases = (
            (_NativeToolTimeoutError("injected timeout"), CanonicalDecodeFailureCode.PROBE_TIMEOUT),
            (
                _NativeToolOutputLimitError("injected output limit"),
                CanonicalDecodeFailureCode.PROBE_OUTPUT_LIMIT,
            ),
            (_NativeToolExitError(1), CanonicalDecodeFailureCode.PROBE_EXIT),
            (
                _NativeToolExitError(0xC000007B),
                CanonicalDecodeFailureCode.PROBE_LOADER_INVALID_IMAGE,
            ),
            (
                _NativeToolExitError(0xC0000135),
                CanonicalDecodeFailureCode.PROBE_LOADER_MISSING,
            ),
            (
                _NativeToolExitError(-1073741515),
                CanonicalDecodeFailureCode.PROBE_LOADER_MISSING,
            ),
            (
                _NativeToolExitError(0xC0000139),
                CanonicalDecodeFailureCode.PROBE_LOADER_SYMBOL,
            ),
            (
                _NativeToolExitError(0xC0000142),
                CanonicalDecodeFailureCode.PROBE_LOADER_INIT,
            ),
        )
        for failure, expected in cases:
            with (
                self.subTest(failure=failure),
                patch(
                    "sidecar.open_chords_analysis.canonical_decode._run_tool",
                    side_effect=failure,
                ),
                self.assertRaises(CanonicalDecodeError) as raised,
            ):
                _probe_audio(
                    Path("/tools/ffprobe"),
                    Path("/workspace/input/source-media"),
                    threading.Event(),
                )
            self.assertEqual(raised.exception.code, expected)

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
            b'{"streams":[],"unexpected":"private"}',
            b'{"programs":[{}],"streams":[]}',
            b'{"stream_groups":{},"streams":[]}',
            b'{"streams":"audio"}',
            b'{"streams":{"unexpected":true}}',
            b'{"streams":[42]}',
            b'{"streams":[{}]}',
            b'{"streams":[{"codec_type":"video"}]}',
            b'{"streams":[{"codec_type":"audio","unexpected":"private"}]}',
            b'{"streams":[{"codec_type":"audio","sample_rate":"garbage"}]}',
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
            self.assertEqual(raised.exception.code, "canonical_prepare_input_failed")

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

            self.assertEqual(raised.exception.code, "canonical_prepare_tools_failed")

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

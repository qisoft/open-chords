import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import unittest
from unittest import mock

from sidecar.open_chords_analysis.containment_probe import (
    _descriptor_is_control_channel,
    _environment_redirect_matches,
    _normalized_path_is_within,
    _process_escape_cannot_reach_host,
    _runtime_mutation_evidence,
    _runtime_mutation_blocked,
    _windows_helper_permission_denial,
    run_probe,
)


class ContainmentProbeTests(unittest.TestCase):
    def test_bounds_windows_helper_permission_diagnostics(self) -> None:
        helper = Path("runtime") / "tools" / "ffprobe.exe"
        with mock.patch(
            "sidecar.open_chords_analysis.containment_probe._can_read", return_value=False
        ):
            self.assertEqual(
                _windows_helper_permission_denial(helper),
                "permission_denied_unreadable",
            )
        with (
            mock.patch(
                "sidecar.open_chords_analysis.containment_probe._can_read", return_value=True
            ),
            mock.patch(
                "sidecar.open_chords_analysis.containment_probe.subprocess.run",
                side_effect=PermissionError,
            ),
            mock.patch(
                "sidecar.open_chords_analysis.containment_probe._windows_child_process_restricted",
                return_value=True,
            ),
        ):
            self.assertEqual(
                _windows_helper_permission_denial(helper),
                "permission_denied_child_policy",
            )
        with (
            mock.patch(
                "sidecar.open_chords_analysis.containment_probe._can_read", return_value=True
            ),
            mock.patch(
                "sidecar.open_chords_analysis.containment_probe.subprocess.run",
                side_effect=PermissionError,
            ),
            mock.patch(
                "sidecar.open_chords_analysis.containment_probe._windows_child_process_restricted",
                return_value=False,
            ),
        ):
            self.assertEqual(
                _windows_helper_permission_denial(helper), "permission_denied_child_image"
            )
        child_run = mock.Mock(return_value=subprocess.CompletedProcess([], 0))
        with (
            mock.patch(
                "sidecar.open_chords_analysis.containment_probe._can_read", return_value=True
            ),
            mock.patch(
                "sidecar.open_chords_analysis.containment_probe.subprocess.run",
                child_run,
            ),
        ):
            self.assertEqual(
                _windows_helper_permission_denial(helper), "permission_denied_image"
            )
        self.assertIs(child_run.call_args.kwargs["stdin"], subprocess.PIPE)
        self.assertIs(child_run.call_args.kwargs["stdout"], subprocess.PIPE)
        self.assertIs(child_run.call_args.kwargs["stderr"], subprocess.PIPE)

    def test_disabled_runtime_mutation_probe_leaves_installed_runtime_unchanged(self) -> None:
        with tempfile.TemporaryDirectory(prefix="open-chords-runtime-probe-test-") as temporary:
            runtime_root = Path(temporary)
            manifest = runtime_root / "runtime-manifest.json"
            manifest.write_bytes(b"signed-runtime")

            self.assertEqual(_runtime_mutation_evidence(runtime_root, enabled=False), {})
            self.assertEqual(manifest.read_bytes(), b"signed-runtime")
            self.assertFalse((runtime_root / ".containment-write-probe").exists())

    def test_runtime_mutation_requires_an_access_denial(self) -> None:
        self.assertTrue(
            _runtime_mutation_blocked(
                mock.Mock(side_effect=PermissionError("runtime is read-only"))
            )
        )
        self.assertFalse(
            _runtime_mutation_blocked(mock.Mock(side_effect=OSError("unexpected failure")))
        )
        self.assertFalse(_runtime_mutation_blocked(mock.Mock(return_value=None)))

    def test_windows_remapped_environment_stays_inside_disposable_profile(self) -> None:
        workspace = Path("profile") / "AC" / "jobs" / "job"
        remapped = workspace.parents[1] / "TempState"

        with mock.patch("sidecar.open_chords_analysis.containment_probe.os.name", "nt"):
            for name in ("LOCALAPPDATA", "TEMP", "TMP"):
                self.assertTrue(
                    _environment_redirect_matches(name, remapped, workspace, workspace)
                )
                self.assertFalse(
                    _environment_redirect_matches(
                        name, workspace.parents[2] / "host-temp", workspace, workspace
                    )
                )
            self.assertFalse(
                _environment_redirect_matches("APPDATA", remapped, workspace, workspace)
            )

    def test_lexical_containment_rejects_siblings_and_parent_traversal(self) -> None:
        root = Path("profile") / "AC"

        self.assertTrue(_normalized_path_is_within(root / "LocalCache" / "Local", root))
        self.assertFalse(_normalized_path_is_within(root.parent / "host-data", root))
        self.assertFalse(_normalized_path_is_within(root / "jobs" / ".." / "..", root))

    def test_process_escape_requires_specific_non_breakaway_evidence(self) -> None:
        plan = Path("unused-plan.json")
        with mock.patch(
            "sidecar.open_chords_analysis.containment_probe.subprocess.run",
            side_effect=subprocess.TimeoutExpired("probe", 1),
        ):
            self.assertFalse(_process_escape_cannot_reach_host(plan))
        with mock.patch(
            "sidecar.open_chords_analysis.containment_probe.subprocess.run",
            side_effect=OSError("unrelated spawn failure"),
        ):
            self.assertFalse(_process_escape_cannot_reach_host(plan))

        access_denied = OSError("job denied breakaway")
        access_denied.winerror = 5
        with (
            mock.patch("sidecar.open_chords_analysis.containment_probe.os.name", "nt"),
            mock.patch(
                "sidecar.open_chords_analysis.containment_probe.subprocess.run",
                side_effect=access_denied,
            ),
        ):
            self.assertTrue(_process_escape_cannot_reach_host(plan))

    def test_distinguishes_a_control_channel_from_a_reused_regular_fd(self) -> None:
        with mock.patch(
            "sidecar.open_chords_analysis.containment_probe.os.fstat"
        ) as descriptor_stat:
            descriptor_stat.return_value.st_mode = stat.S_IFREG
            self.assertFalse(_descriptor_is_control_channel(3))
            descriptor_stat.return_value.st_mode = stat.S_IFIFO
            self.assertTrue(_descriptor_is_control_channel(3))
            descriptor_stat.side_effect = OSError
            self.assertFalse(_descriptor_is_control_channel(3))

    def test_detects_file_and_network_access_without_native_containment(self) -> None:
        with tempfile.TemporaryDirectory(prefix="open-chords-probe-test-") as temporary:
            root = Path(temporary)
            sentinel = root / "sentinel"
            sentinel.write_text("private", "utf-8")
            plan = root / "plan.json"
            plan.write_text(
                json.dumps(
                    {
                        "loopbackPort": 9,
                        "linkEscapePreflightBlocked": False,
                        "sensitiveLinkPaths": {
                            name: str(sentinel)
                            for name in (
                                "browserState",
                                "credentials",
                                "modelStore",
                                "projectLibrary",
                                "source",
                            )
                        },
                        "sensitivePaths": {
                            "browserState": str(sentinel),
                            "credentials": str(sentinel),
                            "modelStore": str(sentinel),
                            "projectLibrary": str(sentinel),
                            "source": str(sentinel),
                        },
                    }
                ),
                "utf-8",
            )
            previous = Path.cwd()
            try:
                os.chdir(root)
                with mock.patch(
                    "sidecar.open_chords_analysis.containment_probe.socket.create_connection"
                ) as connect:
                    result = run_probe(plan)
                    connect.assert_called_once_with(("127.0.0.1", 9), timeout=1)
            finally:
                os.chdir(previous)
            self.assertIs(result["pathBlocked"], False)
            self.assertIs(result["networkBlocked"], False)
            self.assertIs(result["linkEscapeBlocked"], False)
            self.assertIs(result["shellEscapeBlocked"], False)
            expected_redirects = (
                {"APPDATA", "HOME", "LOCALAPPDATA", "TEMP", "TMP", "USERPROFILE"}
                if os.name == "nt"
                else {"HOME", "TMPDIR"}
            )
            self.assertEqual(set(result["environmentRedirects"]), expected_redirects)
            self.assertTrue(
                all(value is False for value in result["sensitivePathsBlocked"].values())
            )


if __name__ == "__main__":
    unittest.main()

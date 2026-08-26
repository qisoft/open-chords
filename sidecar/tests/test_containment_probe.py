import json
from pathlib import Path
import stat
import subprocess
import tempfile
import unittest
from unittest import mock

from sidecar.open_chords_analysis.containment_probe import (
    _descriptor_is_control_channel,
    _process_escape_cannot_reach_host,
    run_probe,
)


class ContainmentProbeTests(unittest.TestCase):
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
                import os

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
            self.assertTrue(
                all(value is False for value in result["sensitivePathsBlocked"].values())
            )


if __name__ == "__main__":
    unittest.main()

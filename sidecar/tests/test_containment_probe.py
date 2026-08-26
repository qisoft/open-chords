import json
from pathlib import Path
import stat
import tempfile
import unittest
from unittest import mock

from sidecar.open_chords_analysis.containment_probe import (
    _descriptor_is_control_channel,
    run_probe,
)


class ContainmentProbeTests(unittest.TestCase):
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
                json.dumps({"loopbackPort": 9, "sentinelPath": str(sentinel)}),
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


if __name__ == "__main__":
    unittest.main()

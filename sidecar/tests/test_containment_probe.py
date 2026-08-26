import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from sidecar.open_chords_analysis.containment_probe import run_probe


class ContainmentProbeTests(unittest.TestCase):
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

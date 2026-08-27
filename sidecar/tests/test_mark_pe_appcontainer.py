import importlib.util
from pathlib import Path
import struct
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[2] / "tools/mark-pe-appcontainer.py"
SPEC = importlib.util.spec_from_file_location("mark_pe_appcontainer", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class MarkPeAppContainerTests(unittest.TestCase):
    def test_marks_a_pe32_plus_binary_and_preserves_existing_flags(self) -> None:
        data = bytearray(256)
        data[:2] = b"MZ"
        struct.pack_into("<I", data, 0x3C, 0x80)
        data[0x80:0x84] = b"PE\0\0"
        struct.pack_into("<H", data, 0x98, MODULE.PE32_PLUS_MAGIC)
        struct.pack_into("<H", data, 0xDE, 0x0140)
        with tempfile.TemporaryDirectory() as temporary:
            executable = Path(temporary) / "ffprobe.exe"
            executable.write_bytes(data)
            MODULE.mark_appcontainer(executable)
            marked = executable.read_bytes()

        self.assertEqual(struct.unpack_from("<H", marked, 0xDE)[0], 0x1140)

    def test_rejects_malformed_input_without_rewriting_it(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            executable = Path(temporary) / "ffprobe.exe"
            executable.write_bytes(b"not a PE")
            with self.assertRaisesRegex(ValueError, "invalid DOS header"):
                MODULE.mark_appcontainer(executable)
            self.assertEqual(executable.read_bytes(), b"not a PE")


if __name__ == "__main__":
    unittest.main()

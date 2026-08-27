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
    def test_build_marks_the_complete_pe_closure_before_provenance_hashes(self) -> None:
        build_script = (SCRIPT.parent / "build-ffmpeg.sh").read_text("utf-8")
        version_capture = build_script.index('"${install_root}/bin/ffmpeg" -version')
        runtime_closure = build_script.index('appcontainer_pe_files+=("${install_root}/bin/${runtime_dll}")')
        marker = build_script.index('"${appcontainer_pe_files[@]}"')
        provenance_hash = build_script.index('runtime_sha256="$(shasum')

        self.assertLess(version_capture, runtime_closure)
        self.assertLess(runtime_closure, marker)
        self.assertLess(marker, provenance_hash)

    def test_marks_a_pe32_plus_binary_and_preserves_existing_flags(self) -> None:
        data = bytearray(320)
        data[:2] = b"MZ"
        struct.pack_into("<I", data, 0x3C, 0x80)
        data[0x80:0x84] = b"PE\0\0"
        struct.pack_into("<H", data, 0x94, 0x70)
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

    def test_rejects_invalid_optional_header_bounds_without_rewriting(self) -> None:
        for optional_size, file_size in ((0x47, 256), (0x70, 200)):
            data = bytearray(file_size)
            data[:2] = b"MZ"
            struct.pack_into("<I", data, 0x3C, 0x80)
            data[0x80:0x84] = b"PE\0\0"
            struct.pack_into("<H", data, 0x94, optional_size)
            struct.pack_into("<H", data, 0x98, MODULE.PE32_PLUS_MAGIC)
            with tempfile.TemporaryDirectory() as temporary:
                executable = Path(temporary) / "ffprobe.exe"
                executable.write_bytes(data)
                with self.assertRaisesRegex(ValueError, "invalid PE optional header size"):
                    MODULE.mark_appcontainer(executable)
                self.assertEqual(executable.read_bytes(), data)


if __name__ == "__main__":
    unittest.main()

"""License discovery beside the exact Python/PyInstaller build inputs."""
import importlib.metadata
import sys
import sysconfig
from pathlib import Path

def _python_license() -> Path:
    return _find_python_license(
        Path(sys.executable).resolve(),
        Path(sysconfig.get_path("stdlib")),
    )


def _pyinstaller_license(distribution: importlib.metadata.Distribution) -> Path:
    license_file = next(
        (
            file
            for file in distribution.files or []
            if file.name == "COPYING.txt" and "licenses" in file.parts
        ),
        None,
    )
    if license_file is None:
        raise FileNotFoundError("PyInstaller COPYING.txt was not found in distribution metadata")
    return license_file


def _find_python_license(executable: Path, stdlib: Path) -> Path:
    stdlib_license = stdlib / "LICENSE.txt"
    if stdlib_license.is_file():
        return stdlib_license
    for parent in executable.parents:
        for name in ("LICENSE", "LICENSE.txt"):
            candidate = parent / name
            if candidate.is_file():
                return candidate
    raise FileNotFoundError("CPython LICENSE was not found beside the exact build interpreter")



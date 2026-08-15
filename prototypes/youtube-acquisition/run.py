"""One-command bootstrap for the throwaway prototype."""

from __future__ import annotations

import os
from pathlib import Path
import subprocess
import sys


ROOT = Path(__file__).resolve().parent
VENV = ROOT / ".prototype-venv"


def main() -> None:
    active = Path(sys.prefix).resolve() == VENV.resolve()
    if not active:
        python = VENV / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
        if not python.exists():
            subprocess.run([sys.executable, "-m", "venv", str(VENV)], check=True)
        subprocess.run([
            str(python), "-m", "pip", "install", "--disable-pip-version-check",
            "-r", str(ROOT / "requirements.txt"),
        ], check=True)
        os.execv(str(python), [str(python), str(ROOT / "prototype.py"), *sys.argv[1:]])
    os.execv(sys.executable, [sys.executable, str(ROOT / "prototype.py"), *sys.argv[1:]])


if __name__ == "__main__":
    main()

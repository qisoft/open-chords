"""Workspace-confined Numba cache locator for the frozen sidecar."""

from __future__ import annotations

import hashlib
import os
from pathlib import Path
import sys


class FrozenWorkspaceCacheLocator:
    """Locate frozen JIT cache entries without HOME or source-file access."""

    def __init__(self, py_func: object, py_file: str) -> None:
        code = getattr(py_func, "__code__")
        self._line = int(code.co_firstlineno)
        source_group = hashlib.sha256(py_file.encode("utf-8")).hexdigest()[:16]
        self._cache_path = Path.cwd() / "checkpoints" / "numba-cache" / source_group

    @classmethod
    def from_function(
        cls, py_func: object, py_file: str
    ) -> FrozenWorkspaceCacheLocator | None:
        if not getattr(sys, "frozen", False):
            return None
        locator = cls(py_func, py_file)
        locator._cache_path.mkdir(parents=True, exist_ok=True)
        return locator

    def get_cache_path(self) -> str:
        return os.fspath(self._cache_path)

    def ensure_cache_path(self) -> None:
        self._cache_path.mkdir(parents=True, exist_ok=True)

    def get_source_stamp(self) -> tuple[int, int]:
        executable = os.stat(sys.executable)
        return executable.st_mtime_ns, executable.st_size

    def get_disambiguator(self) -> str:
        return str(self._line)

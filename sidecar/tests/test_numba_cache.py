from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from sidecar.open_chords_analysis.numba_cache import FrozenWorkspaceCacheLocator


class NumbaCacheTests(unittest.TestCase):
    def test_frozen_cache_is_confined_to_the_job_workspace(self) -> None:
        with tempfile.TemporaryDirectory(prefix="open-chords-numba-cache-") as temporary:
            workspace = Path(temporary)
            original_cwd = Path.cwd()
            try:
                os.chdir(workspace)
                with patch.object(sys, "frozen", True, create=True):
                    locator = FrozenWorkspaceCacheLocator.from_function(
                        self.test_frozen_cache_is_confined_to_the_job_workspace,
                        "librosa/core/notation.py",
                    )
            finally:
                os.chdir(original_cwd)

            self.assertIsNotNone(locator)
            cache_path = Path(locator.get_cache_path()).resolve()
            self.assertTrue(cache_path.is_relative_to(workspace.resolve()))
            self.assertEqual(cache_path.parent.name, "numba-cache")

    def test_source_runtime_does_not_claim_the_frozen_locator(self) -> None:
        self.assertIsNone(
            FrozenWorkspaceCacheLocator.from_function(
                self.test_source_runtime_does_not_claim_the_frozen_locator,
                __file__,
            )
        )


if __name__ == "__main__":
    unittest.main()

#!/usr/bin/env python3
"""Emit one bounded CPU-analysis candidate document for cross-language validation."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
if str(REPOSITORY_ROOT) not in sys.path:
    sys.path.insert(0, str(REPOSITORY_ROOT))

from sidecar.open_chords_analysis.cpu_analysis import AnalysisConfig, analyze_canonical


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--recipe", type=Path, required=True)
    arguments = parser.parse_args()
    recipe = json.loads(arguments.recipe.read_text("utf-8"))
    result = analyze_canonical(
        arguments.input,
        AnalysisConfig.from_recipe_document(recipe),
    )
    print(
        json.dumps(
            result.to_document(),
            allow_nan=False,
            ensure_ascii=True,
            separators=(",", ":"),
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()

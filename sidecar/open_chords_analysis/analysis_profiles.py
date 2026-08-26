"""Lightweight release-versioned CPU analysis profile authority."""

from typing import Final

BASELINE_FEATURE_SETTINGS: Final = {
    "analysisWindowSamples": 96_000,
    "hopLength": 1_024,
    "nFft": 8_192,
}
PROFILE_SETTINGS: Final = {
    profile: dict(BASELINE_FEATURE_SETTINGS) for profile in ("eco", "balanced", "fast")
}

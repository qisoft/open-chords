"""Script entry used by PyInstaller."""

import json
import os
from pathlib import Path
import sys
import wave

from sidecar.open_chords_analysis.numba_cache import FrozenWorkspaceCacheLocator as _cache_locator

os.environ["NUMBA_CACHE_LOCATOR_CLASSES"] = (
    "sidecar.open_chords_analysis.numba_cache.FrozenWorkspaceCacheLocator"
)

from sidecar.open_chords_analysis.__main__ import main


def frozen_main() -> None:
    if sys.argv[1:] == ["--cpu-analysis-import-check"]:
        from sidecar.open_chords_analysis.runtime_manifest import load_frozen_runtime

        runtime_root = Path(sys.executable).resolve().parent
        load_frozen_runtime(runtime_root)
        import numpy as np

        from sidecar.open_chords_analysis.cpu_analysis import (
            PROFILE_SETTINGS,
            AnalysisConfig,
            AnalysisProfile,
            VersionedComponent,
            analyze_canonical,
        )

        fixture = Path.cwd() / "checkpoints" / "cpu-analysis-self-test.wav"
        fixture.parent.mkdir(parents=True, exist_ok=True)
        with wave.open(str(fixture), "wb") as canonical:
            canonical.setnchannels(1)
            canonical.setsampwidth(2)
            canonical.setframerate(48_000)
            canonical.writeframes(b"\0\0" * 48_000)
        result = analyze_canonical(
            fixture,
            AnalysisConfig(
                capabilities=("chords",),
                components=(
                    VersionedComponent(
                        id="open-chords-cpu-dsp",
                        version="1.0.0",
                        hash=f"sha256:{'0' * 64}",
                    ),
                ),
                numerical_backend=VersionedComponent(
                    id="numpy",
                    version=np.__version__,
                    hash=f"sha256:{'0' * 64}",
                ),
                profile=AnalysisProfile(
                    id="fast",
                    name="fast",
                    version="1.0.0",
                    hash=f"sha256:{'0' * 64}",
                ),
                seeds=(("decoder", 0),),
                settings=tuple(PROFILE_SETTINGS["fast"].items()),
            ),
        )
        print(
            json.dumps(
                {
                    "capability": "cpu_analysis",
                    "durationSamples": result.duration_samples,
                    "profiles": sorted(PROFILE_SETTINGS),
                    "stageOutcomes": [stage for stage, _state in result.stage_outcomes],
                },
                separators=(",", ":"),
                sort_keys=True,
            )
        )
        return
    if sys.argv[1:]:
        raise SystemExit("unsupported frozen sidecar argument")
    main()


if __name__ == "__main__":
    frozen_main()

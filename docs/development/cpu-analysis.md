# CPU-first musical analysis

Issue [#53](https://github.com/qisoft/open-chords/issues/53) establishes the weight-free CPU DSP module that consumes the exact canonical mono PCM16 48 kHz WAV produced by the decode boundary. It does not decode, resample, fetch models, access the network, publish an Analysis Revision, or bypass main-owned validation.

## Module boundary

`sidecar/open_chords_analysis/cpu_analysis.py` accepts a validated immutable Analysis Recipe and a canonical WAV path. The Recipe fixes requested capabilities, versioned component and numerical-backend identities, resource-profile identity, seeds, and the exact feature settings. The module rejects settings that do not match the release-versioned `eco`, `balanced`, or `fast` profile. The returned candidate repeats the complete Recipe, stage outcomes, warnings, empty Support Claim IDs, and a structurally complete Musical Timeline.

`tools/emit-cpu-analysis.py` is the cross-language development seam. It reads a Recipe JSON file, analyzes one canonical WAV, and emits one bounded JSON document. `tests/cpu-analysis.test.ts` validates that document with `AnalysisRecipeSchema`, `AnalysisStageOutcomeSchema`, and `parseAnalysisTimeline`, including timeline invariants. Production scheduling, containment, candidate-manifest assembly, and atomic publication remain owned by dependent issue #54.

## Baseline algorithm

The shared feature pass uses librosa 0.11.0 onset strength, chroma STFT, frame RMS, and beat tracking. Project-owned deterministic decoders then produce:

- tempo-stability analysis without treating stable beats as meter or downbeat evidence;
- `UnmeteredRegion` coverage until a dedicated decoder establishes meter and downbeat phase;
- major/minor Key Regions from fixed key profiles;
- structured major, minor, diminished, augmented, suspended, and seventh Chord Events plus musical `N`;
- generic neutral Section Regions from energy transitions and chroma novelty.

Feature windows, FFT size, and hop length come only from the selected versioned profile. All three v1 profile identities currently resolve to the same conservative baseline feature settings; this slice makes no unmeasured speed, quality, or resource distinction between them. Section recurrence evidence is computed from window-level normalized chroma without materializing a frame-by-frame quadratic matrix. The implementation reads canonical PCM directly with the standard-library WAV reader, so librosa cannot perform another decode or resample.

## Confidence and claims

This baseline is intentionally uncalibrated. Tonal candidates remain `low_confidence`; rhythm and meter remain explicit unmetered coverage because beat stability alone cannot establish a meter or downbeat phase. Silence, missing capabilities, and insufficient evidence produce explicit abstention or unmetered coverage. Evidence uses named raw scales and deterministic rounded values. The module emits no automatic Support Claim IDs. Calibration, sealed corpus results, semantic section labels, rich-chord claims, meter claims, and platform/profile performance claims belong to the benchmark and release-evidence phases.

The default runtime requires no downloadable model and no GPU framework. `sidecar/requirements-build.in` is the reviewable dependency authority; `sidecar/requirements-build.txt` is its universal Python 3.13 hash-pinned lock. Librosa's module import closure includes alternate audio I/O, resampling, resource-registry, and HTTP client packages, but this module invokes none of those entry points: canonical input is read only by the standard-library WAV reader. The frozen build excludes sklearn and GPU modules. It inventories native extensions by owning distribution and packages the exact installed license texts.

## Validation

Install the exact Python closure and run the module and cross-language fixtures:

```sh
python3.13 -m venv .venv
.venv/bin/python -m pip install --require-hashes --only-binary=:all: -r sidecar/requirements-build.txt
OPEN_CHORDS_PYTHON=.venv/bin/python pnpm test:python
OPEN_CHORDS_PYTHON=.venv/bin/python pnpm exec vitest run tests/cpu-analysis.test.ts
```

The frozen sidecar test remains the packaged seam. Its handshake advertises `cpu_analysis` plus the three versioned profile names, while a manifest-verified self-test loads and runs the concrete feature modules. The native-closure gate rejects unclassified or host-resolved native dependencies before writing the runtime manifest.

Normal protocol startup imports only the lightweight profile authority, preserving the handshake deadline. The packaged DSP self-test verifies the runtime manifest first, then lazily imports and executes the real silence-analysis path with an empty launch environment. Numba's frozen cache locator is pinned to `checkpoints/numba-cache` beneath the Job Workspace and keys freshness to the frozen executable; it never falls back to HOME or a host cache.

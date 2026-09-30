# Benchmark metrics, calibration and sealed release gates

Implementation issue: [Implement benchmark metrics, calibration, and sealed release gates](https://github.com/qisoft/open-chords/issues/42). Blocker: [issue 47](https://github.com/qisoft/open-chords/issues/47), merged in [PR 84](https://github.com/qisoft/open-chords/pull/84).

Authority: specification section 17, `docs/research/benchmark-release-gate.md` sections 4, 5, 6, 7, 9 and 10, and `CONTEXT.md`. Operator steps are in [the release gate workflow](../benchmark-release-gate-workflow.md).

## Scope of this change

The user asked for tools first, as in issue 47. This change delivers the metric, calibration and sealed gate engine. It proves the engine on synthetic fixtures only. No real corpus, human Gold Reference, native run, numeric threshold, Support Claim or release verdict exists yet. Issue 42 stays open for real-corpus execution.

Synthetic evidence is marked at every layer. A calibration report or verdict built from a `workflow_fixture` manifest or `synthetic_fixture` annotation has `syntheticEvidence: true`. A policy with `purpose: "release"` rejects a synthetic calibration report. A verdict has `releaseAuthority: true` only for a passing sealed run under a release policy with non-synthetic evidence.

## Where the metrics live

The metrics are TypeScript in `tools/benchmark/metrics.ts`. The sidecar build environment pins librosa and PyInstaller but not `mir_eval` (`sidecar/requirements-build.in`), and that environment is the packaged product runtime. Adding an evaluator to it would couple release scoring to the shipped sidecar. The TypeScript implementation reads the existing Gold Reference and Analysis Timeline types directly, works on integer sample frames without a seconds conversion, and is the only implementation.

Metric semantics follow `mir_eval` so that results stay comparable with MIREX. These sources were read for this change:

- Context7 library `/mir-evaluation/mir_eval` for the evaluation chains and the beat preprocessing example.
- [`mir_eval/chord.py`](https://github.com/mir-evaluation/mir_eval/blob/main/mir_eval/chord.py): `weighted_accuracy` drops out-of-vocabulary reference frames; `root`, `majmin` (first 8 semitones, maj/min/N only) and `sevenths` (maj, min, maj7, 7, min7, N); `encode` ignores extension degrees at or above 12 semitones and adds the bass to the bitmap; `directional_hamming_distance`, `overseg`, `underseg` and `seg` on merged intervals.
- [`mir_eval/beat.py`](https://github.com/mir-evaluation/mir_eval/blob/main/mir_eval/beat.py): `f_measure` with a 0.07 s window. The common `trim_beats` step (drop events before 5 s) is not applied because research section 4.1 keeps the full opening.
- [`mir_eval/segment.py`](https://github.com/mir-evaluation/mir_eval/blob/main/mir_eval/segment.py) and [`mir_eval/util.py`](https://github.com/mir-evaluation/mir_eval/blob/main/mir_eval/util.py): boundary `detection` with the default `trim=False` and maximum event matching. For sorted events and a symmetric window, a greedy two-pointer match has the same cardinality as the bipartite matching.

## Data shapes

- **Metric registry.** `METRICS` maps each metric ID to its capability, kind (`quality`, `coverage`, `calibration` or `diagnostic`), direction, unit and scorer. The registry owns direction, so a policy cannot flip it.
- **Metric value.** Each track and metric is `scored` (value plus pooled numerator and denominator where standard), `not_applicable` (the Gold Reference has nothing to score) or `uncovered` (a conditional metric with no asserted unit). Only the Gold Reference can make a metric not applicable.
- **Benchmark Run.** One candidate or baseline, its Recipe and build hashes, the corpus hash and, per platform profile, one output per track plus execution records. An execution record holds cache state, repeat number, disclosed run conditions, outcome hash and resource measurements.
- **Procedure.** The corpus, candidate and baseline identities, platform profiles, uncertainty rule and confidence evidence names. The calibration report is bound to the Procedure hash.
- **Benchmark Policy.** The Procedure, the calibration report hash, named Support Claims, quality gates and resource caps. Every number carries a unit and a rationale.
- **Verdict.** Hard gates, per-profile gate results, determinism, resource caps, claim outcomes and an overall `pass`, `fail` or `insufficient_evidence`, bound to the bundle, policy file and opening receipt hashes.

## Rules the engine enforces

1. A failed or invalid output is scored as an empty prediction. An abstained or missing region counts as wrong in every unconditional quality metric. Failure and total abstention produce the same scores, so relabelling one as the other gains nothing.
2. A missing track output or a missing declared platform profile is a hard `run_identity_and_inventory` failure. A missing track still counts as zero in the sealed report.
3. Every quality or calibration gate has a structurally required coverage gate for the same capability. The pair fails if either side fails.
4. Gates use the track mean. Non-inferiority margins apply only to unconditional metrics. A minimum bound uses the one-sided lower percentile bootstrap bound, a maximum bound uses the upper bound, and non-inferiority uses the lower bound of the paired candidate-minus-baseline difference against the negative margin. Fewer scored tracks than `minTracks` is `insufficient_evidence`.
5. Each profile needs two cold and one warm execution per track with identical outcomes that match the scored output. A mismatch fails. Missing repeats are insufficient evidence.
6. Any failed gate, failed determinism check, exceeded resource cap or failed hard gate makes the verdict `fail`. Insufficient evidence narrows the named claim. A narrowed required claim or required profile blocks release with `insufficient_evidence`.
7. The sealed gate verifies the freeze in the opening receipt with the same function as `open-sealed`, so the trusted key must match the bundle authority hash. It evaluates only those frozen policy bytes and the frozen corpus, and writes exactly one `verdict.json` per opened release directory.

## Acceptance gates and their tests

| Acceptance gate | Tests |
|---|---|
| Abstention stays in denominators and cannot improve quality by deletion | `tests/benchmark-metrics.test.ts` "keeps abstained and failed duration in chord denominators"; `tests/benchmark-gates.test.ts` "keeps abstained, failed and deleted tracks in the sealed denominators" |
| Quality and coverage gates are paired and non-compensating | `tests/benchmark-gates.test.ts` "binds every frozen number to paired coverage", "pairs quality with coverage so neither can compensate", "fails a paired non-inferiority margin" |
| Sealed failure cannot be repaired by changing policy, deleting data or lowering thresholds | `tests/benchmark-release-gate.test.ts` real CLI and file run: freeze forged with another key, lowered or narrowed policy, repeated verdict, edited sealed corpus and dropped track output; `tests/benchmark-gates.test.ts` "fails a run that omits a declared platform profile" |
| Insufficient evidence narrows a named Support Claim or blocks release | `tests/benchmark-gates.test.ts` "narrows an optional Support Claim with insufficient evidence", "requires deterministic cold and warm repeats" |

Each acceptance test was checked against a deliberate defect: counting abstention as ineligible, dropping the coverage side of a gate, skipping tracks without output, treating insufficient evidence as supported, skipping the bundle authority check, accepting a run without a declared profile and allowing a margin on a conditional metric. Each defect turned the matching tests red.

## Decisions to confirm with real data

- A failed gate blocks release instead of narrowing its claim. This follows research section 10.1. Narrowing after a failure needs a new policy and fresh sealed evidence.
- Only the paired percentile bootstrap is implemented. BCa or another method needs a new `method` value.
- Section boundaries include the track start and end (`trim=False`) and the boundaries of abstained regions.
- Key `unknown` and section `unknown` Gold duration is excluded from exact and label accuracy, and is reported in coverage and eligible duration.
- `sealed-gate` exits 0 when it writes a verdict, including a `fail` verdict. Release automation must read `verdict.verdict` and `verdict.releaseAuthority`.

## Remaining real-corpus work

- Run the pinned Release Baseline and candidate natively on the calibration cohort for every claimed platform profile, and record Benchmark Runs.
- Fix the uncertainty rule in the Procedure before calibration. Choose every threshold and margin from the calibration report, with unit and rationale, and freeze the policy through the issue 47 authority.
- Open the sealed cohort once, run it natively, and publish the verdict and the permitted report.
- Rhythm/meter Bar-position accuracy, key relation scores, section pairwise grouping and lyrics tail percentiles are not implemented. Add them only if the policy needs them as gates.

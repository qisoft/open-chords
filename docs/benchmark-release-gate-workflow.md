# Benchmark metrics and sealed release gate workflow

These engineering tools score Benchmark Runs against Gold References, characterize the calibration cohort, validate a Benchmark Policy and record one sealed verdict for [issue 42](https://github.com/qisoft/open-chords/issues/42). They extend the [Benchmark Corpus tooling](benchmark-corpus-workflow.md). Design and test mapping: [planning note](planning/benchmark-metrics-gates.md).

Only **synthetic workflow fixtures** exist. No command in this change has run on a real corpus or a native build. The tools never choose a threshold, a margin or a Support Claim. Maintainers choose them from calibration evidence.

## Commands

```text
pnpm benchmark calibrate BUNDLE-DIRECTORY PROCEDURE.json CANDIDATE-RUN.json BASELINE-RUN.json REPORT.json
pnpm benchmark validate-policy POLICY.json REPORT.json
pnpm benchmark sealed-gate BUNDLE-DIRECTORY RELEASE-DIRECTORY POLICY.json REPORT.json TRUSTED-AUTHORITY-PUBLIC.pem CANDIDATE-RUN.json BASELINE-RUN.json
```

The commands use the diagnostics, size limits and immutable output rules of the corpus tools. `benchmark_ok` means the artifact was written. It does not mean the gate passed.

## Input formats

The TypeScript schemas are authoritative. `tests/support/benchmark-gate-fixture.ts` builds a complete synthetic example.

- **Procedure** (`ProcedureSchema` in `tools/benchmark/policy.ts`): corpus hash, candidate and baseline `{recipeHash, buildHash}`, platform profiles `{id, os, arch, resourceProfile}`, the uncertainty rule `{method, confidence, resamples, seed, minTracks}` and, per confidence-bearing capability, the evidence `{name, scale}` and reliability bin edges.
- **Benchmark Run** (`BenchmarkRunSchema` in `tools/benchmark/runs.ts`): role, subject, corpus hash and, per platform profile, `outputs` and `executions`. An output is `{trackId, result}`. A result is `{kind: "completed", revisionId, timeline, lyrics}` with a full Analysis Timeline, or `{kind: "failed", failureClass}`. An execution record holds `trackId`, `cache` (`cold` or `warm`), `sequence`, run `conditions`, `outcome` (output hash and Revision ID, or failure class) and `resources` (wall and CPU milliseconds, peak resident bytes, workspace and retained bytes, process and thread maxima).
- **Benchmark Policy** (`PolicySchema` in `tools/benchmark/policy.ts`): purpose, Procedure, calibration report hash, Support Claims, quality gates and resource caps. Every number is `{value, unit, rationale}`.

## Operator steps

1. Publish the corpus bundle with `pnpm benchmark publish` as described in the corpus workflow.
2. Write the Procedure. Fix the uncertainty rule and confidence evidence before any calibration run. Changing them later changes the Procedure hash and needs a new calibration report.
3. Run the Release Baseline and the candidate natively on the calibration cohort for every platform profile. Declare only profiles you will run: a run that omits a declared profile is a hard failure. For each track, record at least two cold and one warm execution and the accepted output.
4. Run `calibrate`. It verifies the bundle and reads only `calibration.json`, so it cannot see sealed tracks. It rejects runs whose identity differs from the Procedure or that omit a track. The report contains per-metric and per-slice track distributions, pooled values, percentile bootstrap bounds, paired candidate-minus-baseline differences, reliability bins, risk-coverage points over eligible Gold duration, determinism results and resource summaries.
5. Choose thresholds from the report. Each quality or calibration gate names a Support Claim, a slice, a quality bound and a paired coverage minimum. A non-inferiority margin is optional and allowed only on an unconditional metric, because a conditional error can improve by abstaining. Each platform profile needs a platform Support Claim. Mark a claim `required` when losing it would break the v1 product boundary.
6. Run `validate-policy`. It rejects a gate without its coverage pair, a metric from another capability, a claim slice without a gate, a threshold whose metric and slice have no calibration observation, a tampered report and a release policy built on synthetic evidence.
7. Hash the exact policy file bytes and have the freeze authority sign the declaration from the corpus workflow. Open the sealed cohort with `open-sealed`.
8. Run the candidate and baseline natively on the sealed cohort and record Benchmark Runs.
9. Run `sealed-gate` once. It verifies the freeze in the opening receipt against the bundle exactly as `open-sealed` does: the trusted key must match the authority hash in the bundle index, and the signed declaration must name this bundle, corpus and policy file. It then checks the calibration report binding and the frozen corpus hash, and writes `RELEASE-DIRECTORY/verdict.json` with the bundle, authority, policy file and receipt hashes.

## Reading the verdict

`verdict.verdict` is `pass`, `fail` or `insufficient_evidence`. `verdict.releaseAuthority` is true only for a pass under a `release` policy with non-synthetic evidence. `verdict.claims` lists each claim per platform profile as `supported`, `narrowed` or `failed`. `verdict.sealedReport` holds sealed-cohort statistics. Treat the whole file as a private operator artifact until a disclosure review permits publication.

A failed sealed verdict cannot be repaired with these tools. A changed, lowered or narrowed policy no longer matches the frozen hash. A second `sealed-gate` into the same release directory fails because `verdict.json` exists. An edited `sealed.json` no longer matches the frozen corpus hash. A dropped track output is a hard failure.

## Limits

The tools run offline and cannot stop a custodian from deleting `verdict.json` and evaluating fabricated outputs. Keep the first verdict with the opening receipt, and treat any change informed by sealed results as a new policy that needs a fresh sealed cohort (research section 9). Resource caps compare the largest observed value with the cap and do not estimate tail percentiles. Hosted-runner measurements are not native release evidence.

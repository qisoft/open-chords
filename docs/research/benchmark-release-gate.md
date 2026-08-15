# Open Chords v1 reproducible benchmark and release gate

> Research decision for [Fix the reproducible benchmark and release gate](https://github.com/qisoft/open-chords/issues/14). Source state checked 2026-08-15. This is a benchmark specification, not a benchmark result, legal opinion, runner implementation, or invented set of release numbers.

## Decision

Open Chords v1 is gated by a versioned **Benchmark Policy** over one rights-cleared **Benchmark Corpus** of 30–50 complete tracks. The corpus has two track-disjoint roles:

1. a **calibration cohort**, used to characterize the pinned baseline and comparators, fit Confidence Calibrations, select operating points, and propose numeric quality/resource thresholds; and
2. a sealed **release-gate cohort**, opened only after the policy, thresholds, non-inferiority margins, primary metrics, platform profiles, and Support Claims are frozen.

The release gate is a panel, not a composite score. It covers musical quality, coverage/abstention, calibration, technical failure, deterministic output, CPU time and resources on every claimed native platform, and paired regression against the Release Baseline. A strong average cannot compensate for invalid output, hidden abstention, a failed required slice, nondeterminism, missing rights, or an untested platform.

No numeric quality, calibration, runtime, or resource threshold is set by this document. Those values become a separately versioned, reviewable Benchmark Policy only after the first calibration-cohort baseline. Changing a threshold after observing the release-gate cohort is prohibited; a score-directed change requires a new policy and fresh sealed evidence.

## Terms that prevent ambiguous gates

- **Gold Reference** is the adjudicated human annotation for scoring. It is not Reference Lyrics, which may intentionally mismatch a performance.
- **Release Baseline** is the previous supported Open Chords release. For v1, it is the frozen pre-release baseline Recipe selected before the release-gate cohort is opened.
- **Candidate** is the exact build, Recipe, Model Artifacts, calibrations, and Resource Profile proposed for release.
- **Comparator** is a pinned, legally runnable system used for context. It does not become the product gate merely by winning one metric.
- **Benchmark Policy** fixes the corpus version, cohorts, metrics and parameters, thresholds, uncertainty rules, platform profiles, and intended Support Claims.
- **Benchmark Run** is immutable evidence produced by applying one policy to one candidate.

These terms are added to `CONTEXT.md`. In particular, “reference” alone is not used because a human reference, a prior release, and a third-party system have different roles.

## 1. Corpus eligibility and rights ledger

### 1.1 Eligibility rule

A track enters the corpus only when the project has recorded evidence permitting every operation the benchmark will perform. Public availability, a streamable URL, possession of a file, or an annotation repository is not evidence of permission.

Acceptable sources are project-owned or commissioned recordings, a direct written grant, a clearly applicable public-domain determination, or an explicit content license whose terms cover the planned use. A Creative Commons notice applies only to rights held by its licensor, and its attribution/source/license information must travel with the work ([Creative Commons marking guidance](https://wiki.creativecommons.org/wiki/Marking_your_work_with_a_CC_license)). The sound recording and the underlying composition/lyrics are separate rights layers ([U.S. Copyright Office Circular 56A](https://www.copyright.gov/circs/circ56a.pdf)); annotation authorship and redistribution are a third layer.

External corpora may seed the inventory only track by track. For example, JamendoLyrics states that its code is MIT while the `lyrics` and `mp3` folders have per-song Creative Commons licenses, so the repository license cannot stand in for the media ledger ([dataset LICENSE](https://huggingface.co/datasets/jamendolyrics/jamendolyrics/blob/e9a8a63e7c828a0a7152c46752de5c24ae65de94/LICENSE)). Isophonics publishes annotations while expecting evaluators to obtain the original recordings separately ([reference-annotation notes](https://isophonics.net/content/reference-annotations.html)). Neither is an automatic redistribution grant for a release corpus.

### 1.2 Required ledger fields

The **Corpus Rights Ledger** has one immutable entry per track and separately records:

- stable pseudonymous track ID; source and canonical-audio SHA-256; duration and canonical sample rate;
- source/creator/licensor, evidence URL or archived written grant hash, license/version, acquisition date, attribution and notice text;
- disposition of the sound recording, composition, lyrics/reference text, each annotation, and generated benchmark results;
- permission flags for local storage, automated analysis, human annotation, derivative timing/harmony data, private CI transfer, public audio redistribution, public annotation redistribution, and per-track/aggregate metric disclosure;
- territory, expiry or termination condition where applicable, required deletion, and the last review date/reviewer;
- the permitted execution location: hosted runner, private self-hosted runner, or named local reference machine;
- a machine-checkable eligibility verdict and reason. Missing or ambiguous evidence is `ineligible`, never “probably allowed.”

The ledger itself may redact private contract text, but its evidence hash and release disposition remain auditable. Restricted audio, lyrics, or annotations do not enter Git, hosted CI caches, build artifacts, or public reports. A corpus version is invalid if any included entry fails its current rights preflight.

## 2. Corpus construction and slices

### 2.1 Track-level units and cohorts

The statistical unit is the complete authorized track, not frames, beats, chord events, lyrics tokens, or repeated benchmark executions. The 30–50 tracks are frozen into calibration and release-gate cohorts before model or threshold comparison. All alternate encodings, edits, excerpts, performances of the same recording, and any deliberately transformed fixtures stay in the same cohort. Recordings sharing a composition or artist are grouped where feasible and every unavoidable cross-cohort relationship is disclosed.

The benchmark corpus is never training data. Algorithm development uses separately licensed development material and synthetic fixtures. Calibration may fit a score mapping and choose an operating point, but it may not train or fine-tune the musical recognizer. The release-gate cohort remains inaccessible to candidate development and calibration.

Exact cohort membership is determined only after the rights inventory can satisfy coverage. Both cohorts must contain evidence for every Support Claim; if a claimed slice cannot be represented in both cohorts with meaningful track-level uncertainty, that claim is `insufficient evidence` and must be narrowed. It is not rescued by event count from one track.

### 2.2 Multi-label stratification

Each track carries independently reviewed, versioned slice labels. The manifest publishes track count and eligible duration/event count for every slice and every cohort.

| Axis | Required slice inventory |
|---|---|
| Source | lossless/lossy authorized masters; local-file path; encoding variants confined to one track group |
| Style/production | sparse/dense; acoustic/electronic; vocal-forward/instrumental; live/studio; clean/noisy/compressed; percussion-light |
| Duration/form | short/long; pickup; repeated chorus; instrumental break; irregular/truncated ending |
| Tempo | slow/medium/fast; steady; expressive drift/rubato; abrupt change; half/double-tempo traps |
| Meter | 2/4, 3/4, 4/4, 6/8; change; ambiguous/unknown; explicit Unmetered Region |
| Harmony | major/minor; seventh; sus/add/9; diminished/augmented; slash/inversion; `N`; modulation; non-A440/ambiguous |
| Sections | clear/ambiguous boundaries; anonymous repeats; supported semantic labels; `unknown` |
| Lyrics | none; English; Russian; repeated text; melisma; OOV; backing/overlapping voice; code-switch; line-only fallback; intentional Reference Lyrics mismatch |

These are coverage dimensions, not mutually exclusive buckets and not demographic inferences about performers. The policy freezes which slices are release-gating, diagnostic, unsupported, or out of scope before the release cohort is evaluated.

Synthetic and adversarial fixtures are a separate, non-scoring suite for decoder offsets, corrupted/truncated media, very long duration, resource exhaustion, unusual sample rates/channels, and schema/protocol failures. They can establish hard correctness and safety gates but cannot inflate musical-quality evidence.

## 3. Gold References and annotation reliability

### 3.1 Canonical package

The annotation package uses versioned JAMS as its audit/interchange container because JAMS validates schemas, stores multiple annotations, and covers beats, chords, segments and related MIR namespaces ([JAMS documentation](https://jams.readthedocs.io/en/stable/)). A local Open Chords namespace stores identity-bearing integer sample-frame boundaries against the canonical sample rate; standard JAMS time/duration fields and evaluator `.lab` files are deterministic derivatives, not a second timebase. Chords use structured Open Chords Chord Identity plus deterministic Harte labels for MIREX/mir_eval compatibility.

Every annotation package records the track hash, annotation-guide version, annotator pseudonym/role, tool version, creation/update time, source layer, confidence/ambiguity tags, adjudication links, and content hash. It contains:

- both independent raw annotations;
- the adjudicated Gold Reference;
- explicit disagreement/ambiguous regions and adjudication reasons;
- deterministic exports and validation reports.

JAMS schema validity does not make its free-form confidence a probability. Open Chords calibration semantics remain separate.

### 3.2 Annotation protocol

Two qualified annotators independently annotate every release-gated capability without seeing any candidate or comparator output. A third qualified reviewer adjudicates disagreements against the versioned guide. An annotator may cover several capabilities only when qualified for each; identity and order are recorded without public personal data.

Annotation is capability-specific:

- **Decode/timebase:** exact canonical sample count, range boundary and known transient/offset fixtures.
- **Rhythm:** all Beats and Bar/downbeat roles, Bar status, meter and meter-change boundaries, and Unmetered Regions. Openings and pickups are annotated rather than trimmed.
- **Harmony/key:** full-cover Chord Events including `N`, structured qualities/bass, and full-cover Key Regions including `unknown`.
- **Sections:** full-cover flat Section Regions, occurrence/group identity, supported semantic label or neutral/`unknown` label.
- **Lyrics:** one performed primary lyric sequence, word and line boundaries where audible, unmatched occurrences and mismatch reason. Backing/overlapping streams are challenge labels, not silently forced into the primary sequence.

Annotators may mark evidence ambiguous but may not consult analyzer output to resolve it. Adjudication never deletes the independent versions. Harmony and musical form are genuinely subjective: MIREX describes chord references as the work of one or more human annotators ([MIREX Audio Chord Estimation](https://music-ir.org/mirex/wiki/2025%3AAudio_Chord_Estimation)), and the MIREX structure collections include many tracks annotated independently by two people ([MIREX Music Structure Analysis](https://music-ir.org/mirex/wiki/2025%3AMusic_Structure_Analysis)).

### 3.3 Reliability report

Before the Gold Reference becomes gate-eligible, the corpus report scores annotator A against B, symmetrically, with the same task metrics and parameters used for systems. It publishes per-track and slice distributions, eligible duration/events, disagreement regions, and adjudication rate.

- chords: exact Open Chords identity plus root, maj/min, sevenths and inversion-aware overlap and segmentation;
- beats/downbeats: full-range F-measure and continuity diagnostics;
- meter/key: duration-weighted exact agreement and boundary error;
- sections: boundary F-measure at both declared tolerances, pairwise/repeat grouping, and semantic-label agreement;
- lyrics: word/line coverage and paired start/end error for matched token occurrences.

Ordinary categorical kappa is not applied directly to timestamp sequences; any discretization or event matching rule would first have to be part of the frozen metric specification. Low reliability does not become a permissive system threshold. It causes guide repair, re-annotation, an explicit ambiguity slice, or a narrowed Support Claim.

## 4. Fixed metric panel

Metric code, version, parameters, preprocessing and denominator are part of the Benchmark Policy hash. `mir_eval` 0.8.2 currently exposes chord, beat, segment, tempo and key evaluators ([official API index](https://mir-eval.readthedocs.io/latest/api/)); MIREX remains the external comparability panel, not the whole product contract.

The primary aggregation unit is track. Every metric publishes per-track values and macro distribution summaries. Duration/event-pooled values are also reported where standard, but never alone. Technical failure is a failed track with zero asserted coverage; it is never removed from the denominator. Low-confidence assertions are scored as assertions. Abstained regions stay in the denominator and are also reported as abstention.

### 4.1 Capability metrics

| Capability | Release-gate measures | Mandatory diagnostics/pitfalls |
|---|---|---|
| Decode/timebase | exact canonical PCM/sample-count and Project Range checks on fixtures; no offset/invariant failure | packaged decoder hash, input variant, failure class |
| Chords | full-duration exact structured Chord Identity overlap including `N`; asserted coverage and selective error | MIREX/mir_eval root, maj/min, sevenths and inversion-aware WCSR; class-wise eligible duration; over/under-segmentation; change-boundary errors |
| Beats/downbeats | separate full-Project F-measures with the standard ±70 ms event tolerance; asserted coverage | Cemgil and CMLc/CMLt/AMLc/AMLt; full opening retained because `mir_eval.beat.evaluate()` otherwise trims before five seconds; downbeat is never used as a proxy for meter |
| Meter/tempo | duration-weighted exact meter and Bar-position accuracy; meter-change error; local Beat-derived signed/absolute log2 tempo-ratio error | global legacy tempo score only as diagnostic; half/double and variable-tempo errors separated |
| Key | duration-weighted exact tonic/mode; asserted coverage | MIREX weighted relation score and explicit exact/fifth/relative/parallel/other taxonomy; change-boundary error |
| Sections | boundary precision/recall/F at 0.5 s and 3 s; full-cover validity; asserted semantic-label coverage | pairwise/repeated-group scores for anonymous labels; semantic frame accuracy/per-class F only for the locally frozen vocabulary; ambiguity against both annotators |
| Lyrics alignment | matched word and line coverage; median and tail start/end absolute error; unmatched/OOV rate; monotonicity/invariant failures; EN/RU separate | boundary error is always paired with coverage; mismatch, repetition, melisma, overlap and line-only fallback slices; no text-recognition score because Reference Lyrics are fixed input |
| Whole Analysis Revision | required-stage success; schema/domain validation; visible low-confidence/abstained coverage; no partial publication | per-stage reason taxonomy and candidate rankings only where safe evidence exists |

The 70 ms beat window and 0.5/3 s section windows are metric definitions for comparability, not release acceptance thresholds. MIREX defines continuous-duration CSR/WCSR and multiple chord vocabulary mappings rather than one “correct” simplification ([2025 chord task](https://music-ir.org/mirex/wiki/2025%3AAudio_Chord_Estimation)); it defines both 0.5 s and 3 s structure-boundary measures ([2025 structure task](https://music-ir.org/mirex/wiki/2025%3AMusic_Structure_Analysis)).

The product's exact rich-chord metric retains all Gold Reference duration. Standard `mir_eval` projections that discard out-of-gamut reference frames must publish their eligible duration, because renormalizing the remaining frames can inflate a score. The `mir_eval.chord.mirex` common-pitch-class metric is diagnostic, not headline evidence: it can credit harmonically overlapping but structurally wrong labels.

### 4.2 Calibration and abstention

For every confidence-bearing capability, the policy first fixes the prediction unit and correctness event: duration cells for region assertions, matched/non-matched events for beats/downbeats, and token occurrences for lyrics alignment. Raw library scores retain their named scale and are never shown as probabilities.

Confidence Calibration is fitted only on the calibration cohort, separately by analyzer, capability, class/slice where support is claimed, and calibration version. The calibration artifact, fitting cohort hash, binning/regularization, seed and implementation hash enter the Analysis Recipe. With a small corpus, low-sample isotonic fitting is not assumed safe; current scikit-learn documentation explicitly warns that isotonic calibration tends to overfit when calibration samples are scarce ([`CalibratedClassifierCV`](https://scikit-learn.org/stable/modules/generated/sklearn.calibration.CalibratedClassifierCV.html)).

Release evidence includes reliability diagrams with frozen bins, Brier score and/or log loss, and the underlying counts. Brier is not used alone because it mixes reliability, resolution and uncertainty ([scikit-learn calibration guide](https://scikit-learn.org/stable/modules/calibration.html)).

Abstention is evaluated as a selective-prediction trade-off:

- publish coverage versus conditional error/risk over the full operating curve;
- score the frozen release operating point selected on calibration data;
- keep abstained reference duration/events in the unconditional denominator;
- keep `N` as a scored musical assertion, never an abstention;
- disclose low-confidence, abstained and technical-failure coverage separately by capability and slice.

A system cannot improve its headline quality by suppressing difficult outputs: every minimum-quality gate has a paired minimum-coverage gate, and every class/language/meter Support Claim has its own evidence.

## 5. Baselines, comparisons and statistical uncertainty

### 5.1 Comparison lanes

All systems consume the same canonical PCM, Project Range, cohort and evaluator package.

1. **Release Baseline:** previous release; for v1, the frozen FFmpeg + librosa/Open Chords + MFA baseline selected by the CPU-stack decision.
2. **Candidate:** exact proposed default preset and each claimed Resource Profile.
3. **Comparators:** only the pinned, rights-compatible candidates already identified by research (for example Essentia, Chordino, BeatNet, All-In-One or MFA variants) whose executable/model provenance permits the run.
4. **Ablations:** capability-specific comparisons needed to explain a decision, never a source of post-holdout tuning.

Chordify or another hosted proprietary product is not a reproducible Release Baseline: its build, model, score semantics and repeatability cannot be pinned. A separately authorized observational comparison may be disclosed as product context, never used to replace Gold Reference scoring or the deterministic gate.

### 5.2 Uncertainty contract

Point estimates are accompanied by track-level uncertainty. Candidate-minus-baseline comparisons use paired resampling of tracks, preserving each track's corresponding results. SciPy's current bootstrap API explicitly supports paired index resampling and BCa confidence intervals ([`scipy.stats.bootstrap`](https://docs.scipy.org/doc/scipy/reference/generated/scipy.stats.bootstrap.html)). Frames/events are not resampled as independent observations.

The frozen policy declares:

- one primary gate measure and direction per capability, plus non-compensating guardrails;
- the confidence level, one- or two-sided interval, bootstrap method/resample seed and failure behavior for degenerate/small slices;
- a practical non-inferiority margin for paired candidate-minus-baseline comparisons;
- which secondary metrics are descriptive and, if confirmatory, the multiplicity-control procedure;
- track-macro and standard pooled values, slice sample sizes, and per-track values where rights permit.

For a minimum metric, the applicable lower confidence bound must clear its frozen threshold; for a maximum error/resource metric, the upper bound must clear it. For non-inferiority, the lower bound of the paired candidate-minus-baseline difference must clear the negative frozen margin. A tiny p-value cannot compensate for an operationally bad effect, and “not significantly worse” is not evidence of equivalence without the predeclared margin.

A slice too small for the declared interval or producing a degenerate result is `insufficient evidence`. The project either collects more eligible tracks or narrows the Support Claim.

## 6. Determinism and run manifest

### 6.1 Determinism gate

The already-decided contract requires bit-exact repeatability within each declared platform profile. For every corpus track and each release-supported platform/architecture/Resource Profile tuple, the release run performs at least two clean cold-workspace executions and one warm dependency-cache execution with identical identity-bearing inputs. The accepted Open Chords JSON, Analysis Evidence, stage artifacts retained by the Revision, warnings/reasons, and Analysis Revision ID must be byte-identical after canonical serialization. Attempt timestamps, paths and resource observations remain outside Revision identity.

Cross-platform outputs are distinct platform-profile Revisions and need not be byte-identical, but every profile must independently pass musical, calibration, validity and resource gates. Cross-platform metric/output differences are published. A profile without a native packaged run is not supported.

Seeds alone are insufficient: PyTorch's own reproducibility notes state that complete repeatability is not guaranteed across releases or platforms and that deterministic algorithms may need to fail rather than fall back ([official reproducibility notes](https://docs.pytorch.org/docs/stable/notes/randomness.html)). The policy therefore pins locale, timezone, canonical serialization/order, thread/process counts, numerical backend, dependency/model/calibration hashes, and deterministic-mode settings; any nondeterministic operation is a gate failure, not a tolerated delta.

### 6.2 Immutable manifests

Each Benchmark Run records and hashes:

- Benchmark Policy, corpus, cohort/slice, Rights Ledger and annotation-package versions;
- source/canonical-audio hashes and all deterministic transform commands;
- application/sidecar commit and build IDs, Analysis Recipe/Preset/Resource Profile, evaluator code and parameters;
- dependency lock, packaged executable hashes, model/dictionary/calibration IDs and SHA-256, licenses/model cards;
- OS/build, architecture, CPU model/features, physical/logical cores, RAM, power mode, filesystem, thread/process limits, locale/timezone;
- seed/RNG identities, warm/cold state, network-disabled state, start/end monotonic times;
- raw content-addressed predictions, validation reports, metric rows, bootstrap inputs/results, stderr classification and exit status;
- a rerun/supersession link and reason; results are never overwritten.

Manifests use canonical serialization and content hashes. Private paths, usernames, hostnames, media titles, lyrics, URLs, environment dumps and secrets are excluded or replaced by safe IDs as required by the diagnostic boundary.

## 7. CPU runtime and resource gate

Every platform tuple claimed by the packaging/release manifest runs the installed, signed/notarized release artifact natively on a named reference hardware profile. The current forward matrix is macOS 13+ 64-bit, Windows x64, and declared Linux x64/arm64 baselines, but the packaging decision owns the final list. Adding a platform automatically adds a mandatory benchmark lane.

For Eco, Balanced and Fast separately, measure per stage and end to end:

- wall time, CPU time, real-time factor (`wall / Project duration`) and cold start;
- peak resident memory, workspace bytes, retained checkpoint/evidence bytes;
- process/thread maxima, exits/signals, deadline and resource-failure classification;
- median and tail distributions by duration/texture slice, with cold and warm runs separate.

The quality corpus is too small by itself to substantiate an extreme-tail p99 claim. Resource formulas use calibration-cohort observations plus repeated long/adversarial non-scoring fixtures; they publish uncertainty and the largest observed case. The later numeric policy chooses fixed overhead, duration coefficient, safety margin, deadline and hard caps from those results. It never estimates a “p99” from 30–50 single observations and calls that proven.

Run conditions are fixed and disclosed: AC power, named power/performance mode, thermal precondition, no user workload, network disabled after dependency preflight, fixed concurrency, available disk/RAM, and reference-machine ownership. Virtual hosted-runner measurements are CI smoke evidence, not the native release performance claim. SPEC's run rules are not reused as a product benchmark, but their principle applies: a published CPU number is an observation tied to disclosed system, software, tuning and run conditions ([SPEC CPU run/reporting rules](https://www.spec.org/cpu2026/docs/runrules.html)).

## 8. CI, release runs and disclosure

### 8.1 CI tiers

| Tier | Data | Purpose | Release authority |
|---|---|---|---|
| Pull-request CI | generated/publicly redistributable fixtures and a tiny rights-cleared canary | schema, evaluator, manifest, deterministic serialization, failure-path and gross runtime regression | cannot make or refresh quality claims |
| Scheduled private benchmark | calibration cohort on authorized self-hosted/reference runners | characterize candidates, fit calibration, diagnose regressions; raw restricted evidence retained privately | may propose thresholds, never pass the release cohort |
| Release-candidate gate | sealed release cohort plus adversarial fixtures on every native reference platform | immutable quality, coverage, calibration, determinism, regression and resource verdict | only authoritative release run |

Hosted CI never receives a restricted track merely because the repository is private. Cache/log/artifact retention follows each ledger entry. The runner has no network during analysis; all dependencies are pinned, present and hash-verified before the run.

### 8.2 Public report

Each candidate release publishes, to the extent permitted:

- policy/corpus/run IDs and hashes, candidate/baseline manifests, platform configurations and exact commands;
- rights and slice summaries, cohort sizes/durations, annotation reliability and exclusions;
- all primary and diagnostic metrics with confidence intervals, per-track pseudonymous rows where allowed, coverage/abstention/failure counts and risk-coverage plots;
- CPU/resource distributions, deterministic-repeat hashes and cross-platform differences;
- every failed/insufficient slice, comparator limitation, rerun, exception and Support Claim that was narrowed;
- raw machine-readable result bundles without media, lyrics, secrets or disallowed annotations.

Restricted per-track detail is replaced only by the maximum permitted aggregate, never by fabricated openness. The report states which evidence an external reproducer can obtain and which can only be audited privately.

## 9. How numeric thresholds are chosen after baseline

The first calibration pass is characterization, not a release pass. The governance sequence is fixed:

1. **Freeze inputs:** rights-eligible corpus version, cohort assignments, annotation guide/Gold References, slices, metric code/parameters, candidate lanes, platform profiles and desired Support Claims.
2. **Measure calibration cohort:** run the Release Baseline and legal comparators; publish distributions, annotation reliability, coverage/failure, risk-coverage, paired differences and CPU/resources.
3. **Choose operating points:** fit versioned calibrations and choose assertion/low-confidence/abstention boundaries using only the calibration cohort.
4. **Propose numbers:** for each capability/platform/slice, record a minimum quality and coverage, maximum catastrophic/failure/calibration/resource value, and a practical paired non-inferiority margin. The rationale must combine observed baseline distributions and uncertainty, annotation reliability, user-visible utility/manual fallback, and reference-machine feasibility. A baseline score is evidence, not automatic acceptability.
5. **Review and freeze:** a named maintainer approves a policy diff containing every number, direction, unit, aggregation, CI rule, exception and resulting Support Claim. Hash and sign/tag the policy before access to release-gate results.
6. **Open once and decide:** run the candidate and Release Baseline on the sealed cohort/platforms. The machine-readable evaluator returns only `pass`, `fail`, or `insufficient_evidence` per non-compensating gate and an overall verdict.
7. **No threshold shopping:** failure cannot be repaired by lowering a threshold, changing a metric, deleting a track/slice, relabelling an error as abstention, or choosing another aggregate after seeing results.

A non-score-affecting runner/infrastructure defect may be corrected and rerun with both artifacts and rationale preserved. An algorithm, calibration, threshold, cohort, Gold Reference or score-affecting evaluator change creates a new policy/run. If it is informed by release-cohort results, those tracks are no longer sealed evidence for that change; the corpus must add/rotate an untouched gate cohort before claiming an independent pass.

## 10. Pass/fail governance and Support Claim narrowing

### 10.1 Hard gates

Release fails regardless of musical averages when any of these occurs:

- incomplete/ambiguous rights evidence, wrong cohort, manifest/hash mismatch or prohibited disclosure;
- invalid/partial Analysis Revision, hidden required-stage failure, protocol/containment/integrity failure or unclassified dropped track;
- non-bit-exact repeat within a declared platform profile;
- a required stage represents technical failure as low confidence/abstention, or `N` as abstention;
- resource/deadline/circuit-breaker hard cap is exceeded on a claimed platform/profile;
- the frozen candidate, calibration, dependency, model or evaluator differs from the policy;
- a release-gating metric/coverage/calibration/regression confidence bound misses its frozen threshold.

No weighted overall score and no maintainer waiver can compensate silently. An emergency exception requires a new explicit policy version, public rationale, expiry, and a narrowed claim; it is not a pass under the old policy.

### 10.2 Claim outcomes

The benchmark may narrow automatic support without deleting manual domain capability:

- rich chord qualities/inversions can become manually representable but automatically unsupported classes;
- unreliable meter types/changes become best effort with explicit abstention and manual meter authority;
- semantic sections can narrow to generic boundaries/`unknown`;
- EN or RU word alignment can narrow to line timing or unmatched output for named slices;
- a failing Resource Profile or OS/architecture is removed from the release matrix;
- slices without adequate rights, Gold Reference reliability or uncertainty remain unsupported, not “works in most cases.”

The mandatory default Analysis Preset still needs a technically successful, structurally valid result for its declared capabilities. If its useful automatic scope becomes too narrow for the v1 product boundary, the release is blocked and the product/spec decision must be reopened; the benchmark cannot redefine v1 by itself.

## 11. What this resolves and what remains measured work

This fixes the corpus, annotation, metric, calibration, determinism, resource, statistics, CI, governance, disclosure and claim-narrowing contracts. It deliberately does not:

- select the 30–50 actual recordings or claim their rights are cleared;
- create Gold References or a runner;
- choose numeric quality, coverage, calibration, runtime, memory, disk or non-inferiority thresholds;
- prove any analyzer, language, meter, rich chord class, platform or Resource Profile passes;
- make third-party closed-system comparisons reproducible.

Those are implementation and measurement tasks after the Wayfinder specification. The first implementation plan must produce the rights inventory and annotation guide before runner code can yield release-authoritative evidence.

## Primary-source basis

- [MIREX 2025 Audio Chord Estimation](https://music-ir.org/mirex/wiki/2025%3AAudio_Chord_Estimation) — continuous CSR/WCSR, chord vocabularies, segmentation and evaluator protocol.
- [MIREX 2025 Music Structure Analysis](https://music-ir.org/mirex/wiki/2025%3AMusic_Structure_Analysis) — independent annotations and 0.5/3 s boundary metrics.
- [`mir_eval` 0.8.2 API](https://mir-eval.readthedocs.io/latest/api/) and [chord API](https://mir-eval.readthedocs.io/latest/api/chord.html) — current evaluator surfaces and vocabulary/segmentation measures.
- [JAMS 0.3.5 documentation](https://jams.readthedocs.io/en/stable/) — multiple validated annotations and MIR namespaces.
- [scikit-learn probability calibration guide](https://scikit-learn.org/stable/modules/calibration.html) and [`CalibratedClassifierCV`](https://scikit-learn.org/stable/modules/generated/sklearn.calibration.CalibratedClassifierCV.html) — calibration diagnostics, proper scoring caveats and disjoint calibration data.
- [SciPy paired bootstrap API](https://docs.scipy.org/doc/scipy/reference/generated/scipy.stats.bootstrap.html) — track-paired uncertainty and BCa intervals.
- [PyTorch reproducibility notes](https://docs.pytorch.org/docs/stable/notes/randomness.html) — release/platform limits of seeded reproducibility and deterministic-operation controls.
- [U.S. Copyright Office Circular 56A](https://www.copyright.gov/circs/circ56a.pdf) and [Creative Commons marking guidance](https://wiki.creativecommons.org/wiki/Marking_your_work_with_a_CC_license) — separate rights layers and attributable license evidence.
- [SPEC CPU run/reporting rules](https://www.spec.org/cpu2026/docs/runrules.html) — disclosed system/run conditions for meaningful performance observations.

## Context7 verification

Context7 was available in this task. `resolve-library-id` followed by `query-docs` selected `/mir-evaluation/mir_eval` and `/websites/scikit-learn_stable`. The returned current documentation confirmed the multi-projection chord/beat/key/segment API panel and scikit-learn's reliability-diagram, Brier/log-loss and disjoint calibration-data guidance. Durable citations above point to the owning projects' documentation.

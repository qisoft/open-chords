# Benchmark Corpus and Gold Reference workflow

Implementation issue: [Build the Benchmark Corpus ledger and Gold Reference workflow](https://github.com/qisoft/open-chords/issues/47).

## Starting point

The JSON export implementation is merged at `e2bc48f51e22e54b1a5f89bb255bfb652dbcde23`. Its native save-dialog acceptance remains open. Native GitHub dependencies leave the corpus/annotation workflow as the next independent frontier: its benchmark-definition prerequisite is closed. Human-facing exports, archive work, acquisition and release packaging remain blocked by their own open dependencies.

Authority: `CONTEXT.md`, specification section 17, and `docs/research/benchmark-release-gate.md` sections 1–3 and 9. This work supplies corpus governance and annotation tooling; metric implementation, threshold selection and release verdicts belong to the dependent benchmark-metrics issue.

## Proposed public test boundaries

All three boundaries were confirmed by the user on 2026-09-09.

1. Corpus Rights Ledger API: independently recorded rights layers and intended operations, fail-closed eligibility for missing/ambiguous evidence, cohort/capability/slice coverage accounting.
2. Annotation API: two independent raw annotations and a separate qualified adjudicator, preserved disagreements, immutable sample-based identities, deterministic canonical hashes and JAMS/Open Chords interchange.
3. CLI and storage: real files, separate calibration and sealed data, denied tuning access before authenticated policy freeze, immutable audit artifacts and reproducible reopening.

## Inputs and limitations

The repository has a normative benchmark plan but no corpus inventory, grants, independent annotations or Gold Reference files. The user confirmed there is no prepared external corpus; implement the tools first and keep real-corpus acceptance open. Synthetic fixtures may prove workflow correctness; they cannot count toward the 30–50-track corpus or authorize musical Support Claims. Recorded rights evidence is a maintainer-reviewed input, not an automated legal determination. Qualified independent human annotation and adjudication cannot be replaced by agent-generated labels.

## Design constraints under investigation

- Eligibility is evaluated for the specific requested use and execution location. Lack of public redistribution permission must not be confused with lack of authorized private execution; neither may be guessed from a source URL or repository license.
- Preserve versioned source/audio/evidence/annotation hashes, reviewer and annotator pseudonyms, expiry/review conditions, and required attribution/notices. Public reports must respect disclosure permissions and omit private grant contents and media paths.
- Cohorts are disjoint by recording group, including alternate encodings and transformations. Composition/artist relationships are accounted for explicitly. Every required capability/slice needs per-cohort eligible track and duration accounting; missing evidence remains insufficient.
- Independent annotation submissions must remain distinct from adjudication. Record qualifications, guide/tool versions, exact sample timebase and disagreement/adjudication links; no candidate output is used as Gold.
- A CLI role flag is not an access-control boundary. Sealed cleartext and custody keys must be unavailable to tuning processes. The storage design must prove that separation and authenticate the policy-freeze authority; policy numbers and release-run execution remain outside this issue.
- No real media, restricted annotations, grants or sealed evidence enter Git, ordinary PR CI or public artifacts. Fixtures and their evidence must be unmistakably synthetic.

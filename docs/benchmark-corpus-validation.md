# Benchmark Corpus tooling validation

Scope: [issue 47](https://github.com/qisoft/open-chords/issues/47), implemented from `e2bc48f51e22e54b1a5f89bb255bfb652dbcde23`. The user confirmed all three public seams and requested tools before real corpus acquisition. All test input, identity, rights and media examples are synthetic.

## Public seam evidence

- Rights API: private operation independently allowed while public redistribution is denied; separate missing composition rights, ambiguous/expired evidence and wrong execution locations fail closed.
- Annotation API: two distinct raw submissions and a third adjudicator, preserved differences, required reasons including changes to agreeing submissions, complete interval order, mutation rejection and an independently calculated canonical SHA-256 vector.
- JAMS boundary: all six capabilities round-trip through the versioned Open Chords profile, with independent upstream draft-04 schema/namespace validation, a literal rich-chord projection and derivative-tampering rejection.
- Corpus API: duplicate recording groups, undisclosed related cohorts and substituted references fail; synthetic references cannot be relabeled as a release corpus. The Unmetered regression retains track/negative inventory while exposing zero beat events and no metric-sufficiency verdict.
- CLI/files: actual child processes and temporary files, separate calibration/sealed content, immutable output publication, deterministic private audit artifacts, no custody key or sealed plaintext in the tuning bundle, signed freeze and current-rights requirements, post-publication revocation, unsigned review edits, wrong keys, ciphertext/policy changes and repeated-output rejection.

Focused suite: 21 passing tests after review fixes. The full repository validation passed before those fixes (467 unit tests and 33 renderer scenarios, existing diagnostic tests skipped); the final unit/type/lint/schema checks are rerun for the fixes. CI runs the same CLI tests on macOS arm64 and Windows x64 as part of foundation tests. GitHub checks on the current PR commit remain the authority for cross-platform results.

## Standards

Initial finding: opening re-evaluated only the frozen rights snapshot, so post-publication revocations could not enter the API. This contradicted the documented current-rights requirement.

Resolved in `9bd25d5`: require a signed, time-bounded current-rights review bound to corpus, execution context and complete track inventory; re-audit its grants and retain the signed review in the opening receipt. Real-file regression covers revocation after publication and no released output. The reviewer found no concrete regression in the follow-up. No additional baseline maintainability findings.

## Spec

Initial finding: coverage rows contained whole-track seconds and track counts without task-specific eligible event/duration accounting (research section 2.2). A fully Unmetered reference could conceal zero beat evidence.

Resolved in `9bd25d5`: distinguish track inventory from positive event counts/durations and explicit negative evidence; retain Unmetered/Unknown/N/unmatched data, and mark metric sufficiency as not evaluated. The reviewer found no new concrete specification defect in the follow-up.

Review totals: one resolved finding per axis; zero outstanding findings in either follow-up. Scientific adequacy, real human independence and operational key custody are not established by these tests. See [the workflow and remaining acceptance](benchmark-corpus-workflow.md#remaining-real-corpus-acceptance); issue 47 must remain open until the real corpus and its evidence are accepted.

## External review follow-up

CodeRabbit supplied three minor comments. Missing lyrics-subject handling and silent interactive-key input were reproduced and fixed: a grant named `missing_lyrics` can no longer substitute for the absent subject, and real TTY invocation now exits immediately with the fixed diagnostic. The numeric chord-array ordering suggestion was not adopted because the public Open Chords domain requires lexical sorted/unique arrays; a regression checks the annotation API and `parseAnalysisTimeline` against the same chord and rejects duplicate/descending contract order. Harte projection still orders its output degrees numerically.

The opening Receipt also retains its complete current audit, including the exact evaluation context; the real-file CLI regression reconstructs that audit and verifies hash equality.

# Alignment Jobs and lyric timing correction

Implementation issue: [Implement Alignment Jobs and lyric timing correction](https://github.com/qisoft/open-chords/issues/58).

Base: merged Model Store implementation, `5838c2de098e4777c810cb0d1961f117311e94f8`.

## Scope and authority

Align one immutable Reference Lyrics document against one existing Analysis Revision and its verified canonical audio. Preserve original Unicode ranges, line identities and distinct token occurrences. Main owns exact dependency resolution, bounded execution, validation and atomic publication. Missing packs leave lyrics untimed. Alignment neither performs speech recognition nor rewrites the document or raw Analysis Revision.

Line and word coverage remain separate. Unmatched occurrences receive no interval; OOV, repetition, absent lines, annotations, melisma, backing vocals and anchor conflicts remain visible uncertainty. Timing corrections and scoped anchors are user-authored edits with Undo/Redo, separate from immutable machine evidence. EN/RU quality remains benchmark-gated.

## Confirmed test seams

The user confirmed all three seams on 2026-09-07.

1. Public main-owned Alignment Job lifecycle: create/reuse exact immutable requests, inspect blocked dependencies, run/cancel/retry, reject stale or invalid results, reopen durable state and publish all-or-nothing. Exercise real temporary Project/Model Store storage and the external worker boundary. Cover exact document/revision/audio/model identity, normalization mapping, distinct occurrences, coverage and cleanup.
2. Named desktop capabilities and user-visible flow: request alignment, show progress and uncertainty, select available results, correct available line/word intervals, mark unmatched and add scoped anchors. Verify committed Project views through real library/gateway and renderer boundaries, including Undo/Redo and unchanged source text/raw Alignment.
3. Installed macOS arm64 and Windows x64 artifacts: run real MFA with exact EN/RU packs inside the native containment domain, verify no network or host-data access, cancellation/process cleanup and removal of temporary corpora, then reopen the accepted result through named IPC. Functional fixtures prove execution and provenance, not musical quality or Support Claims.

Tests are restricted to these confirmed public boundaries.

## Integration constraints

- The existing MFA entry accepts only `--probe` and is signed for standalone probing. Accepting user media requires contained worker execution and matching native signing/verification, not extending the direct probe process.
- Reuse the existing fail-closed native broker boundary. Stage only the selected verified Project Range and exact required model data; do not grant access to the Project Library, Source paths or global Model Store.
- Coordinate Alignment with the existing globally bounded CPU-heavy analysis execution. Do not introduce an independent unbounded runner.
- Extend the Project's immutable result/provenance and edit contracts with explicit migration where needed. Existing supplied line timing is distinct from machine alignment evidence.

## Implementation order

After seam confirmation, proceed one red-to-green vertical slice at a time: blocked exact request and durable identity; bounded contained execution and validated publication; uncertainty/occurrence mapping; nondestructive correction through the desktop surface; native installed evidence and review. Record final-head checks and review fixes in the issue and PR, leaving the issue open until merge.

## Implemented behavior and evidence

Recipes retain document/revision/audio identities, original occurrence IDs, selected anchors, exact data artifacts, the release runtime manifest hash, and a fixed Kalpy execution profile. Jobs expose durable state and bounded stage/elapsed progress, require confirmation after restart, share the CPU ceiling with Analysis, and publish only after native teardown and corpus removal. Recovery reconciles a published immutable result without executing MFA twice. An opaque workspace journal permits cleanup after an interrupted application without accepting filesystem paths from the renderer or journal.

The desktop capability supports status, start, cancel, retry, and explicit result selection. The UI exposes distinct word/line coverage, uncertainty and unmatched reasons, interval correction, marking unmatched, and scoped anchors. Existing Edit History provides branching Undo/Redo. Contract 1.3 adds provenance and anchor operations; migration retains existing content, and older readers open the future minor read-only.

Local macOS arm64 installed evidence on 2026-09-07: exact EN/RU packs executed inside the signed XPC containment domain; cancellation returned no new Alignment and removed the corpus; recovery removed a staged interrupted corpus; the installed renderer reopened and selected both published results through named capabilities. Synthetic audio exercises execution and abstention, not lyric accuracy. Matched words remain low-confidence with uncalibrated Kaldi likelihood evidence; unsuccessful acoustic paths become `alignment_mismatch`. The worker does not claim to distinguish absent lines, melisma, or backing vocals acoustically. Those conditions require benchmark fixtures and review, not invented intervals or support claims.

The worker uses the existing length-prefixed session client, including manifest/capability handshake, nonce/sequence validation, heartbeat deadlines, cancellation acknowledgement and native termination. Output is a bounded, hash-verified artifact. Sleep/resume invalidates active sessions. Integrity/protocol failures and repeated worker failures open a runtime circuit; unconfirmed teardown retains its journal and blocks all further CPU-heavy work until restart. Draft timing fields retain their original committed revision until explicit reset/reselection.

The local MFA payload measures 667,457,858 installed bytes and 288,767,368 transfer bytes. Per-target final CI measurements and Windows installed evidence must be recorded in the PR before readiness.

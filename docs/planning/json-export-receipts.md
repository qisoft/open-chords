# Open Chords JSON and Export Receipts

Implementation ticket: [Implement Open Chords JSON and Export Receipts](https://github.com/qisoft/open-chords/issues/41).

Authority: specification section 14 and the repository domain language in `CONTEXT.md`.

## Outcome

Export one immutable committed Active View as a deterministic semantic JSON snapshot and retain a durable Project-owned Export Receipt. Later edits cannot alter an in-progress export. Musical Project contents remain unchanged; recording a Receipt is an explicit Library mutation.

## Confirmed test boundaries

The user confirmed all three boundaries on 2026-09-09.

1. Public semantic export API: immutable snapshot capture, versioned profile, independent canonical-byte vectors, strict semantic schema validation, selected lyrics/alignment, safe provenance and exclusion of private or operational data.
2. Named desktop capability and UI: main-owned target selection, bounded requests, explicit cancellation and errors, atomic publication, durable Receipt and preserved musical Project contents.
3. Installed macOS/Windows artifact: actual native save dialog, cancellation, target/write failure, no apparently successful partial output, and Receipt recovery after reopening the application.

## Implementation constraints

- Reuse the domain's Effective Timeline projection and committed Active View semantics; exclude Editor Drafts and later revisions from the captured export.
- Select output fields explicitly. Do not serialize a Project envelope, Source Locator, arbitrary extensions, undo branches, Attempts, caches, media or practice state.
- Include selected lyrics with attribution and notices automatically. Do not add a rights confirmation or provider-based export gate.
- Keep Original Chord Identities separate from declared presentation transforms.
- Main owns native target selection and writing. Renderer input cannot supply an arbitrary filesystem path or generic filesystem command.
- Reuse the existing Export Receipt record and Library publication/recovery mechanisms. Define the target/Receipt failure boundary explicitly; an output write and a Receipt commit are not one filesystem transaction.
- Preserve an existing destination on cancellation or failed publication. Never report success for a partial target or lose a completed export's Receipt silently.
- Portable Project Archives and human-facing export formats remain separate implementation tickets.

## Starting state

PR 82 is merged at `d56dbe063ad74c90348eed52bfdd964328baef46`. All native blockers for this ticket are closed. YouTube acquisition remains blocked by the open installed-player acceptance ticket; JSON export does not depend on it.

The current Library already validates Project-owned Export Receipts. There is no implemented semantic export module or named export capability yet.

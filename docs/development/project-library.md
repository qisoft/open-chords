# Project Library

Issue [#39](https://github.com/qisoft/open-chords/issues/39) owns the durable, main-process Project Library. The renderer and preload never receive this interface, a host path, a Source Locator, or an Export Receipt location.

## Interface

`openProjectLibrary` returns one deep main-owned module. Its interface supports:

- creating, reading, and subscribing to committed Project snapshots;
- committing one validated Edit Transaction against an expected Project Revision;
- restoring and migrating a trusted prior revision, and publishing rollback as another revision;
- recoverable Library Trash, explicit permanent deletion, and age-bounded Empty Trash;
- validated relocation to another local-disk directory while retaining the previous copy.

The same interface is the production `ProjectAuthority` used by the typed desktop command gateway. A newer safely understood minor schema remains readable but returns `project_read_only` for mutation. Project Library records keep Source identity, private Locators, immutable Source Snapshots and metadata observations, Project Range, and Export Receipts beside the canonical Project envelope; none of those main-only records cross the current IPC snapshot seam.

## Durable publication

Project payloads and Project Revision records are canonical JSON objects addressed by SHA-256. Each Project also has an immutable ordered revision-pointer ledger and one small `HEAD.json`. A mutation is published in this order:

1. build and validate the complete Project payload in Library-local staging;
2. write and sync the payload, Project Revision, revision pointer, and candidate Head;
3. install the immutable objects and revision pointer;
4. atomically replace `HEAD.json`, sync the resulting file, and sync directories where the platform permits it;
5. reopen and validate the committed Head before returning success or notifying subscribers.

The project index is rewritten from verified Heads and is never used as authority. Tests inject failures after payload sync, after revision publication, immediately before Head replacement, and immediately after it; reopening exposes either the old or new complete Head, never a mixed payload.

## Startup and recovery

Startup removes abandoned staging directories before accepting work. Every active Head, revision object, content hash, Project envelope, domain invariant, Source record, and receipt is revalidated. If the active Head cannot be resolved, it is moved to `quarantine/` and the newest verified revision-pointer entry is republished as Head. Recovery writes an explicit loss report. If no verified revision exists, the Project remains listed as `damaged` and reads fail rather than inventing or silently repairing state.

Opening an older supported schema preserves its restored revision before running registered migrations. Each migration produces and validates another Project Revision before Head changes. A failed migration leaves the prior revision readable and unchanged. Rollback likewise publishes a new revision from a compatible retained payload; it does not rewrite history or downgrade in place.

## Location and deletion policy

The state root holds only the atomic active-location record and the default Library directory. Relocation copies to same-parent staging, scavenges copied staging, validates all active and trashed Projects, renames the complete copy into place, and then atomically switches the location record. The old Library is retained.

The default path policy rejects UNC paths, known network filesystem types, and known cloud-sync path roots such as iCloud Drive/CloudStorage, OneDrive, Dropbox, and Google Drive. A platform adapter can make this policy stricter without changing the Project Library interface.

Deleting a Project first moves its owned records to Library Trash. Restore is reversible. Immediate permanent deletion requires the exact Project ID as confirmation; default Empty Trash selects records older than 30 days. These operations remove Library-owned records only and never delete external Source media, export targets, or already-created archives.

## Verification

Run:

```sh
pnpm exec vitest run tests/project-library.test.ts
pnpm validate
```

The focused suite covers durable reopen, subscriber ordering, crash injection, corrupt-Head recovery, damaged visibility, newer-minor read-only behavior, migration failure, migration/rollback history, Trash, explicit deletion, relocation, and index rebuilding.

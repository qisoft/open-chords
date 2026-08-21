# Project Library

Issue [#39](https://github.com/qisoft/open-chords/issues/39) owns the durable, main-process Project Library. The renderer and preload never receive this interface, a host path, a Source Locator, or an Export Receipt location.

## Interface

`openProjectLibrary` returns one deep main-owned module. Its interface supports:

- creating, reading, and subscribing to committed Project snapshots;
- committing one validated Edit Transaction against an expected Project Revision;
- restoring and migrating a trusted prior revision, and publishing rollback as another revision;
- recoverable Library Trash, explicit permanent deletion, and age-bounded Empty Trash;
- validated relocation to another local-disk directory while retaining the previous copy.

The same interface is the production `ProjectAuthority` used by the typed desktop command gateway. Structurally understood newer schemas remain readable but return `project_read_only` for mutation; incompatibility is not corruption and never triggers Head recovery. Project Library records keep Source identity, private Locators, immutable Source Snapshots and metadata observations, Project Range, and Export Receipts beside the canonical Project envelope. Snapshot validation binds local byte fingerprints or YouTube acquisition video IDs to Source identity and retains selected media format plus exact component/policy provenance. Publication also verifies that the Project Range length matches the Project duration and fits a retained Source Snapshot. None of those main-only records cross the current IPC snapshot seam.

## Durable publication

Project payloads and Project Revision records are canonical JSON objects addressed by SHA-256. Each Project also has an immutable ordered revision-pointer ledger and one small `HEAD.json`. A mutation is published in this order:

1. build and validate the complete Project payload in Library-local staging;
2. write and sync the payload, Project Revision, revision pointer, and candidate Head;
3. install the immutable objects and revision pointer;
4. atomically replace `HEAD.json`, sync the resulting file, and sync directories where the platform permits it;
5. reopen and validate the committed Head before returning success or notifying subscribers.

The project index is rewritten from verified Heads and is never used as authority. A Head must identify a member of one unambiguous, parent-linked revision-pointer chain. A durable pointer beyond the Head is unpublished crash residue and is discarded on open; only successful atomic Head replacement makes that revision current. Tests inject failures after payload sync, after revision publication, immediately before Head replacement, and immediately after it; reopening exposes exactly the old Head before replacement and the new complete Head after replacement, never a mixed payload.

## Startup and recovery

Startup removes abandoned staging directories before accepting work. Every active Head, revision object, content hash, Project envelope, domain invariant, Source record, and receipt is revalidated. If the active Head cannot be resolved, it is moved to `quarantine/` and the newest verified revision-pointer entry is republished as Head. Recovery writes an explicit loss report. If no verified revision exists, the Project remains listed as `damaged` and reads fail rather than inventing or silently repairing state.

Opening an older supported schema automatically runs registered migrations after preserving and validating its current revision. Envelope and Project schema versions may advance independently; the migration graph must be unique, bounded, and strictly advancing. The complete chain is evaluated and validated in memory, then published as one new Project Revision. A failed or unavailable step leaves the prior revision readable, unchanged, and read-only. Rollback can select the pre-migration backup, replay the current migration chain, and publish the result as a new rollback revision; it does not rewrite history or downgrade in place.

## Location and deletion policy

The state root holds only the atomic active-location record and the default Library directory. Every fixed managed directory must be a real directory canonically contained by the active root; symlinks and special files are rejected before traversal or startup scavenging. Relocation copies to same-parent staging, scavenges copied staging, validates all active and trashed Projects, syncs the complete tree, renames the copy into place, and then atomically switches the location record. The old Library is retained.

The default path policy resolves existing ancestors to prevent symlink bypasses, rejects UNC and Windows remote drives, requires a local macOS mount or an allowlisted local Linux filesystem, and rejects known cloud-sync path roots such as iCloud Drive/CloudStorage, OneDrive, Dropbox, and Google Drive. A platform adapter can make this policy stricter without changing the Project Library interface.

Deleting a Project first moves its owned records to Library Trash. Restore is reversible. Immediate permanent deletion requires the exact Project ID as confirmation; default Empty Trash selects records older than 30 days. After permanent deletion, the Library reclaims only content-addressed objects that no remaining active or trashed revision references, and defers reclamation entirely while any Project is damaged. These operations remove Library-owned records only and never delete external Source media, export targets, or already-created archives.

## Verification

Run:

```sh
pnpm exec vitest run tests/project-library.test.ts
pnpm validate
```

The focused suite covers durable reopen, subscriber ordering, crash injection, Head-to-ledger verification, corrupt-Head recovery, damaged visibility, newer-minor read-only behavior, startup migration and migration failure, migration/rollback history, reference-aware deletion, Trash validation, relocation, and index rebuilding.

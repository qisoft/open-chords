# Project Library

Issue [#39](https://github.com/qisoft/open-chords/issues/39) owns the durable, main-process Project Library. The renderer and preload never receive this interface, a host path, a Source Locator, or an Export Receipt location.

## Interface

`openProjectLibrary` returns one deep main-owned module. Its interface supports:

- creating, reading, and subscribing to committed Project snapshots;
- committing one validated Edit Transaction against an expected Project Revision;
- restoring and migrating a trusted prior revision, and publishing rollback as another revision;
- recoverable Library Trash, explicit permanent deletion, and age-bounded Empty Trash;
- validated relocation to a canonical local-disk directory while retaining the previous copy and reconciling failures against the durable location record.

The same interface is the production `ProjectAuthority` used by the typed desktop command gateway. Safely understood newer minor schemas remain readable but return `project_read_only` for mutation; unknown core semantics and unknown majors are rejected without being mislabeled as corruption or triggering Head recovery. Project Library records keep Source identity, private Locators, immutable Source Snapshots and metadata observations, Project Range, and Export Receipts beside the canonical Project envelope. Library-wide validation prevents one Source ID from changing identity, deduplicates equal local fingerprints or YouTube video IDs, and prevents a Snapshot or Metadata Observation ID from changing immutable content. Current mutable Locator authority is retained in a versioned durable Library-wide Source catalog with a last-known-good copy: distinct Locator IDs are additive, later verification/observation replaces an earlier state, and duplicate or conflicting equal-time states are rejected. Every catalog candidate is rebound to each referenced Source and revalidated as a complete record before use. New entries and their catalog are swapped into the live read snapshot together only after both catalog copies are durable. Before a corrupt primary is quarantined and recovered from the validated copy, durable recovery intent is recorded in a Library report. The catalog keeps current Locator state while any Project still references the Source, defers pruning entirely while a non-deleted damaged Project has unknown references, and therefore cannot regress another Project's read merely because the Project that supplied the newest observation was deleted. Snapshot validation binds local byte fingerprints or canonical YouTube acquisition video IDs to Source identity and retains byte size, provider format ID, named component version/hash records, policy provenance, bounded broker counters, and any available acquisition-time metadata observation references, which cannot postdate the Snapshot. Best-effort public metadata may be absent without invalidating an otherwise successful acquisition. Publication also verifies that the Project Range length matches the Project duration and fits a retained Source Snapshot. None of those main-only records cross the current IPC snapshot seam.

## Durable publication

Project payloads and Project Revision records are canonical JSON objects addressed by SHA-256. Each Project also has an immutable ordered revision-pointer ledger and one small `HEAD.json`. A mutation is published in this order:

1. build and validate the complete Project payload in Library-local staging;
2. write and sync the payload, Project Revision, revision pointer, and candidate Head, with the staging-directory entry made durable before pointer installation;
3. install the immutable objects and revision pointer;
4. atomically replace `HEAD.json`, sync the resulting file, and sync directories where the platform permits it;
5. reopen and validate the committed Head before returning success or notifying subscribers.

The project index is rewritten from verified Heads and is never used as authority. A Head must identify a member of one unambiguous, parent-linked revision-pointer chain. A durable pointer beyond the Head is unpublished crash residue and is discarded during immediate failure reconciliation or on open, including while an older corrupt Head is recovered; only successful atomic Head replacement makes that revision current. Tests inject failures after payload sync, after revision publication, immediately before Head replacement, and immediately after it; the live instance and a reopened Library expose exactly the old Head before replacement and the new complete Head after replacement, never a mixed payload.

## Startup and recovery

Startup uses durable staged Heads to identify and discard unpublished pointer tails, then removes abandoned staging directories before accepting work. Every active Head, revision object, content hash, Project envelope, domain invariant, Source record, and receipt is revalidated. If the active Head cannot be resolved, it is moved to `quarantine/` and the newest verified revision-pointer entry below any unpublished boundary is republished as Head. Recovery writes an explicit loss report. If both Head and its publication boundary are missing, or if no verified published revision exists, the Project remains listed as `damaged` and reads fail rather than guessing or silently inventing state.

Opening or restoring an older supported schema automatically runs registered migrations after preserving and validating its current revision. Envelope and Project schema versions may advance independently; the migration graph must be unique, bounded, and strictly advancing. The complete chain is evaluated and validated in memory, then published as one new Project Revision. A failed or unavailable step leaves the prior revision readable, unchanged, and read-only with an explicit migration-failure reason; restore returns that committed read-only revision and its failure state instead of implying that nothing was stored. Reconciled publication failures likewise retain the verified old or newly committed Head; an uncertain durability boundary blocks further mutation until reopen. Rollback can select the pre-migration backup, replay the current migration chain, and publish the result as a new rollback revision; it does not rewrite history or downgrade in place.

## Location and deletion policy

The state root holds the atomic active-location record, a durable in-progress relocation journal when needed, and the default Library directory. The active root and relocation targets are canonicalized before containment checks. Every fixed managed directory and per-Project directory must be a real directory canonically contained by the active root; symlinks and special files are rejected before traversal, mutation, deletion, or startup scavenging. Relocation requires an existing durable target parent, journals its canonical path and filesystem identity plus exact random staging, cleanup, and final target paths before copying, and rechecks that parent identity at each copy/install boundary. It marks owned artifacts, validates all active and trashed Projects, syncs the complete tree, renames the copy into place, and then atomically switches the location record. Cleanup first atomically claims an owned directory at its journaled random cleanup path, then revalidates the claimed directory and marker before removal. A retry of the same canonical local target removes a journal-owned partial setup, safely removes an exact empty wrapper left before its marker was written, or discards a marked interrupted target before copying the authoritative current root again. Reopen scavenges a journal-owned wrapper after an already committed switch; unrelated or nonempty ambiguously owned paths are never removed. Any later failure first reconciles the live root against the durable record before cleanup is reported. The old Library is retained after successful relocation.

The default path policy resolves existing ancestors to prevent symlink bypasses, rejects UNC and Windows remote drives, requires a local macOS mount or an allowlisted persistent local Linux filesystem, and rejects volatile `tmpfs`/`ramfs` plus known cloud-sync path roots such as iCloud Drive/CloudStorage, OneDrive, Dropbox, and Google Drive. A platform adapter can make this policy stricter without changing the Project Library interface.

Deleting a Project first moves its owned records to Library Trash. Restore is reversible. Immediate permanent deletion requires the exact Project ID as confirmation; default Empty Trash selects records older than 30 days. Each lifecycle mutation reconciles its in-memory authority from disk after a post-move/delete failure. A parent-directory sync failure blocks further mutation and defers object collection until reopen establishes a durable state. After a durable permanent deletion, the Library reclaims only content-addressed objects that no remaining active or trashed revision references, and defers reclamation entirely while any Project is damaged. These operations remove Library-owned records only and never delete external Source media, export targets, or already-created archives.

## Verification

Run:

```sh
pnpm exec vitest run tests/project-library.test.ts
pnpm validate
```

The focused suite covers durable reopen, subscriber ordering, crash injection, Head-to-ledger verification, unpublished initial revision cleanup, corrupt-Head recovery, damaged visibility, newer-minor read-only behavior, startup migration and migration failure, migration/rollback history, reference-aware deletion and startup collection, Trash validation, relocation reconciliation and canonicalization, and index rebuilding.

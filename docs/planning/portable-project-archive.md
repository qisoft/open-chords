# Portable Project Archive import and export

Implementation ticket: [Implement Portable Project Archive import and export](https://github.com/qisoft/open-chords/issues/61).

Authority: specification sections 6.1, 6.3, 6.4 and 14, and the domain language in `CONTEXT.md`.

## Outcome

Export one complete retained Project as a versioned, hash-manifested ZIP and import it into another Project Library without trusting any byte of it. Import either publishes one complete Project or changes nothing in the Library.

## Test boundaries

1. Archive module interface. Deterministic bytes, a manifest that hashes and declares every entry, complete round trip of retained history, exact external requirements, and optional verified Project Range media.
2. Hostile import. One crafted archive per rejection class, each proving that the Library and the Offline Media Cache stay unchanged.
3. Capability boundary. The import module graph has no network, process, model, credential or code-execution path. Only main-owned named capabilities export and import. Renderer input cannot name a path.
4. Desktop UI. The real main, IPC, archive and Library code with only the native picker result replaced. The installed artifact reopens archive Export Receipts through the bounded capability.

## Implementation constraints

- Carry complete retained Project history: every Analysis Revision and Manifest, Edit Layer transaction history, Lyrics Document and Alignment, practice state, Export Receipts, Source identity, Snapshots and Metadata Observations.
- Remove machine-local authority. Local file Locators and private receipt destinations never leave the Library.
- Declare exact analysis components, numerical backends, alignment Model Artifacts and alignment runtimes. Import never installs, downloads or resolves them.
- Include Source media only on explicit request, only from a verified Source, and only for the Project Range. On explicit request at import, included media becomes an Offline Media Cache entry labelled with how it was verified, never a new Source or Locator.
- Never overwrite or merge histories. An identity conflict creates an Imported Project Copy that keeps its origin identity as provenance.
- Reuse the Export Receipt, destination validation, publication journal and recovery of the JSON export slice.

## Starting state

PR 89 is merged at `0a0bf37`. The JSON export slice (#41) provides Export Receipts and main-owned publication. Local media (#32) provides a cache seam but no Offline Media Cache store. The Project contract has no field for import origin.

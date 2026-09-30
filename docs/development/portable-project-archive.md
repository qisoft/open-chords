# Portable Project Archive

Issue [#61](https://github.com/qisoft/open-chords/issues/61) owns archive export and hostile archive import. The planning surface is [portable-project-archive.md](../planning/portable-project-archive.md).

## Interface

Main owns both directions. The renderer calls `exports.perform` with `save_archive` (Project identity, expected saved revision, `includeMedia`) and `archives.import` with no arguments. Main opens the native picker and owns every path. Results expose a basename, hashes and a typed outcome, never a host path.

- `ProjectExports.saveArchive` captures the saved Project, optionally reads the verified Project Range, writes the archive and records a `project_archive` Export Receipt. It shares the JSON profile's destination checks, recovery journal and Receipt recovery.
- `ProjectArchiveImports.importArchive` quarantines, inspects, reconciles identity and publishes. It returns `imported`, `already_present`, `cancelled` or `rejected` with one reason code.
- `inspectPortableProjectArchive` is the pure validation step. It takes the quarantined bytes and returns a validated document, or throws `ArchiveRejectionError`.

## Archive layout

The archive is a ZIP with the `.ocarchive` extension. Open Chords writes, and reads, only this profile:

| Entry | Content |
| --- | --- |
| `manifest.json` | `open-chords/portable-project-archive` 1.0: the size and SHA-256 of every other entry, exact external requirements, and the optional media declaration. |
| `project.json` | `open-chords/portable-project` 1.0: the Project envelope and Project-owned records. |
| `media/project-range.pcm` | Optional. Canonical mono PCM16 little-endian samples of exactly the Project Range. |

Every JSON entry is canonical: sorted keys, two-space indentation, UTF-8 and a final LF. Entries have fixed 1980-01-01 timestamps, no extra fields and no comments, so equal Projects produce equal bytes. The Receipt `activeViewHash` for this profile is the SHA-256 of `project.json`, which identifies the complete captured Project.

The document keeps the complete retained history: every Analysis Revision and Manifest, Edit Layer transaction history, Lyrics Documents and Alignments, practice state, Support Claims, namespaced extensions, Export Receipts, Source identity, Snapshots and Metadata Observations. Local file Locators are removed, because they are private paths. Earlier Receipt destinations are reduced to file names. Both removals are recorded as Receipt omissions. YouTube Locators are kept, because they are canonical public URLs rebuilt from the video ID.

The Library's Project Revision ledger is not in the archive. That ledger is Library persistence, and the Project Head already contains every retained non-derived record. Import publishes the archived Project as one `restored` revision, and then runs the same registered migrations as any restored older schema.

Requirements are derived, not trusted. They list Analysis Recipe components and numerical backends, alignment Model Artifacts and alignment runtime manifests. Import compares the declaration with the list derived from the document. Import never resolves, installs or downloads a requirement. Missing Model Store artifacts stay visible as blocked dependencies when analysis or alignment is next requested.

## Hostile import

Import reads the selected regular file through one no-follow descriptor with a 160 MiB ceiling. That private in-memory copy is the quarantine. The Library, the Offline Media Cache and the filesystem see nothing from the archive until every check passes. Structural ZIP checks run first, then entry names, content, declarations and Library authority. The first failed check is the reported reason:

| Reason | Rejected input |
| --- | --- |
| `unreadable_archive` | A link, a directory or an unreadable selection. |
| `size_limit` | An archive over 160 MiB, more than 8 entries, an entry over 128 MiB, more than 160 MiB of declared content, or inflation past the declared size. |
| `malformed_zip` | Trailing or prefixed bytes, overlapping or non-contiguous entries, local and central header disagreement, a CRC failure or a corrupt stream. |
| `unsupported_zip_feature` | ZIP64, several disks, data descriptors, extra fields, comments, or methods other than stored and deflate. |
| `encrypted_entry` | Traditional or strong encryption, an encrypted central directory, or the AES method. |
| `link_entry` | Symbolic links, Windows reparse points and special files. |
| `unsafe_path` | Absolute, drive-qualified, backslash, `.`, `..`, empty, directory, control or format character names, and invalid UTF-8. |
| `name_collision` | Names that are equal after NFKC normalization and case folding. |
| `compression_ratio` | A deflated entry over 1 MiB that expands more than 200 times. |
| `active_content` | Executable, script, HTML, SVG, shortcut and native library names. |
| `undeclared_entry` | Any entry outside the fixed layout, or media the manifest does not declare. |
| `missing_entry` | A missing manifest, Project document or declared media. |
| `schema_invalid` | Non-canonical or duplicate-key JSON, unknown fields, private Locators or Receipt paths. |
| `unsupported_version` | Another archive format version, a newer contract minor, or another contract major. |
| `declaration_mismatch` | Sizes, requirements, sample rate or media length that differ from the declaration. |
| `hash_mismatch` | An entry that differs from its SHA-256, or full-range media that differs from its Snapshot's canonical-audio fingerprint. |
| `reference_invalid` | Records or media that reference an unknown Source, Snapshot or range. |
| `invariant_invalid` | Anything the Project Library itself would refuse: domain invariants, Manifest provenance and Project Range fit. |
| `source_conflict` | A Source or Snapshot that redefines one the Library already owns. |
| `identity_exhausted` | 100 existing Imported Project Copies with different histories for one archive. |

The import module graph contains only archive, cache, records, payload and bounded file modules. A test walks its value imports and fails on Electron, Effect, process, network, DNS, TLS, VM, worker, model, acquisition, lyrics, YouTube and sidecar modules, and on `fetch`, `spawn`, `execFile`, `eval`, `safeStorage` or `openExternal` calls. A second test runs an import while `fetch` throws.

## Identity

Source authority belongs to the Library. An archived Source that the Library does not know imports without Locators. It is an Unavailable Source: the Project opens, playback reports that the Source is unavailable, and a later relink to matching content restores it. When the Library already owns the Source, the imported Project uses the Library's retained Snapshot records and current Locators. A Source or Snapshot that disagrees with the Library is rejected.

Project identity is resolved without overwriting or merging:

1. The archived identity is free. The Project is imported under it.
2. An active Project with that identity has exactly the archived history. The import reports `already_present` and changes nothing.
3. Otherwise the import tries up to 100 deterministic Imported Project Copy identities, derived from the origin identity, the manifest hash and a counter. Each copy appends `{ projectId, archiveManifestHash }` to `importOrigins`. Contract 1.4 accepts Analysis Revisions and Alignment Recipes that belong to the Project or to one of its import origins, so history keeps its original provenance.

Retrying one archive therefore converges on the copy it already created. A copy that was edited afterwards is a different history, so the next import creates another copy.

## Offline Media Cache

Media inclusion is an explicit export option. Export reads the Project Range through the same verified local-file path as playback, which rejects a changed or unavailable Source. When the Range cannot be verified, the export reports `media_unavailable` and writes nothing.

On import, validated media becomes one entry in `offline-media-cache/` under application state, outside the Project Library. The entry records Source, Snapshot, Range, sample rate, byte size, SHA-256 and archive origin. It is written durably through a staging file before its record. Listing and reading verify the SHA-256 again, and a corrupt entry is treated as absent. An entry that already covers the same Range with different bytes rejects the import. The media never becomes a Source, Snapshot or Locator.

## Verification

```sh
pnpm exec vitest run tests/project-archive.test.ts tests/project-archive-hostile.test.ts tests/project-archive-boundary.test.ts tests/project-archive-desktop.test.ts
pnpm build:test && pnpm exec playwright test tests/renderer/archive.spec.ts
pnpm validate
```

The installed macOS and Windows test reopens JSON and archive Export Receipts and checks the named archive capability. Like the JSON profile, it does not claim interaction with the native save or open dialogs.

## Not yet covered

- Native save and open dialog interaction for archives on macOS and Windows has not been observed.
- The Offline Media Cache has no user-visible inspection, removal or quota controls, and playback does not read from it yet. Imported media is stored and verified, not used.
- Import does not report which declared requirements are missing from the local Model Store.

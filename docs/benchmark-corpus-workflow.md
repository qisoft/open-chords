# Benchmark Corpus tooling

These engineering tools implement the Rights Ledger, Gold Reference interchange and corpus custody workflow for [issue 47](https://github.com/qisoft/open-chords/issues/47). They do not run analysis, select metric thresholds or authorize a Support Claim. The desktop application does not import this module.

The user requested tools first. Only **synthetic workflow fixtures** are available. There are no 30–50 authorized recordings, independent human submissions, measured inter-annotator reliability or approved release policy in this change. Real-corpus acceptance remains open.

## Public boundaries

`tools/benchmark/index.ts` exports the rights evaluator, annotation validation/adjudication, canonical hashing, JAMS mapping, corpus audit and file custody functions. `pnpm benchmark` exposes the same workflows through Node 24+:

```text
pnpm benchmark audit INPUT.json REPORT.json
pnpm benchmark adjudicate SUBMISSIONS-AND-DECISION.json GOLD.json
pnpm benchmark validate-gold GOLD.json
pnpm benchmark to-jams GOLD.json GOLD.jams
pnpm benchmark from-jams GOLD.jams GOLD.json
pnpm benchmark publish INPUT.json NEW-BUNDLE-DIRECTORY CUSTODIAN-PUBLIC.pem FREEZE-AUTHORITY-PUBLIC.pem
pnpm benchmark verify BUNDLE-DIRECTORY
pnpm benchmark open-sealed BUNDLE-DIRECTORY NEW-RELEASE-DIRECTORY POLICY FREEZE.json CURRENT-RIGHTS.json TRUSTED-AUTHORITY-PUBLIC.pem < CUSTODIAN-PRIVATE.pem
```

Input/output paths are operator supplied. Run in a protected custodian directory; do not put private inputs, grants, media or generated reports in Git or ordinary CI artifacts. JSON inputs are bounded to 32 MiB. Media streams through the filesystem rather than entering JSON or command arguments. Errors use the fixed `benchmark_failed` diagnostic and exit status 1, without leaking paths, grants, lyrics or crypto error details. Success uses `benchmark_ok` and exit status 0. Existing output files/directories are rejected. JSON artifacts use exclusive hard-link publication after syncing complete bytes; corpus directories are staged and renamed after validation. Windows requires a local filesystem supporting hard links. Directory fsync is used where supported by Node on Unix; the tool does not claim power-loss durability for Windows directory metadata.

The TypeScript schemas are authoritative for input structure. `tests/support/benchmark-fixture.ts` contains a clearly synthetic two-track example; `tests/benchmark-storage.test.ts` demonstrates an executable file/key/freeze round trip without external services.

## Rights and coverage

A reviewed grant identifies an asset and stable subject, its licensor/source/license, evidence hashes, review dates, attribution/notices, territory, expiry, termination/deletion status and permitted execution locations. Each operation has an independent `allowed`, `denied` or `unknown` declaration. Recording, composition, lyrics, each raw annotation and the adjudicated annotation have separate subjects. Results permissions are evaluated through the same public Rights Ledger API when a later reporting workflow requests disclosure.

The evaluator is not a legal inference engine. It checks maintainer-reviewed declarations for a specified time, territory, execution location and use. Missing, duplicated, ambiguous, revoked, expired, unreviewed, unknown or denied declarations fail closed. Source URLs and a repository license never imply permission. The reviewer must translate contractual termination conditions into the current disposition/deletion flag; free text is retained as evidence, not interpreted automatically.

A corpus manifest supplies explicit capability/slice requirements, reviewed slice assignments and source hashes. Every track binds at least one Gold Reference, one recording group, composition/artist groups, sample clock and a calibration/sealed cohort. Alternate encodings and transformations belong to one recording entry's `sourceHashes`; duplicate recording groups and cross-track byte hashes are rejected. A maintainer must detect transformations that cannot be identified by byte equality. Composition/artist crossings require explicit reviewed disclosure.

The audit derives private storage, analysis, human annotation and derivative permissions from each reference; remote execution also requires private CI transfer. Lyrics alignment additionally requires the lyrics subject. Coverage reports distinct rights-eligible tracks and whole-track inventory duration separately from positive event counts/durations and explicit negative evidence for each requested capability/slice in each cohort. Rhythm counts beats and metered duration; meter counts bars; harmony/key/sections count known events; lyrics counts matched token occurrences. N, Unknown, Unmetered and unmatched tokens remain visible in separate negative counts (unmatched tokens have no invented duration). `inventoryComplete` only means every requested row has a rights-eligible reference. Zero positive events remain visible; `metricSufficiency` stays `not_evaluated`, including when negative evidence is the intended slice. The requirement inventory itself needs policy review: these tools cannot infer musical slice labels or decide that a declared inventory is sufficient for release. Missing coverage remains incomplete. Raw/adjudicated identity and hash substitutions are rejected.

Audit reports are **private operator artifacts**, including cohort accounting and denied track pseudonyms. They are not automatically eligible for aggregate or per-track publication. A public report needs a separate disclosure review and rights request. `releaseEvidence` is always false, `reliability` is always `not_measured`; the 30–50 complete-track range is reported separately. A release-purpose manifest rejects annotations marked `synthetic_fixture`.

## Gold References and JAMS

Raw submissions record exact sample intervals, audio/guide hashes, tool version, timestamps, pseudonymous qualified annotators and attestations of blindness to candidate output and the other submission. The tools verify these declarations and distinct identities; actual qualifications and independent human work require external evidence. Synthetic submissions and adjudication are explicitly marked and cannot mix with human records.

Adjudication has its own third identity, guide, time, exact hashes of both raw submissions, complete result and interval-specific reasons. Original submissions remain inside the Gold Reference. Reasons must cover disagreement, reported ambiguity and changes made by the adjudicator even when both submissions agreed. Interval labels preserve boundary disagreements. Rhythm/meter/lyrics structural differences conservatively retain a whole-track disagreement until the dependent metrics work supplies task-specific reliability measures.

Hashing uses the existing Open Chords canonical serializer: recursively sorted object keys, preserved array order, finite JSON numbers, two-space indentation and a final LF, encoded as UTF-8 and SHA-256. A stored Gold Reference is rebuilt and compared on reopening; changing raw data, hash links, adjudication or the disagreement record invalidates it. Files are immutable publications: revisions go to a new output path and have a new content hash.

JAMS output follows the pinned 0.3.5 schema. Register `tools/benchmark/schemata/open-chords-namespaces.json` with `jams.schema.add_namespace` when using Python JAMS. Two `open_chords_raw_v1` annotations and one `open_chords_gold_v1` annotation carry complete canonical Open Chords records with integer sample identities. Standard chord/key/beat/segment/lyrics annotations are derived views in seconds, with null confidence rather than invented confidence scores.

The standard view loses sample-exact identities, provenance, repeated-section group IDs, ambiguity, line timings, unmatched lyrics, full meter/unmetered regions and the distinction between an `other` key mode and an unspecified mode. Those remain in the canonical namespaces. Chord projection uses explicit Harte degree sets: listed extensions add their stated degree, alterations replace that degree, omissions remove it, and slash bass is relative to the root. It does not infer unlisted seventh degrees for 9/11/13. Preserve the canonical rich identity when exchanging that distinction.

`from-jams` accepts this versioned Open Chords profile, not arbitrary external JAMS. It validates canonical records, rebuilds every derived view and verifies the complete result, rejecting drift or lossy edits. Human annotation tools can submit Open Chords raw records directly; arbitrary JAMS ingestion needs an explicit mapping adapter. Generated namespace schemas are checked by `pnpm contracts:schema:check`; regenerate them with `pnpm benchmark:schema`. Independent Ajv draft-04 validation uses the vendored upstream schema and namespaces.

## Sealed custody and freeze

Publication runs **only in the custodian environment**, which already has legitimate access to the complete corpus. It reads `{manifest, gold, context, media}`; each media entry has `{trackId, path, hash}`. The exact media file digest must appear in that track's source hashes. The tool verifies source bytes, not decoded audio duration or the correctness of externally supplied canonical-audio/timebase declarations; those require actual corpus preparation and acceptance.

The final bundle contains plaintext calibration records/media, encrypted sealed records/media and a hash inventory. Full-corpus audit details are encrypted with the sealed metadata. AES-256-GCM authenticates each sealed file and its opaque storage name. A random bundle key is wrapped to a separate custodian RSA public key with OAEP/SHA-256. The bundle contains neither the private key nor sealed plaintext. Ciphertext count/size and corpus hash are visible; musical content, slice labels and sealed membership are not supplied in plaintext.

Provision **only the final bundle** to tuning. Keep original input files, staging directories, grant evidence, the RSA private key and the Ed25519 freeze signing key in a different protected account/runner or machine. A same-user process with access to custodian inputs can read them; a CLI flag cannot create an OS boundary. On Windows use a protected inherited ACL for the custodian/release directories; POSIX staging uses a private temporary directory. Ordinary CI contains only synthetic fixtures and ephemeral test keys.

The approved authority signs the canonical bytes of this declaration with Ed25519:

```json
{
  "version": "1.0",
  "bundleHash": "sha256:<canonical index.json digest>",
  "corpusHash": "sha256:<canonical manifest digest>",
  "policyHash": "sha256:<exact policy file byte digest>",
  "frozenAt": "<ISO timestamp>",
  "parametersFrozen": true
}
```

`FREEZE.json` contains `{declaration, signature}`, where the signature is base64. Approval and signing happen outside the tuning process; the CLI deliberately has no signing command. Pin the trusted authority public key independently of the bundle. The authority hash is also bound into the bundle index. The full approved policy artifact must include the metric/threshold/run decisions from the dependent policy work: this tool authenticates its bytes and approval, not its scientific adequacy.

Opening requires the matching trusted signature, corpus/bundle hashes, unchanged policy file and the externally held custody key through stdin. Future freeze timestamps, changed policy/ciphertext, wrong keys and existing destinations fail. Opening also requires `CURRENT-RIGHTS.json`: `{declaration, signature}`, signed by the same trusted Ed25519 authority. Its declaration contains `version: "1.0"`, the frozen `corpusHash`, `reviewedAt`, `validUntil`, `context: {territory, executionLocation}`, and the complete current `tracks: [{id, rights}]` ledger. The review must follow policy freeze, encompass its grants' review dates and be valid at opening. Revoked/deletion-required grants therefore override the original frozen snapshot. Rights are re-evaluated against this signed ledger and the current clock; the operator must run in its declared location. The authority controls the validity window and must issue the latest reviewed declaration; this offline tool cannot discover a revocation outside its supplied evidence or revoke a previously signed authorization before that authorization expires. The custodian must withhold the private key when authorization is revoked. Decryption happens in private staging and produces an opening receipt with the freeze, signed current rights review, time and current audit hash. Do not provide the released directory or unwrapped key to tuning, including after the run. The receipt is local evidence, not a central enforcement service: the custodian must retain the approved freeze/receipt and prevent a later re-tuning campaign from reusing exposed sealed data.

## Remaining real-corpus acceptance

- Obtain and review 30–50 complete recordings, composition/lyrics/annotation permissions and evidence; validate source audio, sample clocks, slice assignments and all required coverage.
- Obtain two qualified independent human submissions and a separate adjudicator per task, preserving ambiguity and measuring reliability under the approved guide.
- Approve/freeze the full benchmark policy before any sealed exposure; provision actual custody and tuning identities, execution permissions, trusted key pins and protected storage on the intended macOS/Windows environments.
- Record actual custody/opening observations and retain private audit evidence. Synthetic tests establish tool behavior only. No release verdict or musical Support Claim follows from this PR.

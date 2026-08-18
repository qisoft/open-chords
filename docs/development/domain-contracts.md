# Canonical domain contracts

Issue [#35](https://github.com/qisoft/open-chords/issues/35) establishes one pure domain seam and one wire-codec seam. Neither module owns persistence, Electron, sidecars, media, UI state, or export files.

## Public seams

- `parseProjectContract(value)` performs strict Zod shape validation, schema-major compatibility checks, stable-reference checks, complete timeline invariant validation, and validation of every committed Edit Layer projection.
- `materializeEffectiveTimeline(project)` selects exactly the Analysis Revision, Edit Layer, and committed history position named by Active View. It returns a fresh derived timeline and never mutates machine output.
- `parseContractEnvelope(value)` validates the named `project_snapshot` envelope. Contract `1.0` is writable; structurally understood later `1.x` envelopes are read-only; another major is rejected.
- `canonicalSerialize(value)` recursively orders object keys by Unicode code-unit order, preserves already validated semantic array order, normalizes negative zero, rejects non-finite/unsupported values, uses two-space JSON indentation, and ends with one LF.

## Time, identity, and ordering

Project Time is a non-negative safe integer sample-frame coordinate at the Project's declared canonical sample rate. All intervals are half-open `[startSample, endSample)`. Chord, Section, and Key tracks cover `[0, durationSamples)` without overlap or gaps. Bars plus Unmetered Regions provide the same coverage; Bars may be complete, pickup, or truncated, and a meter change is represented only by adjacent Bars with different meters.

All domain references use stable opaque IDs. Arrays with Project Time meaning are stored in increasing Project Time order and duplicate IDs are rejected. Chord component sets are sorted and unique using strict JavaScript UTF-16 code-unit string ordering, not numeric or musical ordering; canonical serialization preserves this validated array order. `N` is the explicit `no_chord` musical value; machine `abstained` is an Assertion State and remains distinct even when an analyzer retained a candidate Chord Identity.

Unknown fields in core objects and unknown core enum semantics are rejected. Experimental or newer-minor data must live under a reverse-domain namespaced `extensions` key so it can round-trip without becoming silently interpreted core state.

## Committed state and projection

Analysis Revisions are immutable. Edit Layers contain committed append-only transactions in topological order; each transaction names its earlier parent, so editing after undo retains both branches. Active View selects a history position, which identifies one transaction node (or zero for the empty Layer). Effective Timeline walks only that node's ancestor chain and revalidates coverage after every materialization. An editor draft is deliberately absent from this contract: invalid or unsaved draft data cannot reach playback, lyrics, rendering, or export through the domain interface.

Typed operations cover Chord Identity/`N`, Chord boundaries, Beat positions, shared Bar/downbeat boundaries, meter changes, Bar split/merge, Section labels, and line/word lyric occurrence timing. A Lyrics Alignment contains exactly one occurrence for every immutable Document line and token, in Document order; repeated text is distinguished only by its stable occurrence ID. Multi-entity structural operations materialize atomically and are rejected as a whole when the resulting timeline or alignment violates coverage, ordering, identity, or half-open interval invariants.

A later Analysis Revision remains Reviewable until Active View explicitly selects it. The golden fixture intentionally keeps a newer Revision while selecting the older Revision to protect this stale-revision behavior.

## Versioned cross-language corpus

`packages/testkit/contracts/v1` is shared by TypeScript and Python. Its golden envelope covers pickup and truncated Bars, meter changes, an Unmetered Region, rich Chord Identities, `N`, abstention, repeated lyric occurrences, Support Claim evidence status, and explicit stale Revision selection. The invalid mutation corpus covers overlap, gaps, unstable ordering, unsafe numbers, unknown core semantics/fields, invalid stable references, invalid lyric assertion states, transaction ancestry, and invalid history selection. The Python validator evaluates the committed generated JSON Schema before applying the same reference, timeline, alignment, ancestry, and projection invariants.

`pnpm contracts:schema` generates the committed Draft 2020-12 JSON Schema from Zod 4. `pnpm contracts:schema:check` proves the generated artifact is current. JSON Schema captures the cross-language structural contract; domain-wide coverage, references, ordering, projection validity, and compatibility policy remain executable invariants in both validators because those relationships are not faithfully expressible as portable JSON Schema keywords.

Run:

```sh
pnpm test:fixtures
pnpm test:python
pnpm contracts:schema:check
```

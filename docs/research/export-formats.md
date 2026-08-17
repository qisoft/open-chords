# Open Chords v1: export formats and portable archive facts

> Research for the Wayfinder ticket `Fix export and print semantics`. Sources were verified on 2026-08-16. Only specifications, official documentation, and implementation source code were used. This document records format constraints and decision inputs; it does not choose product policy. The rights section is not legal advice.

## Summary

1. **ChordPro is a portable lead-sheet format, not a timed-project format.** It represents chords anchored to syllables, sections, grids, repeated `key` / `time` / `tempo` directives, and diagram definitions. It does not define chord intervals in seconds, beat/bar identity, confidence, provenance, or edit history ([introduction](https://www.chordpro.org/chordpro/chordpro-introduction/), [directives](https://www.chordpro.org/chordpro/chordpro-directives/), [grid](https://www.chordpro.org/chordpro/directives-env_grid/)).
2. **No canonical normative LRC specification was found.** The IANA registry contains no `lrc` or `lyrics` media type. FFmpeg documents a line-timed dialect, while Kodi historically interpreted timestamps inside a line differently. Line timing has de facto interoperability; word timing and extended metadata require a named profile ([IANA](https://www.iana.org/assignments/media-types/media-types.xhtml), [FFmpeg](https://ffmpeg.org/ffmpeg-formats.html#lrc), [Kodi](https://kodi.wiki/view/Archive%3ACreate_LRC_karaoke_lyrics_files)).
3. **PDF, PDF/A, and PDF/UA are different claims.** PDF 2.0 defines electronic representation, PDF/A-4 profiles long-term static-page preservation, and PDF/UA-2 defines accessible PDF construction. None preserves the editable Open Chords model by itself ([PDF 2.0](https://www.iso.org/standard/75839.html), [PDF/A-4](https://www.iso.org/standard/71832.html), [PDF/UA-2](https://www.iso.org/standard/82278.html)).
4. **A portable project archive needs a versioned semantic manifest.** BagIt provides precedents for inventory, checksums, provenance, and the distinction between `complete` and `valid`. EPUB OCF provides precedents for a ZIP root, manifest, portable filenames, and constrained compression. Integrity, semantic compatibility, and safe import remain separate properties ([RFC 8493](https://www.rfc-editor.org/rfc/rfc8493.html), [EPUB OCF](https://www.w3.org/TR/epub-33/#sec-container-abstract)).
5. **Excluding source audio does not settle lyric rights.** The underlying musical work, including lyrics, and a particular sound recording are separate protected works. An audio-free archive or export can still contain protected lyric text ([Copyright Office](https://www.copyright.gov/engage/musicians/), [registration distinction](https://www.copyright.gov/register/pa-sr.html)).

## 1. Representability matrix

“Partial” means that a format preserves a presentation or projection, not the source semantics without a custom extension.

| Open Chords data | ChordPro | LRC de facto | PDF/print | Portable archive |
|---|---|---|---|---|
| Lyric text and line structure | Yes | Yes, after line timestamp | Visual; semantics depend on tagging | Lossless |
| Chord identity/display spelling | Partial token/parser properties | No | Visual | Lossless |
| Chord intervals in seconds | No | No chord model | Visual if printed | Lossless |
| Bars, beats, meter changes | Partial grids/directives | No | Visual | Lossless |
| Line timing | No | Start timestamps | Printed or embedded layer only | Lossless |
| Word timing | No | Dialects disagree | Presentation, not timed model | Lossless |
| Confidence, abstention, mismatch reasons | No standard model | No | Text only | Lossless |
| Machine output, edits, Active View | No | No | No | Lossless |
| Provenance, models, settings | Free-form metadata/extensions | Small de facto set | Document metadata/text | Manifest/provenance graph |
| Source audio | Outside format | Separate file | Optional attachment by profile | Payload or explicit omission |

## 2. ChordPro

### 2.1. Official syntax

- Chords in `[...]` immediately precede their lyric syllable. This is a semantic text anchor, not a timestamp ([introduction](https://www.chordpro.org/chordpro/chordpro-introduction/)).
- Standard metadata covers title, contributors, copyright, album/year, key, meter, tempo, duration, and capo. Arbitrary names are allowed but tool-defined ([`meta`](https://www.chordpro.org/chordpro/directives-meta/)).
- `key`, `time`, and `tempo` can repeat and apply from their textual position; they are not Project Time or stable bar/beat identity ([`key`](https://www.chordpro.org/chordpro/directives-key/), [`time`](https://www.chordpro.org/chordpro/directives-time/), [`tempo`](https://www.chordpro.org/chordpro/directives-tempo/)).
- Environments group sections; grids support cells, several chords per cell, repeat/volta notation, and measure repeats ([environments](https://www.chordpro.org/chordpro/directives-env/), [grid](https://www.chordpro.org/chordpro/directives-env_grid/)).
- `define` provides string-instrument fingerings and keyboard notes; conditional directives can vary definitions by instrument ([`define`](https://www.chordpro.org/chordpro/directives-define/)).

### 2.2. Chord vocabulary and degradation

ChordPro intentionally has no exhaustive chord vocabulary. The reference implementation supports strict and relaxed parsing. Reliable transposition and diagrams require recognized roots/properties; arbitrary bracket text may print but loses those semantics ([chords](https://www.chordpro.org/chordpro/chordpro-chords/)). It retains original and canonical spellings separately and can preserve unparseable names, including `NC`, as fallback.

Consequences:

1. A structured chord can print even when a consumer cannot interpret it.
2. Cross-tool transposition/diagrams require a compatible spelling profile or verified `define` directives.
3. `N` needs an explicit display rule; `NC` fallback is not a universal no-chord domain value.
4. Enharmonic display and canonical identity must remain separate.

Application-specific `x_` directives are a safe extension point because unsupported consumers must ignore them, but this does not make extensions portable ([extensions](https://www.chordpro.org/chordpro/chordpro-directives/#custom-extensions)). One file cannot guarantee both a complete Open Chords round trip and maximum compatibility with independent ChordPro tools.

## 3. LRC

The research found no authoritative owner specification, standards-track document, or registered media type. The facts below describe implementations, not every player.

FFmpeg accepts one `subrip` or `text` stream, supports one-to-six fractional timestamp digits (two by default), and maps a small metadata set ([muxer](https://ffmpeg.org/ffmpeg-formats.html#lrc)). Its writer replaces metadata line breaks with spaces and warns about lyric text beginning with `[`. Its decoder accepts leading bracket timestamps, multiple timestamps for one payload, and global `[offset:...]`, while initially leaving duration unknown ([writer](https://ffmpeg.org/doxygen/trunk/lrcenc_8c_source.html), [decoder](https://ffmpeg.org/doxygen/trunk/lrcdec_8c_source.html)).

This represents line starts, not explicit ends, word identity/intervals, language/confidence/mismatch/provenance, or unambiguous duplicate/final-line behavior. Kodi's archived guidance permits timestamps inside a line for progressive karaoke, while FFmpeg reads only leading timestamps. “Enhanced LRC” therefore requires a named grammar.

A deterministic export contract must decide timestamp grammar/precision, sample-time rounding, ordering and equal timestamps, start-only versus start/end representation, instrumental/unmatched/repeated lines, multiple voices, word-timing refusal or degradation, metadata whitelist, UTF-8/BOM/newline policy, and an external loss report.

## 4. PDF and print

- PDF 2.0 defines a portable representation, not a renderer or validation method.
- PDF/A-4 profiles static page-based preservation and may permit attachments.
- PDF/UA-2 defines accessible PDF construction and programmatic/textual access, not chord-sheet-specific semantics.

These statuses are not interchangeable. WCAG presentation criteria can reveal contrast, text-image, relationship, and sequence defects but do not replace PDF/UA validation. Product requirements must define reading order between chords and lyrics, diagram text equivalents, chord pronunciation, and non-color confidence states.

Byte-stable or layout-stable PDF requires fixed renderer/version, fonts, locale, page geometry, diagrams, pagination, and metadata/time normalization plus visual/conformance tests. veraPDF can validate PDF/A, but source JSON/archive remains responsible for project-semantic integrity ([veraPDF](https://pdfa.org/resource/verapdf-test-suite/)).

## 5. Portable Project Archive

### 5.1. Inventory and integrity precedents

BagIt manifests list every payload file exactly once with a checksum. `complete` means listed files exist; `valid` additionally means checksums verify. BagIt also demonstrates human-readable provenance, integrity for custom tag files without semantic interoperability, path-traversal defenses, and security review for remote `fetch.txt` payloads ([RFC 8493](https://www.rfc-editor.org/rfc/rfc8493.html)). It is a directory-layout precedent, not an automatic ZIP choice.

EPUB OCF demonstrates a single root, mandatory metadata area, package manifest, restricted ZIP methods, UTF-8 portable filenames, no ZIP-level encryption, and rigorous expanded-data checks ([OCF](https://www.w3.org/TR/epub-33/#sec-container-abstract)). ECMA-376 Open Packaging Conventions demonstrates typed parts and explicit relationships separating the physical container from a logical graph ([ECMA-376](https://ecma-international.org/publications-and-standards/standards/ecma-376/)). Neither defines musical project semantics.

### 5.2. Semantic manifest and canonical bytes

RFC 8259 requires UTF-8, unique object names for predictable interoperability, no reliance on member order, and safe cross-implementation integers within `[-(2^53)+1, (2^53)-1]` ([RFC 8259](https://www.rfc-editor.org/rfc/rfc8259.html)). JSON Schema validates structure but not bytes. RFC 8785 defines deterministic canonical JSON when hashes/signatures must depend on content ([RFC 8785](https://www.rfc-editor.org/rfc/rfc8785.html)). W3C PROV-DM provides a provenance precedent for entities, activities, agents, derivations, and revisions ([PROV-DM](https://www.w3.org/TR/prov-dm/)).

The manifest must distinguish deliberately omitted audio, external dependencies, policy redaction, and damaged/missing required files. Apply the same distinction to models, dictionaries, fetched lyrics, generated PDFs, and caches so completeness and reproducibility do not become conflated.

## 6. Lyric rights and provenance

The musical work (composition and lyrics) and a fixed sound recording are separate works, commonly owned and licensed separately. Therefore:

1. Excluding media proves only that the archive contains no recording copy; it says nothing about lyric redistribution rights.
2. ChordPro copyright metadata can carry a notice but is not evidence of a license grant.
3. Provenance answers where data came from; rights basis, permission, and redistribution scope are separate.
4. Changing among PDF, ChordPro, LRC, and archive containers does not remove the rights layer.

Dublin Core likewise separates `source`, `rights`, and `license`; a provider URI is not a license assertion ([DCMI terms](https://www.dublincore.org/specifications/dublin-core/dcmi-terms/)). Provider terms and export rights require separate policy/legal review.

## 7. Open decision inputs

### Open Chords JSON

- Snapshot only Effective Timeline, or also selected Revision, Edit Layer, and Active View?
- Which schema/version/migration compatibility and canonical-byte policy?
- Which time coordinates are authoritative versus derived?
- How are abstention, `N`, unmatched lyrics, and deliberate omissions kept distinct?

### ChordPro

- Which minimum compatibility profile and chord spelling guarantees?
- How do events project to lyric anchors/grids under mid-beat changes, unmetered regions, multiple chords per beat, or no lyrics?
- Are `x_open_chords_*` extensions and instrument-specific definitions included, and how is their loss reported?

### LRC

- Which named dialect, grammar, timing level, rounding/order/end-time rules, and availability policy?
- Where does the machine-readable loss report live?

### PDF/print

- Which PDF/PDF-A/PDF-UA target and deterministic rendering profile?
- Which reading order and text alternatives cover chords, grids, and diagrams?
- Is Open Chords JSON attached or is PDF presentation-only?

### Portable Project Archive

- Which media type/extension, version marker, compatibility, inventory, and hash rules?
- What do complete, valid, authentic, and reproducible mean?
- How are authoritative, derived, external, optional, and deliberately omitted artifacts represented?
- How are paths, links, compression, expanded size, file count, nesting, and active content bounded?
- Which provenance/rights data is retained, omitted, or redacted?

## 8. Primary-source index

- ChordPro: [introduction](https://www.chordpro.org/chordpro/chordpro-introduction/), [directives](https://www.chordpro.org/chordpro/chordpro-directives/), [chords](https://www.chordpro.org/chordpro/chordpro-chords/), [grids](https://www.chordpro.org/chordpro/directives-env_grid/), [definitions](https://www.chordpro.org/chordpro/directives-define/)
- LRC: [IANA registry](https://www.iana.org/assignments/media-types/media-types.xhtml), [FFmpeg muxer](https://ffmpeg.org/ffmpeg-formats.html#lrc), [decoder](https://ffmpeg.org/doxygen/trunk/lrcdec_8c_source.html), [writer](https://ffmpeg.org/doxygen/trunk/lrcenc_8c_source.html), [Kodi behavior](https://kodi.wiki/view/Archive%3ACreate_LRC_karaoke_lyrics_files)
- PDF: [PDF 2.0](https://www.iso.org/standard/75839.html), [PDF/A-4](https://www.iso.org/standard/71832.html), [PDF/UA-2](https://www.iso.org/standard/82278.html), [WCAG 2.2](https://www.w3.org/TR/WCAG22/), [PDF Association](https://pdfa.org/resources)
- Archive/JSON/provenance: [RFC 8493](https://www.rfc-editor.org/rfc/rfc8493.html), [EPUB OCF](https://www.w3.org/TR/epub-33/#sec-container-abstract), [ECMA-376](https://ecma-international.org/publications-and-standards/standards/ecma-376/), [RFC 8259](https://www.rfc-editor.org/rfc/rfc8259.html), [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785.html), [JSON Schema](https://json-schema.org/draft/2020-12), [PROV-DM](https://www.w3.org/TR/prov-dm/)
- Rights: [U.S. Copyright Office musician guidance](https://www.copyright.gov/engage/musicians/), [composition/recording distinction](https://www.copyright.gov/register/pa-sr.html), [Dublin Core](https://www.dublincore.org/specifications/dublin-core/dcmi-terms/)

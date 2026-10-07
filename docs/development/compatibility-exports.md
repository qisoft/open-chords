# Compatibility exports

Issue #36 adds ChordPro, UTF-8 line-onset LRC and tagged PDF exports to the existing main-owned publication service. Each export captures one committed Active View before the native picker opens, publishes atomically, and persists its output hash, snapshot hash, profile version and losses in an Export Receipt. Cancellation, destination validation and recovery use the same path as JSON.

## Profiles

- `chordpro/1.0/<presentation>` emits standard metadata, sections, grids, repeated key/time/tempo directives, exact chord text and portable diagrams. Unsupported rich symbols stay visible and their compatibility loss is recorded.
- `lrc/1.0` emits only validated monotonic lyric-line onsets at centisecond precision. Unsafe, empty, unmatched or conflicting lines are omitted and individually reported. No selected timing or no safe lines returns an unavailable outcome before opening the picker. LRC cannot carry source notices or full provenance; the Receipt reports those losses.
- `pdf/1.0/a4/<presentation>` uses A4 geometry, 56-point margins, fixed styles and dates, pinned embedded Noto Sans regular/bold fonts, English interface metadata and the selected lyrics language on lyrical spans. A logical tagged reading order includes text alternatives for chord diagrams. Page numbers are pagination artifacts. Print this same PDF from a PDF viewer; there is no separate layout that can diverge from the saved bytes.

The current/original presentation selection applies to lead sheets. Original removes display transforms without mutating the Project. Selected lyrics, attribution and notices are included automatically wherever the format supports them. No export adds a legal or provider gate.

## Bounds and determinism

JSON is bounded to 32 MiB, ChordPro to 8 MiB, LRC to 4 MiB and PDF to 64 MiB. PDF golden tests pin deterministic bytes and inspect embedded fonts, tags, language, diagram alternatives and page text. Long unbroken words and paragraphs spanning pages have geometry regressions. Missing font glyphs are reported in the Receipt instead of claiming full script coverage. Noto font hashes are checked at runtime and its OFL license ships in release notices.

## Evidence boundaries

Domain projection and public service tests cover exact symbols, omitted lines, hashes, persistent Receipts and unavailable LRC. Renderer CI saves all formats through real IPC with only the external native-picker response substituted. Installed CI reopens all formats' Receipts and checks available controls; that test alone does not demonstrate an actual installed native save-dialog interaction. PDF bytes are also rendered for visual inspection. Tagged structure does not establish PDF/UA, PDF/A, or native screen-reader acceptance, and no such conformance is claimed.

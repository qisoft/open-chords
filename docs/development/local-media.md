# Local media capabilities

Issue #32 establishes the main-process boundary for user-authorized local media. The renderer never receives a filesystem path or directory capability. It receives generation-bound opaque identifiers and a same-origin playback URL whose unguessable token is resolved only by the main process.

## Ingestion

The native picker returns a single path directly to the main process. Before a selection capability is issued, ingestion:

- rejects non-regular files and symbolic links;
- opens read-only with no-follow semantics where the platform exposes them;
- probes at most 64 KiB before accepting the container and audio format;
- hashes the complete file and canonical PCM payload;
- compares path and open-handle identity before and after hashing; and
- publishes no Project state until every check succeeds.

The current direct-ingestion boundary is intentionally narrow: canonical 48 kHz mono PCM16 WAV. The FFmpeg worker introduced by issue #34 will expand decode and normalization support without moving filesystem authority into the renderer.

A successful import creates a durable Project whose `ProjectRange` is immutable. Existing Source identity is deduplicated by the complete byte fingerprint. Relinking adds a Locator only when the newly selected file has the same Source identity; a mismatch is returned as a new-Source selection capability.

## Availability and playback

Projects survive missing or replaced files. A failed Locator is durably observed as unavailable, and a later matching relink can restore access.

Playback reopens and revalidates the selected Locator, then issues a generation-bound playback capability. `open-chords://app/media/<opaque-capability>` accepts only exact single byte ranges, caps each response at 8 MiB, and rechecks file identity around every read. The endpoint is served by the packaged application protocol, uses the renderer's same origin, and never resolves arbitrary paths supplied by the renderer.

## Cache seam

Caching is opt-in and main-process owned. A cache adapter receives Source and snapshot identity, the immutable Project Range, and a `readCanonicalPcm` callback expressed in project-relative samples. The callback rejects reads outside that range and maps accepted reads to the already verified PCM payload. It does not expose a path or provide whole-file authority, and the default application does not silently create a cache.

## Verification

Focused tests cover hostile selection, concurrent replacement, range abuse, deduplication and relinking, durable unavailability, cache confinement, and offline playback after reopening the Library. The packaged test seeds a real Project and media file before launching the installed artifact, then verifies a 206 range response through the custom protocol.

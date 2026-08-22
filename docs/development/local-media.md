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

A successful import creates a durable Project whose `ProjectRange` is immutable. Before publication, the selection is reopened, rehashed, and checked against the picker capability. The new Project has no Analysis Revision, Edit Layer, Active View, or musical assertion until analysis produces a complete Revision. Existing Source identity is deduplicated by the complete byte fingerprint. Relinking adds a Locator only when the newly selected file has the same Source identity; a mismatch is returned as a new-Source selection capability.

## Availability and playback

Projects survive missing or replaced files. A failed Locator is durably observed as unavailable, and a later matching relink can restore access.

Playback reopens and revalidates the selected Locator, then issues a generation-bound playback capability. Capabilities are revoked when their renderer generation is destroyed or replaced. `open-chords://app/media/<opaque-capability>` accepts only a single byte range, clamps an open-ended range to the 8 MiB response limit, and rechecks file identity around every read. The endpoint is served by the packaged application protocol, uses the renderer's same origin, and never resolves arbitrary paths supplied by the renderer.

## Cache seam

Issue #32 defines the cache boundary, not a user-facing cache lifecycle. Caching is opt-in and main-process owned. A cache adapter receives Source and snapshot identity, the immutable Project Range, and a `readCanonicalPcm` callback expressed in project-relative samples. The callback rejects reads outside that range and maps accepted reads to the already verified PCM payload. It does not expose a path or provide whole-file authority, and the default application does not silently create a cache. A later cache implementation must add explicit enable, inspection, and removal operations through this seam.

## Verification

Focused tests cover hostile selection, concurrent replacement, stale picker capabilities, range abuse, generation revocation, deduplication and relinking, durable unavailability, cache confinement, and offline playback after reopening the Library. The packaged test seeds a real Project and media file before launching the installed artifact, then verifies range fetch, media-element load, seek, and play through the custom protocol.

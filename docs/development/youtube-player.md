# YouTube Source metadata and playback

The primary renderer invokes `window.openChords.youtube.perform` through one named, correlated capability. Only the registered primary renderer generation can use it. `refresh` canonicalizes a single public video URL and explicitly requests bounded oEmbed metadata. Construction, status reads and reopening the application never refresh metadata. Offline Mode aborts pending network work and prevents new requests.

The active Project Library owns pre-acquisition YouTube Sources and immutable metadata observations in `youtube-sources.json`. Its Source lookups merge these observations with existing Project-owned Source records and preserve established Source IDs. Refresh does not create a Project, alter a Project Head, rename a Project or rewrite a Source Snapshot. The catalog moves with the Library. Publication uses a synced temporary file and atomic rename; cancellation is checked before publication. Provider HTML is discarded. Thumbnail URLs are restricted to the same video's YouTube image host and are not loaded by the primary renderer.

## Player isolation

The player is a separate sandboxed BrowserWindow in a memory-only, cache-disabled Session. It has no preload, desktop IPC, Node, Project or local-media protocol. Its only local resources are a bundled static adapter and HTML at `open-chords-player://player`. The primary renderer's CSP, navigation policy and request policy remain unchanged.

Main accepts only bounded playback actions and reads schema-validated playback state. Each opened player receives a fresh main-owned session ID; commands for an old session fail. Closing the primary renderer, cancellation or Offline Mode destroys the player, blocks its requests, closes network connections and clears session storage. Provider response timeouts terminate an unresponsive adapter. Permissions, downloads, new windows, webviews and top-level navigation are denied.

The player session allows HTTPS requests to YouTube, its video/image delivery domains, and the specific Google asset/advertising hosts used by the embedded player. It cannot fetch arbitrary hosts, loopback, files or the privileged application protocol. Outgoing account credentials are removed; no browser cookies are imported. The visible YouTube iframe retains its native controls and branding.

YouTube's [desktop client identity requirement](https://developers.google.com/youtube/terms/required-minimum-functionality#api-client-identity-and-credentials) permits an explicit Referer using the installed app identifier. The player sends `https://io.github.qisoft.open-chords/`; its iframe `origin` remains the actual custom origin. No loopback server or proxy is introduced. Actual installed-artifact playback must verify this identity path before it is treated as supported.

## Verification

- `tests/youtube-source.test.ts` and `tests/project-library.test.ts`: canonical identity, bounded explicit observations, cancellation, Offline Mode, durable Source reuse and preserved Project/Snapshot contents.
- `tests/youtube-desktop.test.ts`: named gateway validation and rejection of remote senders.
- `tests/renderer/youtube.spec.ts`: production UI/preload/main/player path, playback actions, stale session rejection, remote isolation and normalized provider errors. Only external provider responses are replaced.
- `tests/packaged/youtube.spec.ts`: the same commands, error 153, non-embeddable response, autoplay denial, network failure and Offline Mode in the extracted release ZIP on macOS/Windows. Deterministic fixtures are not live playback evidence.
- `OPEN_CHORDS_LIVE_YOUTUBE=1 pnpm exec playwright test tests/packaged/youtube.spec.ts`: separately verifies actual media-time advancement and observed Referer in the installed artifact. It emits an observation artifact and fails if playback cannot be established. Live-provider availability is never inferred from metadata or initialization.

Metadata and playback provide no acquisition verdict. Local-file ingestion remains the analysis path; isolated acquisition is a separate implementation issue.

## Recorded observation

The [2026-09-09 installed macOS arm64 observation](evidence/youtube-player-macos-2026-09-09.json) records the release ZIP hash, actual HTTP Referer, media-time advancement, seek to 30 seconds, pause and 1.5× rate. The screenshot was inspected: the video, native controls and branding are visible, with application status below the iframe. Deterministic installed tests separately passed the listed security and failure journeys. This is not Windows evidence or a claim that every public video embeds successfully.

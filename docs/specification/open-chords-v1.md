# Open Chords v1 product and technical specification

Status: **validated planning baseline**  
Date: 2026-08-17  
Canonical decision map: [Open Chords v1 product and technical specification](https://github.com/qisoft/open-chords/issues/1)

## 1. Purpose and authority

Open Chords is an AGPL-3.0-only, local-first desktop application that turns one selected range of user-supplied or user-selected media into an editable timed musical Project for playback, practice, and export.

This document consolidates the accepted v1 product and technical decisions. It is the normative input to implementation planning; linked tickets and research provide rationale and evidence. It does not claim that the product, benchmark, packaging, or release gates have already been implemented or passed.

When older evidence conflicts with a later accepted decision, the later decision used here wins. In particular:

- the final release matrix in section 16 supersedes earlier exploratory macOS 13+, Intel, Windows ARM, and Linux ARM possibilities;
- update checks are user-initiated, superseding the earlier proposal for automatic daily polling;
- the export policy in section 14 supersedes earlier lyrics rights-confirmation or provider-based export gates;
- local-file analysis is guaranteed, while YouTube media acquisition remains credential-free best effort.
- the production frontend decision in section 12 supersedes the exploratory Radix, CSS Modules, i18next, reducer-only draft, ESLint, and Prettier recommendations in the frontend-stack research.

## 2. Product boundary

### 2.1 Required v1 capabilities

V1 includes:

- local media-file input and YouTube URL input;
- automatic chord events and timings;
- beats, bars/downbeats, tempo, key regions, and section regions;
- a bar/beat/seconds-fallback timeline with variable tempo and meter changes;
- Original and deterministic Beginner chord views;
- transpose with capo guidance;
- guitar, ukulele, and piano diagrams from data-driven packs;
- nondestructive correction of musical entities and available lyric timings;
- practice playback, loops, speed without pitch shift, count-in, metronome, navigation, and autoscroll;
- optional Reference Lyrics, imported timing, and EN/RU forced alignment;
- Open Chords JSON, ChordPro, PDF/print, conditional LRC, and Portable Project Archive exports;
- a local single-user Project Library with provenance, revisions, settings, and user edits.

### 2.2 Explicit exclusions

V1 does not include:

- accounts, a public library, catalog, social features, subscriptions, or payments;
- an Open Chords-operated public hosting, catalog, or redistribution service for user content;
- source separation, stem generation/export, or GPU-required operation;
- STT-generated lyrics, lyric generation, or LLM correction;
- automatic multi-song splitting of concerts or other long recordings;
- MIDI or MusicXML export;
- collaborative editing, third-party extensions/plugins, or an ecosystem API;
- Windows ARM64, Linux ARM64, or macOS Intel releases;
- automatic background updates or paid publisher signing/notarization.

CPU operation is the release baseline. Optional GPU acceleration may be explored later, but v1 cannot depend on it or claim it without its own packaged benchmark evidence.

The Electron desktop application is the required primary distribution. CLI and Docker remain secondary surfaces: they may be planned against the same domain and sidecar contracts, but they cannot delay the desktop v1 release, bypass containment/provenance, or introduce a second behavioral specification.

## 3. Core user contract

### 3.1 Project creation

One Project represents one immutable Project Range of one Source. Choosing another range creates another Project, including when several ranges come from one long video. A Project Range is not silently changed after analysis.

For a local file, Open Chords verifies the selected content and analyzes it locally. For a YouTube URL, Open Chords:

1. canonicalizes the URL to the video ID and discards playlist/radio/query state;
2. uses public oEmbed metadata as a best-effort Source Metadata Observation;
3. uses the embedded YouTube player for online playback;
4. may attempt credential-free, brokered, best-effort media acquisition for analysis;
5. offers local-file import when acquisition fails.

YouTube metadata or playback success does not imply that analysis media can be acquired. Local-file ingestion is the guaranteed analysis path.

### 3.2 Analysis and review

Analysis produces a complete immutable Analysis Revision or no Revision. The default result covers rhythm, meter, key, chords, and sections, while representing uncertain material as low-confidence or abstained instead of inventing certainty.

The user explicitly activates a Reviewable Revision. Existing edits never move to a new Revision silently. Machine output remains available for reset and comparison.

### 3.3 Lyrics

Lyrics are optional. A Project without lyrics still has the complete timed musical track and all non-lyric practice features.

- Timed LRC and timed YouTube subtitles retain validated supplied timing without MFA.
- Plain Reference Lyrics need an installed English or Russian alignment pack before automatic timing.
- If the pack is absent, offline, or declined, the text remains explicitly untimed.
- MFA produces a draft Lyrics Alignment; the editor corrects individual line/word timings and mismatches nondestructively.
- V1 is not required to support manually timing an entire untimed song from zero.

### 3.4 Personal-use tool boundary

Open Chords does not add a legal-purpose switch, export rights confirmation, or provider-based block for content already selected into a Project. It preserves available provenance, attribution, and notices, while responsibility for distribution of protected content remains with the user. Provider contracts still determine whether a provider adapter itself can be shipped.

## 4. Ubiquitous language and canonical state

The canonical glossary is [`CONTEXT.md`](../../CONTEXT.md). Implementation identifiers, schemas, UI labels, tests, and planning documents should use those terms rather than inventing parallel names.

### 4.1 Identity and time

- A Source has stable identity independent of mutable locators and metadata.
- Local Sources are identified by verified content fingerprint; YouTube Sources by provider plus video ID.
- A Source Snapshot records one immutable acquired representation and its provenance.
- Source Time locates the Project Range in original media.
- Project Time starts at zero at the Project Range boundary and is stored as integer sample frames at one canonical sample rate.
- Timed intervals are half-open `[startSample, endSample)`; seconds are derived presentation values.
- Stable IDs, not array positions or visible labels, identify entities.

### 4.2 Revision layers

The state layers are deliberately separate:

1. **Analysis Revision** — immutable machine output and evidence.
2. **Edit Layer** — append-only typed user transactions based on one Analysis Revision.
3. **Lyrics Document and Lyrics Alignment** — immutable text and timing relationship, selected independently.
4. **Presentation and practice state** — transpose, Beginner View, instrument, loop, speed, count-in, metronome, and playhead.
5. **Active View** — the explicit selection used to materialize one Effective Timeline.

Playback, practice, rendering, and export consume the deterministic Effective Timeline. There is no `latest wins` behavior.

### 4.3 Persistence and compatibility

- Open Chords JSON declares `format: "open-chords/project"` and a `major.minor` schema version.
- Unknown major versions are rejected.
- Unsupported newer minor semantics open read-only where safe; unknown extension namespaces round-trip, while unknown core semantics are never ignored.
- Durable mutation creates and validates a Project Revision before Project Head changes atomically.
- Migration preserves a recoverable previous revision and never rewrites the only copy in place.

## 5. Musical Timeline

### 5.1 Structural invariants

- Chord Events fully cover the Project Range with non-overlapping structured chords or musical `N`.
- `N` means an asserted no-chord/silence region; it is not an abstention.
- Bars contain ordered Beats. The first Beat has the downbeat role; downbeat is not an independent entity.
- Bars may be complete, pickup, or truncated.
- Meter changes occur only at Bar boundaries.
- Metered coverage is contiguous where reliable; an Unmetered Region uses seconds fallback without invalidating timed chords or lyrics.
- Beat positions are the canonical basis of tempo. Local or smoothed BPM is a deterministic Tempo View.
- Flat non-overlapping Section and Key tracks cover the Project Range and may contain `unknown` regions.

Automatic meter support claims are limited to 2/4, 3/4, 4/4, and 6/8 and remain benchmark-gated. Arbitrary meter remains manually representable.

### 5.2 Harmony

Chord Identity structurally represents root, quality, extensions, additions, alterations, omissions, and optional bass. V1 Original vocabulary includes major, minor, diminished, augmented, sus2, sus4, 6, 7, maj7, min7, dim7, half-diminished, add9, 9, slash chords/inversions, and `N`.

Enharmonic spelling and visible text are presentation choices. Transpose and Beginner View are deterministic transforms and never rewrite Original Chord Events. Unsupported rich symbols remain visible rather than being silently simplified.

## 6. Source, storage, and retention

### 6.1 Project Library

The Project Library is local and single-user. It contains Projects, Project/Analysis revisions, Edit Layers, selected Lyrics Documents/Alignments, manifests, receipts, practice/presentation state, and safe provenance. Source media remains externally referenced unless explicitly cached.

Project deletion first moves owned records into recoverable Library Trash for 30 days. Permanent deletion is separate and explicit.

### 6.2 Local Sources

Moving or renaming a verified local file updates or adds a Source Locator without changing Source identity. A changed file at an old path is not accepted as the old Source. An unavailable Source retains its Projects and may be relinked to matching verified content.

### 6.3 Temporary data and offline cache

- Decode/analysis workspaces and temporary WAV/audio are removed after success, failure, or cancellation under bounded cleanup rules.
- Offline Media Cache is opt-in, range-only, inspectable, and removable.
- It is not silently enabled or evicted by recency; loss/corruption falls back to an available verified Source.
- Model Store data is global, immutable, content-addressed, shared between Projects, and not embedded in each Project.

### 6.4 Portable archives

Portable Project Archive is a hostile-input, hash-manifested ZIP package. It excludes Source media by default; an explicit option may include only the verified Project Range. Import validates paths, normalization collisions, links, compression/expansion, hashes, declarations, schema compatibility, and active content before atomic publication. Identity conflict creates an Imported Project Copy rather than overwriting or merging histories.

## 7. Analysis pipeline

### 7.1 Baseline stack

The release baseline is:

- pinned project-built FFmpeg as the only decode/timebase authority;
- librosa plus small weight-free Open Chords DSP/decoders for the CPU-first baseline;
- classical, weight-free Essentia algorithms only as an AGPL-compatible comparison/backend candidate after packaging and benchmark proof;
- MFA with exact EN/RU data packs for optional Reference Lyrics alignment.

The default musical-analysis path has **0 bytes of downloadable model data**. BeatNet and Chordino are benchmark-only; All-In-One and BTC are excluded from v1 delivery. Rich automatic chords/inversions, semantic section labels, robust meter changes, and sung alignment accuracy are Support Claims earned by the benchmark, not assumed library capabilities.

### 7.2 Analysis Job model

An Analysis Job is durable intent identified by Project, verified Source Snapshot/canonical-audio fingerprint, and immutable Analysis Recipe hash. Each execution is a separate Analysis Attempt.

The declared DAG is:

`preflight → canonical decode → shared features → rhythm/harmony/sections → assemble → main validation → publish`

The Recipe fixes requested capabilities, pipeline graph, exact component/model/calibration hashes, settings, seeds, numerical backend, and resource profile. One CPU-heavy job runs globally. The queue is durable, FIFO by default, and user-reorderable; queued work requires confirmation after restart.

Failure of a requested stage publishes no partial Analysis Revision. Validated non-media stage Checkpoints may be reused only when every identity-bearing upstream input still matches. PCM, media fragments, temporary audio, and arbitrary runtime state are never terminal Checkpoints.

### 7.3 Cancellation and recovery

- Cancel intent is persisted before signaling the sidecar.
- Late results after cancellation/session change are ignored.
- Renderer reload does not cancel analysis.
- Interrupted and failed Attempts are never retried automatically.
- User Retry creates another Attempt of the same immutable Job/Recipe.
- Failed/interrupted operational evidence and reusable non-media Checkpoints expire under the seven-day policy; permanent reproducibility evidence remains with successful Revisions.

### 7.4 Confidence

Machine assertions are `asserted`, `low_confidence`, or `abstained`, with named raw-score scales and reason codes. Raw library scores are not shown as percentages or compared across analyzers without an identified Confidence Calibration.

Quality thresholds and calibrations are per capability, class, analyzer, model, and release. Abstention remains in coverage denominators and cannot improve a release score by deleting difficult regions.

## 8. Lyrics and alignment

### 8.1 Discovery and provenance

Lyrics lookup is explicit; there is no background retrieval or refresh. User-supplied text wins. Otherwise the suggested candidate order is LRCLIB, YouTube subtitle tracks, then the user-supplied flow. Provider results remain candidates until selected.

Genius is metadata/link only. Musixmatch and LyricFind are disabled until written terms explicitly cover self-hosted clients, caching, derived alignment, display, export, attribution, tracking, territories, and deletion.

A selected result becomes an immutable Lyrics Document preserving original Unicode text, lines, language, provenance, supplied timing kind, attribution, and notices. Text correction creates a new document revision.

### 8.2 Token and alignment identity

Alignment uses a versioned normalization/tokenization projection mapped back to original character ranges and line identities. Repeated words and repeated chorus lines are distinct Lyrics Token Occurrences; string value is never identity.

A Lyrics Alignment belongs to exactly one Lyrics Document and Analysis Revision. It is monotonic for one selected primary lyric sequence. Tokens may be asserted, low-confidence, or unmatched. Unmatched tokens have no invented interval.

Instrumental markers, annotations, punctuation-only spans, OOVs, unsupported language, anchor conflicts, absent/repeated lines, melisma, and overlapping/backing vocals remain explicit reasons or coverage gaps. Concurrent lyric streams are unsupported in v1.

### 8.3 Alignment packs

Only English and Russian are officially tested, subject to benchmark results. Other MFA packs are unsupported/best effort and not exposed as a generic v1 model catalog.

| Pack | Download | Installed model data |
|---|---:|---:|
| English MFA 3.1.0 acoustic model + dictionary | 88.93 MiB | 97.79 MiB |
| Russian MFA 3.1.0 acoustic model + dictionary | 111.45 MiB | 120.31 MiB |
| Both | 200.38 MiB | 218.10 MiB |

Installation is main-owned, explicit, checksum-verified, bounded, atomic, independently removable, and provenance-recorded. The MFA/Kaldi executable runtime belongs to the frozen sidecar and its final per-target footprint must be measured from packaged builds.

## 9. Nondestructive editing

### 9.1 Edit semantics

The Edit Layer stores append-only atomic typed Edit Transactions over one immutable Analysis Revision. Supported edits include chord identity/`N`, chord boundaries, Beat positions, shared Bar/downbeat boundaries, Bars/meters, structural split/merge operations, and available line/word timing corrections.

- Undo/redo selects a history position rather than mutating machine data.
- Editing after undo creates a retained branch.
- Reset selects an empty Edit Layer based on the same Analysis Revision.
- Moving edits to another Analysis Revision is an explicit reviewable mapping; unresolved mappings remain conflicts.
- Multi-entity changes required to preserve invariants are one transaction.

Draft UI edits are isolated from committed state. Timeline, lyrics, playback, and export continue to consume the last valid saved Active View. Save atomically publishes a valid draft; Reset restores the saved state even when the draft is invalid.

### 9.2 Rhythm-relative chord editing

Chord durations and positions snap to the active metrical subdivision. Duration choices are relative to the current meter; “whole bar” means that Bar's actual capacity, including 3/4. Conflicting/overlapping chord drafts are visibly invalid and cannot be saved.

Event width represents duration, event height remains stable, and short labels must remain identifiable without changing event geometry. Chord events can be reordered by pointer and keyboard.

## 10. Practice and presentation

Practice state does not dirty or rewrite the Analysis Revision/Edit Layer.

- A Bar selection is temporary editing state.
- A saved loop references Bar identities, is created by an explicit command, remains independent from later selection, and is visually distinct.
- Play/Space with loop enabled starts at the loop's first Bar.
- Ordinary boundary moves follow Bar identity; split/merge touching an anchor marks the loop `needs_review` rather than silently changing its meaning.
- Speed preserves pitch.
- Count-in, metronome, previous/next chord or Bar, and autoscroll are required.
- Structural grid edits pause playback; value/timing edits retain Project Time position where valid.
- Transpose is the primary visible chord-shift control. A separate capo control is not required; compatible negative shift exposes capo guidance.
- Beginner View and instrument selection are presentation transforms only.

## 11. Workspace and accessibility

The accepted interaction direction is evidenced by the throwaway React/Vite prototype at commit [`ebb82bb`](https://github.com/qisoft/open-chords/commit/ebb82bbc242c6a10be07bedcadae3357d3d5046f). It validates behavior and information hierarchy, not production code or final visual styling.

### 11.1 Layout and playback

- The workspace is a compact, full-width, Linear-like surface rather than a card dashboard.
- The playhead stays fixed at the center while timeline content moves beneath it.
- Scrubbing moves timeline content, not the playhead.
- Clicking a valid timeline position seeks playback; pointer dragging and keyboard seeking expose the same bounded Project Time operation.
- Playback controls sit directly below the timeline; Play aligns with the centered playhead.
- Current chord/Bar and persistent loop are visually distinct from temporary selection.
- Beat marks remain lightweight and do not consume a text-number row.

### 11.2 Chord editor

- The editor is a collapsible accordion, closed by default and after Save.
- Its event rail can scroll independently when a Bar contains many events; controls must not shrink or overlap.
- Chord entry uses a constrained root → quality → optional bass flow, including `N`; arbitrary chord strings are not accepted.
- Root/quality/bass selection remains in one picker session until the user finishes.
- The selected event is communicated once, without duplicate summary panels or redundant checkmarks.
- Low-confidence regions have an explicit review action and reversible reviewed state.

### 11.3 Lyrics and instrumental sections

Lyrics occupy remaining workspace height and scroll independently of the timeline/editor. Playback keeps the current line visible. Chords render above their associated words when timing supports it. Instrumental intro/interlude/outro sections are first-class timed chord blocks and participate in highlighting and autoscroll.

### 11.4 Accessibility

Implementation must provide:

- keyboard equivalents for every pointer operation, including range selection, seeking, event reorder, and editing;
- semantic controls, logical focus order, visible focus, and no focus loss when the editor collapses or content scrolls;
- screen-reader names, values, state changes, validation, review status, current position, and reorder announcements;
- minimum usable hit targets and text sizes under desktop zoom/resizing;
- meaning independent of color alone;
- reduced-motion behavior for timeline and lyric autoscroll without losing current-position information;
- deterministic focus/selection restoration after Save, Reset, validation failure, undo/redo, and navigation.

## 12. Desktop architecture and trust boundaries

### 12.1 Components

V1 uses Electron 43.x and stable Electron Forge 7.11.x as the validated starting versions, updated only through a reviewed dependency decision. The primary components are:

- sandboxed primary renderer;
- narrow versioned preload capability façade;
- Electron main as sole authority;
- dedicated unprivileged YouTube player surface;
- separately frozen Python analysis sidecar launched without shell;
- native platform containment launcher/service;
- separately networked YouTube Acquisition Job;
- main-owned named network adapters.

One primary BrowserWindow and at most one sidecar session are supported. Multi-window is deferred.

### 12.2 Production frontend and tooling

The production renderer uses React 19 and strict TypeScript project references. Project-owned Vite 8 builds compile renderer, main, and preload directly; Electron Forge owns packaging, makers, ASAR/fuses, and stable lifecycle hooks but not the experimental Forge Vite plugin. The packaged renderer is static and does not require SSR, a production HTTP server, or a full-stack web framework.

pnpm is the only JavaScript package manager. The repository pins one exact pnpm version in `packageManager`, commits `pnpm-workspace.yaml` and one `pnpm-lock.yaml`, rejects npm/yarn lockfiles, uses frozen clean installs in CI, and permits dependency lifecycle scripts only through a reviewed allowlist.

The renderer stack is fixed as follows:

- Base UI (`@base-ui/react`) provides unstyled ordinary accessible primitives; domain-specific timeline behavior remains project-owned.
- Tailwind CSS 4 uses the official Vite integration, CSS-first semantic tokens, explicit source registration, and statically discoverable class names. Output is static CSP-compatible CSS; runtime style injection, remote stylesheets, and dynamically constructed class strings are prohibited.
- Lucide supplies icons, with an independent accessible name and visible tooltip for every icon-only control.
- V1 product UI, validation, announcements, fixtures, and screenshot baselines are English-only. There is no i18next, locale routing, runtime translation loading, or parallel UI translation bundle. Lyrics and metadata remain original-language content; EN/RU alignment support is unchanged.
- Zustand 5 owns only one scoped unsaved Editor Draft store per open editor session. It never owns canonical Project data, persistence, IPC, playback clock, practice state, or durable undo. Save sends one validated domain transaction to main; Cancel/Reset restores the last committed base; a Project or revision identity change cannot silently carry a draft forward.
- Stable Effect v3 is restricted to Electron main orchestration. One `ManagedRuntime` may coordinate scoped services, typed failures, cancellation, timeout, resource cleanup, jobs, persistence, downloads, and adapters. Effect does not cross into React, Zustand, preload, IPC DTOs, or pure domain projections; Zod remains the wire-schema library. Adoption beyond a vertical slice requires a sidecar launch → cancel/timeout → cleanup → typed-result proof against an equivalent Promise implementation.
- The timeline and lyrics use semantic DOM. A dedicated external playback clock drives frame-level position through `requestAnimationFrame`; React receives only bounded semantic changes. TanStack Virtual is added only after representative profiling records a DOM/layout/accessibility threshold, while current, focused, selected, loop-edge, and drag-adjacent items remain mounted.
- Atlassian Pragmatic Drag and Drop is limited to Chord Event reordering inside the Editor Draft list. Timeline seek, range selection, edge autoscroll, fixed-playhead scrubbing, and boundary resize/nudge use Pointer Events plus equivalent keyboard commands.

Static quality gates use **Oxlint + `oxlint-tsgolint` + Oxfmt**, with exact versions pinned by pnpm. Oxlint owns TypeScript, React, React Hooks, JSX accessibility, Vitest, Promise, and Node lint rules; type-aware linting supplements but never replaces the TypeScript compiler, so CI also runs the strict project-reference typecheck. Oxfmt owns formatting, native import sorting, and Tailwind 4 class sorting using the renderer stylesheet and the project's `cn`/`clsx` helpers. ESLint and Prettier are not baseline dependencies. Because Oxfmt and the Oxlint JavaScript-plugin API have less mature stability guarantees than the core compiler, implementation must pin exact versions and keep formatter/linter fixture gates; a narrowly scoped ESLint fallback is allowed only for a documented mandatory rule that the pinned Oxlint cannot enforce.

The automated test layers are Vitest Node for domain/contracts/Effect workflows, Vitest Browser Mode with its Playwright provider for Base UI/Zustand/focus/layout behavior, Playwright for renderer journeys and deterministic visual baselines, and a packaged-Electron Playwright feasibility gate with WebdriverIO permitted only as the packaged-harness fallback. Axe automation supplements, but does not replace, keyboard-only and native VoiceOver/Narrator release passes.

The accepted prototype remains behavioral evidence only. Its fixture state, simulated clock, hand-built dialog/DnD, and build layout are not production dependencies.

### 12.3 Renderer and IPC

The renderer has `nodeIntegration: false`, `contextIsolation: true`, sandbox enabled, no host paths, no generic IPC/fetch, and no Project persistence authority. Preload exposes versioned method-per-capability operations only. Main revalidates sender, generation, payload, expected Project revision, and limits.

Privileged IPC accepts only the exact top-level app frame/origin. Events are sequenced; gaps trigger a snapshot refresh. Mutations serialize per Project and fail on stale `expectedProjectRevisionId` rather than overwriting state.

Every renderer/preload/main request, response, event, snapshot envelope, and bounded error is defined by a strict discriminated Zod 4 schema. Preload validates both directions and main always revalidates commands, sender, authority, expected Project revision, protocol version, sizes, finite values, and domain invariants. No generic invoke client or raw Electron IPC object crosses preload.

### 12.4 Sidecar protocol and acceptance

Main launches an exact manifest-verified executable with minimal environment, declared pipes, job-local staging, and no listening port. The private protocol is length-prefixed UTF-8 JSON with bounded frames, a version/capability/hash handshake, session nonce, monotonic sequence, and stable job/request IDs.

Sidecar candidate output is untrusted. Main reopens and validates file identity, size/hash, schema, finite values, time ranges, IDs, invariants, provenance, and forbidden content before constructing and atomically publishing an Analysis Revision. Invalid output is not repaired or partially imported.

### 12.5 Player and media

Local playback uses an opaque read-only media capability/protocol with bounded byte ranges and no exposed file paths. Remote YouTube code runs only in a dedicated sandboxed unprivileged surface with player-specific commands/events and no Project, filesystem, sidecar, or generic IPC authority.

Packaged release tests must prove YouTube origin/Referer behavior, error 153 handling, play/pause/seek/rate, autoplay denial, network loss, and non-embeddable videos. A hardened random-port loopback origin is permitted only for the static player adapter if custom-scheme identity fails.

## 13. Network, acquisition, privacy, and diagnostics

### 13.1 Explicit network operations

The primary renderer has no generic network API. Network use is limited to explicit actions for:

- YouTube metadata/playback/acquisition;
- LRCLIB or subtitle retrieval;
- EN/RU alignment-pack installation;
- manual update check;
- opt-in crash/performance reporting.

Offline Mode disables all network operations while preserving local Projects, local-file analysis, playback, editing, export, and installed packs. There is no installation identifier or mandatory telemetry.

### 13.2 YouTube Acquisition Job

The credential-free Extractor Worker has no direct IP-network capability and uses exactly one broker-backed request handler. The Acquisition Network Broker validates HTTPS endpoints, DNS/global addresses, redirects, TLS, request/response types, and resource budgets on every hop.

The worker receives one canonical public video URL and cannot use playlists, channels, search/live feeds, arbitrary arguments, user config, plugins, remote components, cookies, browser/account credentials, self-update, exec hooks, external downloaders, HLS/DASH, or acquisition-time FFmpeg. It downloads at most one direct audio-only or combined media object, then its network/process domain becomes empty before offline handoff.

Bot checks or unsupported delivery fail closed, retain only bounded redacted provenance, remove partial media, and offer local-file import. No broad-network compatibility fallback exists.

### 13.3 Diagnostics

Logs exclude lyrics, Project JSON, titles/filenames, URLs/query data, absolute paths, environment, credentials, response bodies, and raw model inputs/outputs. Local logs are bounded and expire. Diagnostic upload is off by default, explicit, previewable, and redacted.

## 14. Export semantics

Every export consumes one immutable Active View snapshot under a versioned Export Profile, validates output, publishes atomically, and records an Export Receipt with output hash and every omission/degradation.

### 14.1 Open Chords JSON Snapshot

The canonical deterministic semantic export contains the selected Original musical assertions, Effective Timeline, lyrics/alignment, safe provenance, confidence, user authorship, and declared presentation transforms. It excludes undo branches, full Project history, Source media, caches, operational Attempt Records, private paths, and secrets. It is not a backup.

### 14.2 ChordPro

ChordPro is a compatibility-first lossy lead-sheet projection. It uses standard metadata, chord anchors, sections, grids, repeated key/time/tempo directives, capo, and portable diagrams where available. Unsupported rich chord symbols remain visible as text. Timing, confidence, identity, mismatch, and history losses are reported rather than fabricated.

### 14.3 PDF/print

PDF and print share one deterministic, self-contained layout profile with embedded fonts, fixed page geometry, logical reading order, tagged structure, declared language, and text alternatives for diagrams. It includes a deduplicated diagram set for the selected instrument. V1 makes no PDF/A or PDF/UA conformance claim without separate validation.

### 14.4 LRC

LRC is deterministic UTF-8 line-onset output. Only validated monotonic line timings are emitted; unmatched or unsafe lines are omitted and reported. V1 does not emit a word-timing dialect.

### 14.5 Lyrics inclusion

When a Lyrics Document is selected, applicable JSON, ChordPro, PDF/print, and archive exports include it automatically. There is no lyrics-export toggle, legal warning gate, or provider-based block. Available attribution, notices, and provenance remain present.

## 15. Security containment

There is no claim of one identical cross-platform sandbox. The common contract stages hash-identified copies of required audio, lyrics, and model data into disposable job storage; canonical Project/Source/Model Store data, credentials, and browser state are unavailable; analysis is offline; and output is untrusted until main validation.

### 15.1 macOS

The official target uses a native XPC service with App Sandbox and no network entitlements. Required nested helpers inherit the intended sandbox under the final ad-hoc/unsigned packaging mechanism. The enforceable write boundary is the service private container, not exactly one subdirectory. macOS does not claim Windows-equivalent aggregate hostile-tree quota/kill semantics.

### 15.2 Windows

The official target uses a per-job AppContainer with explicit staged-resource ACLs and no network capability, plus a non-breakaway Job Object for descendants, resource/process limits, accounting, and kill-on-close.

### 15.3 Ubuntu Preview

Ubuntu Preview requires Landlock ABI 3+, `no_new_privs`, seccomp denial of direct networking, and delegated cgroup v2 for enforceable descendant limits and tree kill. Failure to establish the declared containment fails analysis launch; there is no silent compatibility mode.

An analyzer or platform that requires wider privilege is deferred rather than weakening the sandbox.

## 16. Packaging, releases, and lifecycle

### 16.1 Supported matrix

| Status | Platform |
|---|---|
| Official | macOS 15+ on Apple Silicon (`arm64`) |
| Official | Windows 11 x64 |
| Optional Preview | Ubuntu 24.04 LTS x64, non-blocking and only with full declared containment |
| Unsupported | macOS Intel, Windows ARM64, Linux ARM64, other Linux baselines |

### 16.2 Self-contained artifacts

Each target package contains Electron, the frozen one-folder Python sidecar, reviewed FFmpeg, and every mandatory native/runtime dependency for base analysis. Users never install Python, Conda, Homebrew, FFmpeg, compilers, or system packages manually.

Alignment must likewise be self-contained after its explicit install. Depending on measured packaged size, the frozen MFA/Kaldi runtime may ship in the base sidecar or as one target-specific optional runtime component installed together with the first language pack. It is executable release code, not Model Store data. The UI must show its additional transfer and installed size separately from the exact language-model figures above; no system installation is permitted.

Final installer/application/sidecar/runtime sizes are measured and published per target. Source archive or Python wheel size is never used as an installed-size proxy.

### 16.3 Unsigned community releases

V1 uses GitHub Releases without paid Apple or Windows publisher certificates. Every artifact has SHA-256 checksums, SBOM, build provenance, license notices, and GitHub artifact attestations. Documentation explains macOS **Open Anyway** and Windows reputation/SmartScreen limitations and never claims notarization or publisher signing.

### 16.4 Updates

**Check for updates** is a manual explicit action. It may fetch GitHub Release metadata and present version, notes, artifacts, checksums, and verification instructions. V1 does not silently poll, download, install, restart, or replace models.

### 16.5 Project migration and rollback

Opening an older supported schema creates a recoverable backup, migrates in staging, validates, and atomically publishes. Failure leaves the original unchanged and offers recovery/read-only access. Older application versions refuse to write newer schemas. Rollback restores a compatible backup/archive; it never performs an in-place downgrade.

### 16.6 Uninstall

OS-level application removal preserves Projects and other user-owned Library data. Settings, caches, and installed packs also remain unless explicitly selected. Full cleanup is a separate destructive action that enumerates locations/categories, distinguishes irreplaceable Projects from reproducible caches/models, confirms explicitly, and reports results.

## 17. Benchmark and release gate

Automatic Support Claims are earned on a versioned rights-cleared 30–50-track Benchmark Corpus split into track-disjoint calibration and sealed release-gate cohorts.

- A Corpus Rights Ledger separately covers recordings, compositions/lyrics, annotations, execution, redistribution, and result disclosure.
- Two independent qualified annotations plus third-party adjudication produce each Gold Reference while preserving disagreement.
- Slices cover production/source, duration/form, tempo, supported meters/meter changes, harmony/rich classes/`N`, sections, and optional EN/RU alignment cases.
- Metrics report per-track distributions, pooled values where valid, coverage/abstention, failures, calibration, and slices.
- Quality and coverage gates are paired and non-compensating.
- Candidate versus Release Baseline uses paired track-level uncertainty and frozen practical margins.
- Every claimed platform and Analysis Resource Profile passes native cold/warm quality, deterministic, runtime, memory, workspace, process, and thread gates.
- Pull-request CI runs canaries only. Only the sealed full native run may authorize a release.

Numeric quality, coverage, calibration, runtime, resource, and non-inferiority thresholds are intentionally unknown until calibration-cohort measurement. Maintainers then record each number's unit, direction, aggregation, uncertainty rule, rationale, and resulting Support Claim before hashing/freezing Benchmark Policy.

A sealed failure cannot be repaired by lowering a threshold, changing a metric, deleting a track/slice, or relabelling failure as abstention. Insufficient evidence narrows the named claim. If the remaining default automatic capabilities no longer satisfy the v1 product boundary, release is blocked and that product decision must be reopened.

## 18. Implementation-planning inputs

Implementation planning may now decompose work, but must preserve the following dependency order and acceptance seams.

| Workstream | Required planning inputs and gates |
|---|---|
| Domain/schema | `CONTEXT.md`; Project/Source/Timeline identities; canonical sample-frame time; schema compatibility; atomic Project Revision/Head; fixtures for invariants and migration |
| Desktop shell | Electron/Forge pins; app protocol/CSP; single-instance lifecycle; typed preload and stale-revision IPC; packaged YouTube identity smoke test |
| Frontend platform | React/strict TypeScript; direct Vite builds; pnpm-only workspace; Base UI/Tailwind/Lucide; scoped Zustand drafts; main-only Effect proof; Zod IPC; semantic DOM/external clock; constrained DnD; Oxlint/Oxfmt/typecheck; browser, packaged, visual, accessibility, and native-AT gates |
| Persistence/library | Project Library, Trash, Source relink/fingerprints, content-addressed Model Store, atomic saves, cache/retention, hostile archive import |
| Native containment | XPC App Sandbox; AppContainer + Job Object; Ubuntu Landlock/seccomp/cgroup; adversarial packaged tests; fail-closed launch |
| Local ingestion/playback | opaque file capabilities, media ranges, Source Snapshot validation, Project Range selection, unavailable/relink behavior |
| YouTube | oEmbed card, dedicated iframe surface, brokered credential-free acquisition, bot-check/local-file fallback, final endpoint/resource policy |
| Analysis | frozen sidecar protocol, immutable Recipe/Job/Attempt/Checkpoint, one-job scheduler, FFmpeg decode, DSP stages, confidence/evidence, main-owned publication |
| Lyrics | explicit provider adapters, immutable documents/token mapping, on-demand EN/RU packs, Alignment Job, coverage/mismatch, timing corrections |
| Editor/practice | accepted workspace behavior, committed/draft split, typed edit transactions, meter-relative duration, persistent loops, transport/presentation separation, accessibility |
| Export | canonical JSON schema/serialization, versioned profiles, ChordPro/LRC degradation reports, deterministic accessible print, archive manifest/import, Export Receipts |
| Packaging/update | native self-contained artifacts, model manifests, size measurement, checksums/SBOM/attestations, unsigned-install docs, manual update flow, uninstall/migration recovery |
| Benchmark/release | rights ledger, corpus and annotation tooling, calibration then sealed cohorts, metrics/coverage/uncertainty, native resource profiles, frozen policy and release verdict |

Implementation plans must include red-to-green tests at these boundaries rather than postponing them to final integration: renderer/main authorization, main/sidecar protocol violations, containment escapes, hostile files/archives, cancellation/process cleanup, failed model installs, invalid drafts, migration/downgrade, export degradation, and benchmark abstention/coverage accounting.

## 19. Deliberately unresolved until measured

These are not hidden assumptions or missing product decisions:

- numeric benchmark thresholds and non-inferiority margins;
- final CPU/memory/disk/process budgets and progress estimates;
- final packaged installer, sidecar, and MFA runtime sizes;
- whether the measured MFA/Kaldi runtime lives in the base artifact or the first explicit alignment-feature install;
- exact automatic Support Claims for rich chords/inversions, meter changes, semantic section labels, EN/RU sung alignment, and each Resource Profile;
- the final YouTube broker endpoint-policy seed and acquisition budgets;
- whether Ubuntu Preview passes all native packaged gates.

Each is produced by an explicit calibration, build, or release-gate activity. Until evidence exists, UI and documentation must not imply the stronger claim.

## 20. Coverage audit

| Accepted decision area | Normative sections | Evidence owner |
|---|---|---|
| Brand, license, desktop-first/local-first boundary, parity, exclusions | 1–3 | [Product boundary](https://github.com/qisoft/open-chords/issues/2) |
| Inputs, lyrics providers, privacy, retention, explicit network | 3, 6, 8, 13 | [Sources, lyrics, storage, and privacy](https://github.com/qisoft/open-chords/issues/3) |
| Timeline, chord vocabulary, editor, practice, instruments, required exports | 2, 5, 9–10, 14 | [Musical interaction and exports](https://github.com/qisoft/open-chords/issues/4) |
| Electron/Forge, isolated renderer, sidecar packaging and lifecycle | 12, 16 | [Desktop and local-sidecar stack](https://github.com/qisoft/open-chords/issues/5) |
| CPU-first decode/DSP/alignment stack and unsupported automatic claims | 7–8, 17 | [CPU-first analysis and lyrics stack](https://github.com/qisoft/open-chords/issues/6) |
| Project/Timeline identities, timebase, revisions, confidence, schema | 4–5 | [Canonical Project and Timeline model](https://github.com/qisoft/open-chords/issues/7) |
| Main/renderer/sidecar/player trust and lifecycle | 12–13, 15 | [Desktop process and security boundaries](https://github.com/qisoft/open-chords/issues/8) |
| Sources, YouTube narrowing, cache, Trash, portability | 3, 6, 13–14 | [Ingestion, storage, retention, and portability](https://github.com/qisoft/open-chords/issues/9) |
| Jobs, Recipes, Attempts, Checkpoints, failure, confidence | 7 | [Analysis Jobs, confidence, and failure](https://github.com/qisoft/open-chords/issues/10) |
| Optional lyrics, immutable documents, EN/RU alignment and correction | 3, 8–9, 14 | [Lyrics and forced alignment](https://github.com/qisoft/open-chords/issues/11) |
| Nondestructive state, draft/commit boundary, practice and loop identity | 9–10 | [Editor and practice state](https://github.com/qisoft/open-chords/issues/12) |
| JSON, ChordPro, print, LRC, archive and content-export policy | 14 | [Export and print semantics](https://github.com/qisoft/open-chords/issues/13) |
| Corpus rights, annotations, metrics, thresholds and release verdict | 17 | [Benchmark and release gate](https://github.com/qisoft/open-chords/issues/14) |
| Accepted workspace, chord editing, lyrics/instrumentals, accessibility | 9–11 | [Workspace UX and accessibility](https://github.com/qisoft/open-chords/issues/15) |
| Platforms, unsigned packages, models, updates, migration and uninstall | 8, 15–16 | [Packaging, updates, models, and migrations](https://github.com/qisoft/open-chords/issues/16) |
| Renderer/build/state/UI/tooling/test architecture | 9, 11–12, 18 | [Production frontend architecture and tooling](https://github.com/qisoft/open-chords/issues/24) |

All confirmed decisions are represented above. Section 19 is the complete list of evidence-dependent values still unavailable before implementation/build work; none is treated elsewhere as already known.

## 21. Evidence index

### Decisions

- [Product boundary](https://github.com/qisoft/open-chords/issues/2)
- [Sources, lyrics, storage, and privacy](https://github.com/qisoft/open-chords/issues/3)
- [Musical interaction and exports](https://github.com/qisoft/open-chords/issues/4)
- [Canonical Project and Timeline model](https://github.com/qisoft/open-chords/issues/7)
- [Desktop process and security boundaries](https://github.com/qisoft/open-chords/issues/8)
- [Ingestion, storage, retention, and portability](https://github.com/qisoft/open-chords/issues/9)
- [Analysis Jobs, confidence, and failure](https://github.com/qisoft/open-chords/issues/10)
- [Lyrics and forced alignment](https://github.com/qisoft/open-chords/issues/11)
- [Nondestructive editor and practice state](https://github.com/qisoft/open-chords/issues/12)
- [Export and print](https://github.com/qisoft/open-chords/issues/13)
- [Benchmark and release gate](https://github.com/qisoft/open-chords/issues/14)
- [Workspace UX and accessibility](https://github.com/qisoft/open-chords/issues/15)
- [Packaging, updates, models, and migrations](https://github.com/qisoft/open-chords/issues/16)
- [Production frontend architecture and tooling](https://github.com/qisoft/open-chords/issues/24)

### Research and prototypes

- [`docs/research/chordify-algorithms.md`](../research/chordify-algorithms.md)
- [`docs/research/desktop-sidecar-stack.md`](../research/desktop-sidecar-stack.md)
- [`docs/research/cpu-analysis-stack.md`](../research/cpu-analysis-stack.md)
- [`docs/research/sidecar-containment.md`](../research/sidecar-containment.md)
- [`docs/research/youtube-acquisition-containment.md`](../research/youtube-acquisition-containment.md)
- [`docs/research/model-artifact-inventory.md`](../research/model-artifact-inventory.md)
- [`docs/research/export-formats.md`](../research/export-formats.md)
- [`docs/research/workspace-accessibility.md`](../research/workspace-accessibility.md)
- [`docs/research/benchmark-release-gate.md`](../research/benchmark-release-gate.md)
- [Production frontend stack research](https://github.com/qisoft/open-chords/blob/research/frontend-stack/docs/research/frontend-stack.md)
- [YouTube acquisition prototype evidence](https://github.com/qisoft/open-chords/blob/6a74199/prototypes/youtube-acquisition/EVIDENCE.md)
- [Accepted workspace prototype](https://github.com/qisoft/open-chords/tree/ebb82bbc242c6a10be07bedcadae3357d3d5046f/prototypes/workspace-ux)

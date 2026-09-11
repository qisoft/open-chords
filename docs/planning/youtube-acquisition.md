# Brokered YouTube acquisition

Status: all three public test boundaries confirmed by the user on 2026-09-11. Broker implementation is in progress; no acquisition or support claim is complete.

## Authority

- [Prove brokered credential-free YouTube acquisition](https://github.com/qisoft/open-chords/issues/60).
- Specification section 13.2 and decisions [containment](https://github.com/qisoft/open-chords/issues/20) / [narrowed best-effort acquisition](https://github.com/qisoft/open-chords/issues/21).
- Base: merged main `b3ebab5727711b7493468be6b2552007c321c4aa`.

## Confirmed test boundaries

1. Public Acquisition Job API: canonical video identity, explicit action, shared Offline Mode, cancellation/recovery, bounded redacted retention, no partial Source Snapshot, and atomic publication after validated offline handoff.
2. Real Extractor Worker / Acquisition Network Broker protocol: one pinned Youtube extractor and broker request handler; no direct handlers, credentials or optional plugins; HTTPS, endpoint policy, DNS/CNAME/global-address checks, connection pinning, redirects and normal TLS; streaming, range/retry behavior and resource limits.
3. Installed macOS/Windows application: verified packaged runtimes, no direct worker network, process and stream disposal before offline handoff, adversarial path/input checks, cancellation/crash cleanup and local-file fallback for provider or policy failure. Deterministic transport fixtures prove error paths; permitted live acquisition is separately reported and never inferred from metadata/player success.

## Vertical implementation sequence

Start with one bounded broker request through the public broker API. An externally supplied endpoint is denied before a connection is made; a permitted request uses validated and pinned global addresses with hostname TLS verification. Keep DNS and HTTPS peers as external test boundaries.

Extend that path one behavior at a time: CNAME/address and redirect rejection, streaming and bounded reads, cancellation and request/aggregate quotas. Then connect the pinned worker's custom request handler through framed IPC, retaining streaming and error behavior. Finally compose native containment, the Acquisition Job, validated one-object handoff, durable Snapshot publication, named desktop UI and installed journeys.

The historical prototype at `6a74199` is evidence and input for source review, not a production module to copy unchanged. Its Python socket guard is not native containment; suffix-only host checks and provisional quotas are not final endpoint/resource policy. Frozen component versions there were yt-dlp 2026.07.04, yt-dlp-ejs 0.8.0 and Deno 2.8.3. Reinspect those exact sources and establish reproducible artifact hashes before packaging; do not silently upgrade them.

## Fixed limits on scope

Only one direct audio-only or combined progressive object may be acquired. HLS/DASH, acquisition-time FFmpeg, cookies, browser sessions, account credentials, remote components, arbitrary arguments, plugins and broad-network fallbacks remain excluded.

Partial media, signed URLs, raw provider responses, private paths and tokens do not enter retained diagnostics. Failure records retain only approved identity, component/policy hashes, bounded counters and terminal reasons for seven days. Successful Source provenance has the separate referenced lifetime.

Provisional engineering ceilings must be explicitly labelled and versioned. Corpus-derived endpoint coverage, final benchmark/resource policy, successful real-corpus acquisition and platform release claims remain separate evidence gates; unavailable evidence cannot be replaced with synthetic fixtures or more permissive networking.

## Implementation checkpoint — 2026-09-11

The current macOS package exercises the real pinned extractor, native worker and Deno network denial, offline decoder, public Acquisition Job and durable Source Snapshot catalog. A synthetic progressive MP4 publishes one Snapshot that survives reopening the library. Bot-check, an interrupted transfer followed by Offline Mode, a WAV served as `video/mp4`, and an MP4 declaring 3601 seconds publish no additional Snapshot and remove their workspace journals. The independent native transport proof verifies its workspace is removed after process disposal.

The broker/worker tests exercise streaming, range retry after truncation, retry after a coarse transport failure, cancellation while waiting for the broker, and cancellation while the OS launch result is still pending. The TLS fixture uses a real loopback HTTPS peer and a CA trusted only by a test child: untrusted certificates and wrong hostnames are rejected before an HTTP request. DNS fixtures include mixed public/private answers, special IPv4/IPv6 ranges, zone IDs and malformed CNAME labels. Retention expires failed/blocked history at seven days while the application stays open.

Current provisional ceilings: 120 requests, eight redirects, four active requests/streams, 256 MiB per response, 512 MiB per attempt, 20-second idle and 180-second network session deadlines. Offline acquisition validation admits MP4/AAC or WebM/Opus/Vorbis, at most two streams with exactly one audio stream, and at most 3600 seconds. FFmpeg has an acquisition-only time/output ceiling; canonical PCM is checked independently after decode. These are engineering bounds, not measured corpus support.

Still open before this frontier can be accepted: normal desktop entry and local-file fallback, complete process/crash/path and publication-failure recovery review, installed Windows evidence, full current-package regression gates, and code review. No live YouTube acquisition or broader endpoint coverage has been claimed. Existing Windows player checks do not satisfy the acquisition gate.

Implementation references: [Node HTTPS Agent](https://nodejs.org/api/https.html#class-httpsagent), [Node TLS hostname and trust verification](https://nodejs.org/api/tls.html#tlsconnectoptions-callback), [yt-dlp pinned release](https://github.com/yt-dlp/yt-dlp/tree/2026.07.04), [Deno pinned release](https://github.com/denoland/deno/releases/tag/v2.8.3).

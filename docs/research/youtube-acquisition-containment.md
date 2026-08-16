# Open Chords v1: YouTube Acquisition Job containment and network policy

> Checked 2026-08-14. This is a security-architecture research result, not an implementation. It resolves [Validate YouTube Acquisition Job containment and network policy](https://github.com/qisoft/open-chords/issues/20) and narrows the ingestion decision in [Fix ingestion, storage, retention, and portability behavior](https://github.com/qisoft/open-chords/issues/9).

## Executive finding

Open Chords can enforce a useful cross-platform Acquisition Job boundary, but it cannot honestly claim that an unmodified, directly networked `yt-dlp` child is confined to a permanent list of YouTube hosts on macOS, Windows, and Linux.

The strongest common v1 contract is a **brokered Acquisition Job**:

1. A contained **Extractor Worker** runs the pinned `yt-dlp` library and its pinned Deno/EJS challenge solver with no IP-network capability, no credentials, and access only to packaged read-only tools plus a disposable Acquisition Workspace.
2. Every HTTP request and response crosses a narrow framed IPC channel to an app-owned **Acquisition Network Broker**. The broker is the only component with outbound network access. It validates the scheme, hostname, resolved addresses, redirect hop, request/response byte budgets, and total job budget before streaming bytes.
3. The worker uses exactly one broker-backed `yt-dlp.networking.RequestHandler`; the built-in direct handlers are absent. This is technically possible in the pinned code because `YoutubeDL.urlopen()` delegates to a `RequestDirector` assembled from supplied handlers, but the extension surface is not documented as a stable public API. It therefore requires a packaged proof, pinning, and contract tests for every `yt-dlp` upgrade ([`YoutubeDL.urlopen` and director construction at release 2026.07.04](https://github.com/yt-dlp/yt-dlp/blob/2026.07.04/yt_dlp/YoutubeDL.py#L4284-L4385), [`RequestDirector` and `RequestHandler`](https://github.com/yt-dlp/yt-dlp/blob/2026.07.04/yt_dlp/networking/common.py#L51-L179)).
4. Acquisition downloads one original single-stream media object and emits a manifest; it does not decode, transcode, merge, run a postprocessor, or invoke FFmpeg. The network domain is fully dead before Electron main validates and stages the media into the offline Analysis Job.

If the brokered worker cannot be proved on a release platform, v1 must fail closed for YouTube acquisition there. A fallback that gives `yt-dlp` broad outbound Internet may be offered only as an explicitly weaker, separately named compatibility mode; it must not carry the endpoint-confinement claim.

## Threat model

The boundary assumes that a YouTube page, player response, manifest, media stream, or challenge script may exploit `yt-dlp`, its Python runtime, its JS runtime, or a media helper. It protects:

- canonical Sources, Projects, model storage, browser profiles, SSH/GPG material, and other user files;
- account/browser credentials, which are never made available to the job;
- the user's private/local network and non-approved public destinations;
- the offline Analysis Job from live network access and partially downloaded input;
- disk, memory, CPU, wall time, and process count up to the limits each platform can actually enforce.

It does not protect against a compromised OS/kernel, administrator, or same-user attacker who replaced the installed signed/hashed application before launch. It also does not make YouTube availability stable: endpoint changes, bot checks, PO-token requirements, and rate limiting may cause a fail-closed acquisition to stop working.

## Why raw `yt-dlp --proxy` is not the boundary

### Redirects and destinations are dynamic

The input URL is only the first destination. In release `2026.07.04`, the Requests backend calls `session.request(... allow_redirects=True)`, while the urllib backend constructs a new request for each 301/302/303/307/308 without applying an Open Chords host policy ([Requests redirect behavior](https://github.com/yt-dlp/yt-dlp/blob/2026.07.04/yt_dlp/networking/_requests.py#L313-L337), [urllib redirect handler](https://github.com/yt-dlp/yt-dlp/blob/2026.07.04/yt_dlp/networking/_urllib.py#L203-L239)). A valid initial `youtube.com` URL therefore does not constrain later destinations.

The YouTube extractor consumes direct format URLs, signature-cipher URLs, and HLS/DASH manifest URLs returned in YouTube player responses, then hands the resulting URL to the downloader ([player-response URL extraction](https://github.com/yt-dlp/yt-dlp/blob/2026.07.04/yt_dlp/extractor/youtube/_video.py#L3349-L3381), [final format URL construction](https://github.com/yt-dlp/yt-dlp/blob/2026.07.04/yt_dlp/extractor/youtube/_video.py#L3480-L3574), [manifest requests](https://github.com/yt-dlp/yt-dlp/blob/2026.07.04/yt_dlp/extractor/youtube/_video.py#L3671-L3742)). The official PO-token guide also demonstrates video delivery from dynamically prefixed `*.googlevideo.com` hosts ([yt-dlp PO Token Guide](https://github.com/yt-dlp/yt-dlp/wiki/PO-Token-Guide)).

Consequently:

- a permanent exact-host list is not feasible;
- a versioned suffix/endpoint policy can work for a pinned release, but YouTube may add or remove endpoints without notice;
- permitting all of `google.com` or `googleapis.com` would be far broader than the product intent;
- every request, redirect, DNS result, manifest child URI, and media connection must be revalidated, not just the submitted URL.

### A configured proxy is not containment by itself

`yt-dlp` supports an HTTP/HTTPS/SOCKS proxy and socket timeout ([network options](https://github.com/yt-dlp/yt-dlp/blob/2026.07.04/README.md#network-options)), but a process compromised after launch can open its own socket and bypass a voluntary proxy wherever the OS has granted general outbound access. The proxy becomes a security boundary only if the worker has no direct IP-network capability and can reach the broker solely through inherited IPC, or if the OS forcibly redirects/limits all of the worker's egress.

The latter cannot be promised uniformly:

- macOS App Sandbox exposes outbound networking as the broad `com.apple.security.network.client` entitlement, which authorizes initiating connections rather than naming remote hosts ([Apple network-client entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.network.client));
- stable Windows AppContainer uses broad capability SIDs such as `internetClient`; Microsoft's new sandbox API can force AppContainer traffic through a proxy, but it is explicitly experimental, requires Windows 11, has no public header, and is not a dependable v1 foundation ([AppContainer capability model](https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer), [experimental proxy policy and requirements](https://learn.microsoft.com/en-us/windows/win32/secauthz/createprocessinsandbox#network_policy));
- Linux Landlock network rules constrain TCP/UDP ports, not destination hostnames or addresses. Network namespaces/firewall rules can create a broker-only route, but availability of unprivileged namespaces and delegated policy is distribution-dependent ([Landlock network rights](https://docs.kernel.org/userspace-api/landlock.html#network-flags)).

That is why the worker itself must be offline in the common design.

## Enforceable common contract

### 1. Canonical input, never raw user input

Electron main parses an accepted public YouTube video URL, extracts one syntactically valid video ID, and reconstructs exactly:

```text
https://www.youtube.com/watch?v=<video-id>
```

It passes that canonical URL as a single argv/protocol field, never a user-supplied URL string. Reject credentials in URLs, non-HTTPS schemes, IP literals, non-default ports, fragments, playlists/channels/search/live feeds, and any URL that does not identify exactly one video. Strip every user query parameter other than the validated video ID. The worker independently checks that the extracted result reports the same provider and video ID before downloading.

This is stricter than relying on `--no-playlist`: that option only chooses the video when a URL refers to both a video and playlist ([option definition](https://github.com/yt-dlp/yt-dlp/blob/2026.07.04/yt_dlp/options.py#L769-L775)).

### 2. Fixed, pinned `yt-dlp` invocation

Use a bundled wrapper around the pinned `yt-dlp` library, not arbitrary CLI arguments from the renderer. The wrapper constructs a fixed option object equivalent to these constraints:

- allow only the exact `Youtube` video extractor; do not load `default`, `generic`, `YoutubeTab`, search, or plugin extractors. `yt-dlp` supports an allowlist through `--use-extractors`, and its loader builds only the selected extractor set ([option](https://github.com/yt-dlp/yt-dlp/blob/2026.07.04/yt_dlp/options.py#L400-L409), [loader](https://github.com/yt-dlp/yt-dlp/blob/2026.07.04/yt_dlp/YoutubeDL.py#L927-L946));
- ignore every portable/home/user/system config and custom config location. The parser otherwise searches all four locations ([config loading source](https://github.com/yt-dlp/yt-dlp/blob/2026.07.04/yt_dlp/options.py#L43-L113), [`--ignore-config`](https://github.com/yt-dlp/yt-dlp/blob/2026.07.04/README.md#configuration));
- disable plugin directories and set `YTDLP_NO_PLUGINS=1`. The project warns that plugin code is imported without checks, and `--no-plugin-dirs` clears default and supplied locations ([plugin warning and locations](https://github.com/yt-dlp/yt-dlp#plugins), [option](https://github.com/yt-dlp/yt-dlp/blob/2026.07.04/yt_dlp/options.py#L443-L458));
- disable remote components, browser cookies, cookie files, `.netrc`, credential commands, self-update, aliases, exec/postprocessor hooks, external downloaders, file URLs, impersonation extras, metadata/thumbnail/comment/subtitle writes, and archive files;
- use a fixed output name under the Acquisition Workspace, based only on the job UUID and validated container extension—not title, uploader, or any remote metadata;
- provide no shell and no caller-controlled environment or `PATH`; executable paths come from the signed/hashed release manifest.

The worker must assert its effective configuration at startup and abort if any direct request handler, unexpected extractor, plugin, postprocessor, external downloader, or output root is present.

### 3. Pinned JS challenge runtime

Current full YouTube support requires an external JavaScript runtime plus the `yt-dlp-ejs` solver ([official EJS guide](https://github.com/yt-dlp/yt-dlp/wiki/EJS)). Package and hash an exact Deno version and the exact EJS component; select it by full path after clearing default JS runtimes; disallow remote components.

At `2026.07.04`, yt-dlp invokes Deno with `--no-remote`, `--no-prompt`, `--no-config`, no code cache, no lockfile, no node-modules directory, and cached/bundled solver material ([Deno provider](https://github.com/yt-dlp/yt-dlp/blob/2026.07.04/yt_dlp/extractor/youtube/jsc/_builtin/deno.py#L32-L87)). No `--allow-net`, `--allow-read`, `--allow-write`, or `--allow-run` flag is granted. Keep those properties as acceptance assertions, enable the documented `youtube-ejs:jitless=true` defense unless benchmark evidence rejects it, and scrub the environment because the provider otherwise copies the current environment before adding proxy values ([provider environment handling](https://github.com/yt-dlp/yt-dlp/blob/2026.07.04/yt_dlp/extractor/youtube/jsc/_builtin/deno.py#L89-L110), [official `jitless` option](https://github.com/yt-dlp/yt-dlp/blob/2026.07.04/README.md#youtube-ejs)).

Do not use Bun: the official guide says it has no permission restriction and current support is deprecated. Node is not needed if pinned Deno passes the corpus ([EJS runtime matrix](https://github.com/yt-dlp/yt-dlp/wiki/EJS)).

### 4. One media object; no acquisition FFmpeg

Prefer one non-live audio-only format; if no supported audio-only stream exists, select one combined media format and let the later offline Analysis Job decode its audio. Do not select separate audio/video streams, HLS/DASH manifests, live/post-live formats, or any format that requires merge/remux/postprocessing.

This removes FFmpeg, ffprobe, external downloaders, shell hooks, and postprocessors from the networked process tree. It also avoids a known limit gap: `yt-dlp --max-filesize` checks a response only when a reliable `Content-Length` exists; encoded/unknown-length responses bypass that precheck, and postprocessor output is outside it ([HTTP downloader check](https://github.com/yt-dlp/yt-dlp/blob/2026.07.04/yt_dlp/downloader/http.py#L200-L227)).

If future compatibility requires acquisition-time FFmpeg, that is a new security decision: package a separate hash-pinned build, remove its network protocols, give it only inherited descriptors/workspace access, include it in the same process-domain limits, and re-run every gate below. The v1 contract should not mention an acquisition FFmpeg unless such a path is actually exercised and proved.

### 5. Broker request policy

The broker is a minimal process, separate from the renderer and from parsing/analysis code. For every request it must:

1. accept only a bounded method/header/body schema required by the pinned YouTube extractor; remove proxy-auth, authorization, cookie import, arbitrary `Host`, and hop-by-hop headers;
2. allow HTTPS only, default port 443 only, no URL credentials, no IP-literal host, and no Unicode ambiguity after IDNA/canonical-host processing;
3. apply a versioned deny-by-default endpoint policy generated from the pinned release's traces. Initial categories will likely include exact YouTube web/API hosts, bounded YouTube image/player hosts if the extractor needs them, and `*.googlevideo.com` media delivery; the shipped list must be evidence from the corpus, not copied from this research note;
4. resolve DNS itself and reject every A/AAAA/CNAME result that is loopback, RFC1918/ULA, link-local, carrier-grade NAT, multicast, unspecified, documentation/test, or otherwise non-global. Connect to the validated result while preserving the approved SNI/hostname and normal certificate verification; never accept `--no-check-certificates` or insecure HTTP;
5. disable automatic redirect following in the broker transport. Parse one bounded `Location` at a time, resolve relative redirects, re-run the full URL/host/DNS policy, impose a small redirect-hop cap, and reject scheme downgrade;
6. enforce per-response, per-request-body, aggregate received-byte, request-count, redirect-count, concurrent-request, idle-time, and wall-clock budgets while streaming. Do not buffer an unbounded body in Electron main;
7. record destination hostname category, resolved IP family, status, content length if known, transferred bytes, redirect chain, TLS validation result, and policy version—but never signed media URLs, transient tokens, or full query strings in normal logs.

Endpoint additions are release-policy changes. An unexpected host is a structured fail-closed error with enough redacted provenance for maintainers; the app must not automatically widen the policy or retry through a direct connection.

### 6. Filesystem, process, and quota contract

The Extractor Worker gets read/execute access only to its exact packaged runtime and CA bundle, and read/write access only to a fresh Acquisition Workspace. It cannot see the Project Library, source paths, browser profiles, user home, system credential stores, model store, update cache, or another job's workspace.

Electron main creates a job manifest containing the job UUID, canonical YouTube video ID, requested Project Range, pinned component hashes/versions, endpoint-policy version, and budgets. The job environment redirects home/temp/cache/config variables into the workspace or removes them. All unrelated file descriptors/handles/sockets are closed.

Use all available layers; no single `yt-dlp` flag is the quota:

- metadata duration and format size are early rejection hints, not trusted enforcement;
- broker byte/request/wall-clock accounting terminates the stream at its cap;
- a supervisor monitors actual workspace allocation and rejects any output above the total job budget;
- platform process/memory/CPU/file-size primitives enforce or narrow resource use;
- one job runs per containment domain, so cancellation and cleanup never target unrelated work.

Numeric limits should be selected from the v1 benchmark corpus and available-disk UX, then fixed in the ingestion specification. This research establishes the mechanisms, not arbitrary product numbers.

### 7. Atomic staged handoff

Acquisition success requires all of the following, in order:

1. broker closes every network stream and refuses new requests;
2. worker and every descendant exit; the platform supervisor verifies the tracked tree/domain is empty;
3. output file is closed and stable; main opens it without following symlinks/reparse points, confirms it remains under the workspace, is a regular file, has one allowed media container signature, and is within the byte budget;
4. main computes SHA-256 of downloaded bytes, probes bounded metadata with the offline analysis toolchain, and confirms the returned YouTube ID, duration/range coverage, selected format, and manifest agree;
5. main creates an immutable Source Snapshot manifest with canonical video ID, original user URL as provenance, acquisition timestamp, yt-dlp/Deno/EJS versions and hashes, endpoint-policy version, format ID/container/codecs/duration, byte size/hash, broker summary, and completion status;
6. main copies or atomically moves the validated closed file into a newly created offline Analysis Workspace. The Analysis Job receives no acquisition IPC handle, URL, broker capability, or live network descriptor;
7. on any failure or cancellation, no Snapshot is published. The disposable acquisition workspace is removed after the process domain is confirmed dead; startup scavenging removes abandoned workspaces from prior crashes.

If acquisition succeeds but analysis fails, retention is a product decision: by default keep the immutable manifest and delete the downloaded media after the failed attempt; an explicit offline-cache choice may retain the validated media by content hash outside both job workspaces. Never leave the acquisition workspace as an accidental cache.

## Platform enforcement

### macOS 13+

Required shape:

- a separately signed native XPC Extractor Worker with App Sandbox and **no** `com.apple.security.network.client` or server entitlement;
- an app-owned broker reached through an explicit XPC/framed-pipe capability; the worker never inherits Electron main's network or user-selected-file rights;
- packaged yt-dlp/Python/Deno helpers signed for sandbox inheritance, with only the worker's static rights. Apple recommends XPC for privilege separation and notes that directly launched children inherit only static sandbox rights ([App Sandbox inheritance](https://developer.apple.com/library/archive/documentation/Miscellaneous/Reference/EntitlementKeyReference/Chapters/EnablingAppSandbox.html#//apple_ref/doc/uid/TP40011195-CH4-SW26), [XPC services](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingXPCServices.html));
- the XPC service's private container is the enforceable writable boundary. Do not claim the OS restricts it to exactly one subdirectory;
- inherited hard `setrlimit` values for file size, CPU time, descriptors, and other measured limits. Apple documents that limits are inherited by children, but `RLIMIT_CPU` and `RLIMIT_FSIZE` are per-process/per-file rather than aggregate job budgets ([Apple `setrlimit`](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/getrlimit.2.html), [Secure Coding Guide](https://developer.apple.com/library/archive/documentation/Security/Conceptual/SecureCodingGuide/Articles/AccessControl.html#//apple_ref/doc/uid/TP40002589-SW27)).

Residual: Apple documents that `Process.terminate()` signals the process and its subtasks, and XPC services are tied to client/service lifecycle, but public App Sandbox APIs do not provide a Windows-Job-equivalent hostile descendant cap and atomic tree kill ([Foundation `Process`](https://developer.apple.com/documentation/foundation/process), [XPC lifecycle](https://developer.apple.com/documentation/xpc)). All descendants must remain sandboxed even if cleanup fails. Cancel/crash/orphan tests are release gates, and product language must not promise aggregate macOS process/memory enforcement.

### Windows x64

Required shape:

- stable AppContainer APIs with no Internet/private-network capability on the Extractor Worker; explicit ACL grants only for packaged read-only runtime files, the one workspace, and the broker IPC object. AppContainer access is the intersection of the user and AppContainer grants ([AppContainer isolation](https://learn.microsoft.com/en-us/windows/win32/secauthz/appcontainer-isolation), [launching an AppContainer](https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer));
- a non-breakaway Job Object established before untrusted code resumes, with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, active-process, job memory/CPU/time limits, completion-port accounting, and explicit membership checks. Children join by default when breakaway is not allowed, and closing/terminating the job can kill the associated tree ([Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects), [basic limits](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_limit_information));
- a broker named pipe/handle whose ACL grants only the job's AppContainer identity; no inherited user handles, registry access, browser state, or credential capabilities;
- Authenticode plus release-manifest verification for the launcher, worker, Python runtime, Deno, DLLs, and CA bundle.

Do not base v1 on `Experimental_CreateProcessInSandbox`. Although its documented `network_policy.proxy` says all AppContainer outbound traffic is routed through the proxy, Microsoft marks the API experimental, Windows 11-only, versioned `0.1.0`, and without a public header ([Microsoft requirements](https://learn.microsoft.com/en-us/windows/win32/secauthz/createprocessinsandbox#requirements)). It is useful as a future simplification, not a current release dependency.

### Linux x64 and arm64

Required baseline:

- native launcher applies `no_new_privs`, Landlock ABI 3+ filesystem rules, closes inherited sockets, then installs a seccomp filter denying IP/packet/vsock/netlink socket creation while allowing only the measured broker IPC mechanism. Seccomp filters persist through fork/clone/exec when allowed ([seccomp inheritance](https://docs.kernel.org/userspace-api/seccomp_filter.html#usage), [`no_new_privs`](https://docs.kernel.org/userspace-api/no_new_privs.html));
- Landlock grants read/execute only to exact packaged runtime roots and read/write only to the Acquisition Workspace. ABI 3 is needed to deny truncation; rules apply to future children ([Landlock filesystem rights and ABI](https://docs.kernel.org/userspace-api/landlock.html));
- delegated cgroup v2, where present, sets `pids.max`, memory/CPU limits and uses `cgroup.kill`, which kills a cgroup and all descendants ([cgroup v2 controls](https://docs.kernel.org/admin-guide/cgroup-v2.html));
- a private network namespace with no external route may strengthen broker-only enforcement when the declared distro baseline supports it, but it is not required for the common claim if seccomp denies all direct IP socket creation and the broker uses a pre-opened pipe or permitted local IPC.

Residual: Landlock ABI 3 cannot scope all local IPC and Landlock network controls are port-based and begin at later ABIs. Without delegated cgroup v2 there is no kernel-backed aggregate process cap/tree kill; a process group is cleanup, not containment. The Linux support matrix must declare tested kernels/distros and whether strict cgroup limits are available. If Landlock or the seccomp policy cannot be established, the contained acquisition path fails closed.

## Release gates

No platform ships YouTube acquisition until the signed/installed artifact passes all relevant gates.

### Supply-chain and configuration gates

- manifest-pinned hashes and versions for the wrapper, Python/yt-dlp, Deno, EJS, CA bundle, and every native library; verify before launch;
- SBOM and license record; reproducible or independently verifiable release acquisition where available;
- effective configuration dump proves: one `Youtube` extractor, one broker handler, zero direct handlers, zero plugins, zero remote components, one full-path Deno runtime, no cookies/netrc, no external downloader/postprocessor/exec/update, one workspace output root;
- tamper each component and config/environment input; launch must fail before network or untrusted parsing;
- upgrade gate diffs `yt-dlp` networking, YouTube extractor, downloader, JS provider, option/config, and subprocess behavior from the previously approved revision.

### Endpoint-policy gates

- run the licensed/allowed 30–50-track corpus across regions/IPv4/IPv6 where CI is authorized; record all request categories and approve each endpoint explicitly;
- validate canonical video URLs, redirects, relative redirects, redirect loops, scheme downgrade, encoded/IDNA hosts, credentials, alternate ports, IPv4/IPv6 literals, CNAME chains, and DNS rebinding simulations;
- reject loopback, private, link-local, metadata-service, multicast, unspecified, and non-global targets at every hop;
- inject a malicious manifest/media URL and prove the worker cannot reach it directly and the broker rejects it;
- change the policy to omit one required host and prove a structured fail-closed error, with no direct retry or policy widening;
- prove logs contain no signed media URLs, tokens, cookies, query secrets, or response bodies.

### Resource and lifecycle gates

- unknown/chunked/compressed length, forged small `Content-Length`, oversized response, endless stream, slowloris, retry storm, redirect storm, excessive request count, and insufficient-disk cases terminate at the correct broker/supervisor limit;
- scheduled/live/playlist/channel/search URLs are rejected before download; live/HLS/DASH and multi-stream merge paths are absent from the approved configuration;
- cancel during extraction, player challenge, and media streaming; kill Electron main, broker, worker, and Deno independently; verify no new requests, no surviving enforceably tracked descendants, no published Snapshot, and eventual workspace cleanup;
- exceed CPU, memory, file-size, process-count, wall-time, and total-workspace budgets; record which layer enforced each limit on each platform;
- symlink/reparse-point/hard-link races, path traversal, alternate data streams, sparse files, and output replacement are rejected during handoff;
- acquisition-complete/analysis-failed and app-crash/restart paths obey the chosen retention rule and never treat a partial file as cache.

### Handoff gates

- start Analysis only after broker shutdown and verified empty acquisition process domain;
- assert the Analysis Job has no broker handle, acquisition URL, network descriptor, proxy variable, or network capability;
- mutate downloaded bytes, manifest ID/duration/format/hash, or output after worker exit and prove validation rejects the handoff;
- prove duplicate downloads with identical bytes yield the same content hash while different bytes under the same YouTube ID create distinct immutable Source Snapshots.

## Residual unknowns and follow-up decisions

1. **Broker adapter proof:** the broker-only `RequestHandler` uses a source-visible extension point but not a promised stable API. A packaged prototype must prove streaming, cancellation, range requests, retries, compression, TLS/error semantics, and Deno challenge operation on all three platforms before the ingestion decision can claim feasibility.
2. **Endpoint policy seed:** do not freeze a hostname list from documentation. Generate the first version from the exact pinned build and benchmark traces, review it, then fail closed on drift.
3. **Format availability:** the corpus must establish whether one progressive/audio-only HTTPS format is sufficient without manifests, FFmpeg, cookies, PO-token plugins, or remote components. If not, the scope/security decision must be reopened rather than silently enabling them.
4. **Numeric budgets:** duration, bytes, requests, redirects, retries, concurrency, idle/wall time, memory, CPU and process limits depend on baseline measurements and available-disk UX.
5. **Linux support floor:** kernel/Landlock/seccomp/cgroup availability must become an explicit supported-distribution matrix.
6. **Compatibility mode:** if desired, it needs separate consent and wording. It may retain filesystem/process containment but cannot claim endpoint confinement when the worker has broad outbound Internet.

## Rejected claims and mechanisms

| Claim or mechanism | Result |
|---|---|
| Validate the submitted `youtube.com` URL once | Reject: redirects and player/manifest/media URLs create later destinations. |
| A permanent exact YouTube hostname list | Reject: delivery hosts and extractor dependencies are dynamic. Use a versioned deny-by-default policy with release traces. |
| `yt-dlp --proxy` alone confines a compromised worker | Reject: it is voluntary unless direct IP networking is denied or forcibly routed by the OS. |
| Give the worker broad Internet and trust its host checks | Reject for the containment claim; acceptable only as explicitly weaker compatibility behavior. |
| `--max-filesize` is the disk quota | Reject: the precheck depends on reliable `Content-Length` and is not an aggregate workspace cap. |
| Run FFmpeg to convert immediately after download | Reject in v1: it enlarges the networked process/parser tree without being needed for analysis handoff. |
| Browser cookies, `.netrc`, PO-token plugins, or account credentials | Out of the v1 acquisition contract; they materially change privacy, exfiltration impact, endpoint policy, and account-ban risk. |
| Start offline analysis while acquisition descendants or sockets remain | Reject: network/domain separation is temporal as well as filesystem-based. |
| Same quota/process guarantee on every OS | Reject: Windows Job Objects are stronger; macOS and Linux have documented residuals. |

## Decision statement for the product specification

The ingestion specification can state:

> Open Chords v1 acquires a single public YouTube video through a pinned, credential-free yt-dlp worker. The worker has no direct IP-network capability and can access only signed/hashed runtime files plus a disposable acquisition workspace. A separate least-privilege broker validates every HTTPS request, redirect, DNS result, endpoint-policy rule and byte/time budget. Acquisition fully terminates and its closed output is hash/schema/media-validated before a copy enters the offline Analysis Job. Endpoint-policy drift and containment setup failures fail closed. Platform-specific process/resource guarantees and residuals are published and release-tested.

Until the broker adapter and platform packages pass the release gates, the narrower truthful statement is:

> YouTube acquisition is isolated from canonical project data and credentials, but endpoint confinement is not yet established; a directly networked yt-dlp process may reach the broader Internet if compromised.

## Research provenance

- `yt-dlp` facts were checked against the immutable `2026.07.04` release (`fdec00e0bf530dc6c3cc7b1dd780e95d9ae460e9`) and, for drift, current upstream `master` at `5d6b8c8cd19785c3086ae3a9ec618c45e25eb3bc` dated 2026-08-04. Relevant networking/configuration/Deno behavior had not changed between those revisions; YouTube format extraction had subsequent non-contract changes.
- Context7 was available. `resolve-library-id` selected the high-reputation official `/yt-dlp/yt-dlp` corpus; two `query-docs` calls were used to cross-check CLI hardening and size/format behavior. Durable citations above link the owning project's release source and first-party OS/kernel documentation.
- Platform claims use Apple Developer Documentation, Microsoft Learn, and Linux kernel documentation. No secondary security write-up is used as evidence.

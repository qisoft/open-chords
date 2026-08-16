# Open Chords v1: desktop and local-sidecar stack

> Checked 2026-08-12. This is an architecture research result, not implementation. Library facts were checked through Context7 against the official Electron and Electron Forge documentation, then against the linked first-party sources.

## Decision summary

Use a current stable Electron desktop shell with Electron Forge for packaging, and keep the analysis engine as a separately packaged, platform-specific executable supervised by Electron's **main process**:

```text
local renderer (sandboxed)
  -> narrow typed preload API
  -> Electron main process (authority + job supervisor)
  -> framed JSON protocol over child stdin/stdout
  -> packaged Python analysis sidecar
  -> bounded CPU worker processes / external tools
```

For the initial dependency floor, pin **Electron 43.x** (latest patch at build time; `43.4.0` on the check date) and **Electron Forge 7.11.x** (`7.11.2` is the current stable Forge release). Electron 43.4.0 embeds Chromium 150 and Node 24.18.1. Do not start on Electron 44 beta or Forge 8 alpha. Electron supports only its latest three stable majors, so Electron upgrades are recurring security maintenance, not an occasional feature project ([Electron releases](https://releases.electronjs.org/?channel=stable), [release policy](https://www.electronjs.org/docs/latest/tutorial/electron-timelines), [Forge releases](https://github.com/electron/forge/releases)).

Package the Python environment as a **PyInstaller one-folder** sidecar initially, built and tested independently for each supported OS/architecture, then copy it as an Electron Packager `extraResource`. PyInstaller `6.22.0` is current on the check date, supports Python 3.8+, and is explicitly not a cross-compiler ([PyInstaller manual](https://pyinstaller.org/en/stable/index.html)). One-folder avoids the extraction path/startup/antivirus behavior of a one-file bundle and makes model/native-library failures easier to diagnose. This is a v1 recommendation, not a claim that PyInstaller is the only valid freezer.

## Framework facts

### Electron security and process model

- `contextIsolation` defaults to true, renderer sandboxing is the default since Electron 20, and Electron's own default app sets `contextIsolation: true`, `sandbox: true`, and `nodeIntegration: false`. Electron additionally requires navigation/window restrictions, a restrictive CSP, permission handlers for remote content, IPC sender validation, and no raw Electron API exposure to untrusted content ([security checklist](https://www.electronjs.org/docs/latest/tutorial/security), [context isolation](https://www.electronjs.org/docs/latest/tutorial/context-isolation)).
- A preload should expose individual capabilities through `contextBridge`, not pass `ipcRenderer` through. Any main-process handler with file, process, network, or project authority must validate the sender frame and validate the payload independently ([IPC guide](https://www.electronjs.org/docs/latest/tutorial/ipc), [security checklist](https://www.electronjs.org/docs/latest/tutorial/security#17-validate-the-sender-of-all-ipc-messages)).
- Electron recommends `utilityProcess` over Node `child_process.fork` for a **Node.js** child. It supports Node APIs, message ports, `spawn`/`exit` events, graceful `kill()`, and attribution through `serviceName`; Electron also reports utility failures such as crash, OOM, launch failure, and Windows integrity failure through `child-process-gone` ([process model](https://www.electronjs.org/docs/latest/tutorial/process-model), [`utilityProcess`](https://www.electronjs.org/docs/latest/api/utility-process), [`app` events](https://www.electronjs.org/docs/latest/api/app#event-child-process-gone)).
- `utilityProcess.fork(modulePath)` launches a Node module. It is not a general executable launcher and therefore does not replace `child_process.spawn` for a frozen Python sidecar. Node's `spawn` accepts an executable and argument array without a shell by default, supports cancellation/timeouts, and can hide the console on Windows ([Node `child_process`](https://nodejs.org/api/child_process.html#child_processspawncommand-args-options)).
- Electron warns that its `<webview>` tag is unstable and recommends an `iframe`, `WebContentsView`, or avoiding embedded content. For the official YouTube player inside the trusted local UI, the ordinary IFrame Player API is the smallest surface; do not enable Electron's `webviewTag` for v1 ([Electron web embeds](https://www.electronjs.org/docs/latest/tutorial/web-embeds), [`<webview>` warning](https://www.electronjs.org/docs/latest/api/webview-tag)).

### Packaging facts and platform constraints

- Electron Forge is the Electron team's integrated packaging pipeline. Its makers create platform-specific artifacts. Electron Packager's `extraResource` copies files directly into `Contents/Resources` on macOS and `resources` elsewhere, which is suitable for a frozen sidecar and its native libraries ([Forge makers](https://www.electronforge.io/config/makers), [Packager options](https://electron.github.io/packager/main/interfaces/Options.html#extraResource)).
- Executables should not live inside `app.asar`: Electron documents execution and working-directory limitations for ASAR, while `extraResource` provides a real filesystem path. Resolve the production sidecar beneath `process.resourcesPath`; never make an ASAR or application-install directory writable ([ASAR limitations](https://www.electronjs.org/docs/latest/tutorial/asar-archives)).
- Forge's Vite plugin remains explicitly experimental and has no API-stability guarantee; MSIX support is also experimental. V1 can still use Vite as a separate renderer build step, but should not make the experimental Forge plugin or MSIX the release-critical seam ([Forge Vite status](https://www.electronforge.io/templates/vite), [MSIX maker](https://www.electronforge.io/config/makers/msix)).
- Public macOS distribution requires signing and notarization to avoid Gatekeeper intervention; Forge performs these in the package step and requires Xcode/Apple credentials. Windows distribution should be Authenticode-signed. The sidecar and nested native binaries must be present before signing, and the installed artifact—not only the unpacked app—must be exercised ([Forge macOS signing](https://www.electronforge.io/guides/code-signing/code-signing-macos), [Forge code signing](https://www.electronforge.io/guides/code-signing)).
- Electron 43 is the last safe baseline if macOS 12 and legacy 32-bit artifacts are desired. Electron 44 removes macOS 12, Windows ia32, and Linux armv7l. Open Chords should instead declare a 64-bit v1 matrix and explicitly choose whether macOS 12 support is worth holding an older Electron line; the recommendation is **macOS 13+, Windows x64/arm64, and Linux x64/arm64** so Electron can advance to 44 after validation ([planned Electron 44 removals](https://www.electronjs.org/docs/latest/breaking-changes#planned-breaking-api-changes-440)).
- A Python sidecar must be built on each target OS; Linux compatibility also depends on the build image because PyInstaller does not bundle glibc. macOS universal Electron packaging does not make Python/native wheels universal automatically. CI therefore needs separate signed/notarized macOS arm64 and x64 (or a proven universal sidecar), Windows x64 first, and declared Linux distribution baselines ([PyInstaller manual](https://pyinstaller.org/en/stable/index.html), [PyInstaller usage](https://pyinstaller.org/en/stable/usage.html)).

### YouTube embed facts

- The YouTube IFrame API supports play/pause/seek, state events, current time, and playback-rate control. `enablejsapi=1` enables control and Google recommends supplying the full host `origin` to prevent control hijacking ([IFrame API](https://developers.google.com/youtube/iframe_api_reference), [player parameters](https://developers.google.com/youtube/player_parameters)).
- Embedded clients must identify themselves with `HTTP Referer` or equivalent client identity; missing identity can produce IFrame error `153`. Some videos refuse embedding (`101`/`150`), and autoplay can be blocked. These are expected runtime states, not sidecar failures ([IFrame errors](https://developers.google.com/youtube/iframe_api_reference#onError), [required minimum functionality](https://developers.google.com/youtube/terms/required-minimum-functionality)).
- The official facts do **not** establish that an Electron custom-scheme page will always produce acceptable `origin`/Referer identity in every packaged build. That compatibility must be tested. Do not falsify headers or intercept YouTube traffic to work around a failed identity check.

## Recommended v1 boundaries

### Renderer and playback

1. Load only packaged Open Chords UI code in the application renderer. Use a privileged custom `open-chords://` scheme rather than `file://`, a restrictive CSP, sandbox, context isolation, and no Node integration.
2. Expose a versioned, domain-level preload API such as project open/save, source selection, playback metadata, and analysis job commands. No arbitrary filesystem path reads, shell commands, raw IPC, or generic network fetch.
3. Validate the sender URL/frame in every privileged IPC handler and validate payloads against one shared runtime schema. Only the top-level local Open Chords frame may call privileged handlers; a YouTube child frame never may.
4. Play local files with Chromium media primitives through a read-only custom protocol handler that implements byte-range responses. The protocol maps an opaque project media id to an already-authorized path; the renderer never supplies a raw path in a URL.
5. Embed YouTube with the official `<iframe>` API inside the local UI. CSP should allow only the exact YouTube player/script/image endpoints needed; deny new windows and unexpected top-level navigation. Treat embed unavailable, identity error, autoplay blocked, and network loss as explicit UI states.
6. Before freezing the scheme choice, run a signed packaged smoke test on all release OSes for YouTube API readiness, identity/error 153, seek synchronization, fullscreen, rate enumeration, and non-embeddable videos. If the custom scheme cannot meet YouTube identity requirements, the fallback is a random-port loopback origin owned by the main process with strict sender/token checks—not header spoofing.

### Sidecar lifecycle and protocol

1. Electron main owns exactly one sidecar supervisor. It launches the explicit packaged executable with `spawn(executablePath, args, { shell: false, windowsHide: true, cwd: perRunDir, env: minimalEnv })`. Never concatenate user text into a command or invoke a shell.
2. Use length-prefixed JSON or NDJSON on stdin/stdout as a private, versioned RPC/event channel. Stdout is protocol-only; diagnostics go to stderr. A first-message handshake must include protocol version, sidecar build/version, supported analyzers, and model manifest. Reject incompatible versions before accepting jobs.
3. Renderer requests become immutable job commands in main. Main assigns job ids and paths, enforces allowed operations, and sends the sidecar only project-scoped paths. The sidecar does not expose a TCP listener. Large audio, models, and results move by files in a main-created per-job directory; IPC carries descriptors, hashes, progress, and bounded errors rather than blobs.
4. Sidecar starts only when analysis is needed and stays warm while work is active. Default v1 concurrency is one CPU-heavy analysis job; the sidecar may use a bounded worker pool internally. Electron main and renderer remain responsive because no MIR work runs in them.
5. Persist the job intent/status and atomic result checkpoints in the project library, not only in memory. On crash, EOF, timeout, protocol violation, or non-zero exit: mark the active attempt interrupted with structured failure provenance, retain diagnostically useful bounded logs, clean temporary audio according to policy, and permit an explicit retry. Use capped exponential restart only when work is pending; stop after a small crash-loop budget.
6. Cancellation is two phase: send a protocol cancel for the job and wait a bounded grace period, then terminate the sidecar/process tree. App shutdown uses the same bounded drain/terminate sequence. Recovery tests must include killing Electron, killing the sidecar, killing a worker, OOM-like exit, corrupt output, and disk-full behavior. Process-tree termination is OS-specific and must be tested; `child.kill()` alone is not proof that grandchildren stopped.
7. Models live in a versioned user-data model store, not inside mutable application resources. Bundled manifests record version/hash/license; optional downloads use HTTPS, checksum verification, atomic rename, and explicit provenance. Sidecar resources are read-only; jobs and caches live under `userData`/temporary project storage.

### Packaging choice

- Electron Forge `7.11.x` stable orchestrates Package/Make/signing. Use Packager `extraResource` for a per-platform PyInstaller one-folder sidecar. Keep application JS in ASAR, and the executable/native libraries outside it.
- Use a stable, independently invoked renderer bundler configuration; do not make Forge's experimental Vite plugin a v1 requirement. Prefer ZIP/DMG for macOS, a stable signed Windows installer maker chosen after update-channel requirements are fixed, and AppImage plus one declared Linux package family. Do not gate v1 on experimental MSIX.
- Build each OS/architecture in a native CI runner, sign nested content and the final artifact, install it in a clean VM, then exercise local playback, YouTube playback, sidecar startup, one analysis, cancellation, upgrade, and uninstall. The benchmark ticket remains responsible for CPU runtime/quality thresholds; this decision only fixes the execution boundary.

## Rejected alternatives

| Alternative | Why not v1 |
|---|---|
| Run Python/MIR in renderer or main | Breaks responsiveness and turns media/model parsers into desktop authority. |
| Electron `utilityProcess` as the Python sidecar | It forks a Node module, not a frozen Python executable. It remains useful later for isolated Node-only work. |
| Renderer talks directly to sidecar over localhost | Creates an unnecessary network/authentication surface and bypasses main-process authorization. |
| Electron `<webview>` for YouTube | Electron explicitly recommends alternatives due to stability concerns; the official IFrame API is the intended player integration. |
| Put the sidecar inside ASAR | Executable/cwd/native-library behavior needs real paths; resources must be copied outside ASAR. |
| PyInstaller one-file | Temporary extraction, startup, process cleanup, and antivirus behavior add risk with large scientific/native dependencies. Reconsider only after measurements. |
| Forge 8 alpha, Electron 44 beta, Forge Vite plugin, or MSIX as release foundations | They are prerelease or explicitly experimental on the check date. |
| Long-lived local HTTP analysis API | Adds ports, tokens, CSRF/origin rules, discovery, and orphan-service recovery without benefit for a single local client. |

## Residual risks and follow-up acceptance points

These are not reasons to reopen the stack decision, but later tickets must make them concrete:

1. **YouTube packaged-origin compatibility:** prove the custom-scheme IFrame works with Referer/client identity on every target; otherwise specify the hardened loopback UI origin. Playback-rate availability is video/player-dependent, so practice speed must expose only rates returned by the API.
2. **Process/security contract:** define the exact IPC schemas, sender allowlist, custom-protocol privileges, filesystem capability rules, protocol handshake, cancellation escalation, crash-loop budget, and log redaction in the desktop-boundary ticket.
3. **Python freeze feasibility:** build a thin sidecar with the selected MIR/native dependency set on the actual matrix. PyInstaller hooks, multiprocessing, model lookup, FFmpeg/yt-dlp execution, macOS hardened runtime, Windows signing, antivirus, Linux glibc, and arm64 wheels are empirical release risks.
4. **OS support/update channel:** choose final minimum OS/distribution versions and installer/update formats. Electron 44 forces macOS 13+ and 64-bit-only if the app follows the supported line.
5. **Local playback parity:** verify custom-protocol byte ranges, seek precision, long files, codecs, variable playback speed without pitch shift, sleep/wake, and device changes against the product interaction contract.
6. **Resource control:** the benchmark must set concurrency, CPU threads, memory/disk budgets, thermal expectations, model download sizes, and acceptable real-time factor. A separate process provides containment, not a resource limit by itself.
7. **Supply chain:** freeze and checksum the Electron/Node, Python, FFmpeg, yt-dlp, model, and native-wheel manifests; establish an Electron patch cadence and signed update rollback before release.

## Fact versus recommendation

The Electron defaults/APIs, Forge/PyInstaller packaging behavior, release versions, platform removals, and YouTube API requirements above are sourced framework facts. The process diagram, main-owned supervisor, stdio protocol, PyInstaller one-folder choice, single-job default, custom media protocol, Forge/bundler separation, target matrix, restart policy, and test gates are **Open Chords v1 recommendations** derived from those facts. They remain specification decisions until implementation and packaged-runtime tests prove them.

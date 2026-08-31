# Native analysis-sidecar containment

Issue [#49](https://github.com/qisoft/open-chords/issues/49) replaces the protocol-only generic-spawn proof with fail-closed platform brokers. Production code accepts a sidecar process only after the broker has established and inspected the declared OS containment domain. There is no compatibility fallback.

## Common trust boundary

`containment-manifest.json` is hashed into the packaged main bundle. Main rejects a changed manifest, changed or extra native file, unsafe path, symlink, wrong platform backend, or missing helper before launch. The sidecar runtime remains independently protected by `runtime-manifest.json`.

Every broker receives an exact executable, argument array, verified runtime root, and disposable workspace. It uses no shell or `PATH` lookup and passes only protocol stdin/stdout/stderr. Setup evidence is accepted only from the manifest-authorized native broker after its platform checks complete.

The installed-artifact proof stages separate sentinel data at representative Project Library, Source, Model Store, credential, and browser-state locations outside the analysis domain. It verifies that direct reads, symlink reads, loopback TCP, inherited control handles, sensitive environment variables, shell-mediated reads, and a process-session or Job breakaway attempt cannot reach host data. It also verifies that the packaged `ffprobe` helper can still execute. The same probe detects those escapes when run without containment, preventing a vacuous test.

The proof then runs cancellation and crash modes that each create an unpublished partial file and a descendant process. It requires the native process domain to reap both the primary process and descendant and rejects any publishable result left by either terminal path before running the successful protocol lifecycle.

## macOS 13+

Electron main communicates through the manifest-verified bridge with `OpenChordsAnalysisService.xpc`. The service has `com.apple.security.app-sandbox` and no network entitlement. Before spawning, it verifies its own entitlements and requires the frozen sidecar executable to carry both App Sandbox and inheritance entitlements. PyInstaller, FFmpeg, and FFprobe are ad-hoc signed with those inheritance entitlements before runtime-manifest hashes are calculated.

The workspace must resolve beneath the XPC service private container. `POSIX_SPAWN_CLOEXEC_DEFAULT` closes every descriptor except protocol stdin/stdout/stderr. Cancellation terminates the tracked process group; connection loss escalates it to `SIGKILL`.

The service private container remains broader than one job directory. macOS still does not claim Windows-equivalent hostile-descendant accounting or atomic tree kill. All allowed descendants remain sandboxed even if they evade the cooperative process group.

## Windows x64

Main creates a fresh AppContainer profile per attempt. Staged inputs and the writable workspace remain beneath that profile's `AC` data directory. The verified sidecar runtime is copied instead into the exact disposable `%LOCALAPPDATA%\OpenChords\ContainmentRuntime\<profile>` directory because Windows does not allow child images to execute from the profile data directory. The launcher canonicalizes both roots, requires the executable to remain beneath the runtime root, and rejects reparse points. While the contained process runs, the exact profile SID receives only non-inheriting directory traversal on the user profile, `AppData`, `%LOCALAPPDATA%`, and the two app-owned shared staging ancestors; serialized ACL updates remove those grants afterward. It does not alter the volume root or shared `Users` directory. Before main copies any runtime files, the launcher protects the empty disposable runtime root with a dual-principal inheritable ACL: the host user retains ownership access while the exact profile SID receives read-and-execute access only. Every copied descendant inherits that ACL when it is created, so launch does not rewrite permissions across the packaged tree. Windows requires both the traditional user and AppContainer principals to pass the access check. The installed-artifact proof requires runtime mutation to remain denied. It never grants or mutates ACLs on the installed runtime, Source, Project Library, Model Store, or arbitrary host paths.

Immediately before launch, the native launcher rejects reparse points on every Windows runtime entry and canonicalizes every directory beneath the canonical root. It then starts the sidecar with that read-only root as its current directory; the writable workspace remains an explicit protocol root. The frozen verifier opens every manifest entry through a relative zero-access handle with final-component reparse following disabled, avoiding a second final-name query for thousands of files inside the restricted token. Sharing flags grant no access to the verifier. Each entry remains bounded by the native proof and is checked for file type, size, content hash, and complete inventory membership before the protocol starts. Manifest-verified FFmpeg paths reuse that proof rather than resolving inaccessible shared ancestors again. After verification, the process changes to the exact native-supplied workspace and lexically anchors each fixed, traversal-free input or artifact path to that current directory; the staged input must still be a regular file. Outside native containment, manifest validation retains full final-path handle resolution.

The launcher creates the sidecar suspended with an empty capability set, assigns it to a Job Object with kill-on-close, no breakaway flags, process and memory limits, and an exact inherited-handle allowlist. The creation policy permits required helper children; they inherit the same AppContainer token and are atomically assigned to the same non-breakaway Job. The launcher inspects the initial child token for the expected AppContainer SID and verifies Job membership before resuming the first untrusted instruction. After the primary exits, the launcher terminates the Job and waits for its active-process count to reach zero before reporting completion. Profile deletion and removal of both disposable roots occur only after the process domain has terminated and main has inspected the output.

## Ubuntu Preview

The optional Preview backend requires a working user systemd manager. Main starts the manifest-verified launcher through a fresh transient scope with `TasksMax=8`, `MemoryMax=3221225472`, `KillMode=control-group`, and a bounded runtime. The launcher verifies that its actual unified-cgroup membership and limits match the requested scope; it does not move itself into or rewrite a caller-supplied cgroup.

Only then does the launcher require Landlock ABI 3 or newer, set `no_new_privs`, allow read/execute access to the verified runtime and dynamic-loader roots, allow writes only beneath the disposable workspace, and install a seccomp filter that permits `AF_UNIX` sockets while denying other socket families and `io_uring_setup`. Missing user-systemd, cgroup delegation, Landlock, seccomp, or any required rule fails launch.

Ubuntu Preview remains conditional rather than part of the macOS/Windows installed release matrix. The broker must be built and exercised on the declared Preview distribution before that distribution carries a containment claim.

## Validation

```sh
python tools/build-native-containment.py --output-root dist/containment
pnpm test:python
pnpm test:unit
pnpm make
pnpm test:packaged
```

The native GitHub matrix builds the macOS XPC service and Windows AppContainer launcher before Forge packaging. Windows also retains the direct frozen-runtime smoke. A macOS helper signed for App Sandbox inheritance must not be executed outside its sandbox parent, so its decode acceptance runs only through the installed XPC proof. The final installed proof, rather than a source-only unit test, is the acceptance seam for platform entitlement/token, path, network, handle, helper, and process-domain behavior.

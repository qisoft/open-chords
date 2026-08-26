# Native analysis-sidecar containment

Issue [#49](https://github.com/qisoft/open-chords/issues/49) replaces the protocol-only generic-spawn proof with fail-closed platform brokers. Production code accepts a sidecar process only after the broker has established and inspected the declared OS containment domain. There is no compatibility fallback.

## Common trust boundary

`containment-manifest.json` is hashed into the packaged main bundle. Main rejects a changed manifest, changed or extra native file, unsafe path, symlink, wrong platform backend, or missing helper before launch. The sidecar runtime remains independently protected by `runtime-manifest.json`.

Every broker receives an exact executable, argument array, verified runtime root, and disposable workspace. It uses no shell or `PATH` lookup and passes only protocol stdin/stdout/stderr. Setup evidence is accepted only from the manifest-authorized native broker after its platform checks complete.

The installed-artifact proof stages sentinel data outside the analysis domain and verifies that direct reads, symlink reads, loopback TCP, inherited control handles, sensitive environment variables, and shell-mediated reads are unavailable. It also verifies that the packaged `ffprobe` helper can still execute. The same probe detects those escapes when run without containment, preventing a vacuous test.

## macOS 13+

Electron main communicates through the manifest-verified bridge with `OpenChordsAnalysisService.xpc`. The service has `com.apple.security.app-sandbox` and no network entitlement. Before spawning, it verifies its own entitlements and requires the frozen sidecar executable to carry both App Sandbox and inheritance entitlements. PyInstaller, FFmpeg, and FFprobe are ad-hoc signed with those inheritance entitlements before runtime-manifest hashes are calculated.

The workspace must resolve beneath the XPC service private container. `POSIX_SPAWN_CLOEXEC_DEFAULT` closes every descriptor except protocol stdin/stdout/stderr. Cancellation terminates the tracked process group; connection loss escalates it to `SIGKILL`.

The service private container remains broader than one job directory. macOS still does not claim Windows-equivalent hostile-descendant accounting or atomic tree kill. All allowed descendants remain sandboxed even if they evade the cooperative process group.

## Windows x64

Main creates a fresh AppContainer profile per attempt. The verified sidecar runtime and staged inputs are copied into that profile directory; the launcher refuses runtime, executable, or workspace paths that resolve outside it and rejects reparse points. It never grants or mutates ACLs on the installed runtime, Source, Project Library, Model Store, or arbitrary host paths.

The launcher creates the sidecar suspended with an empty capability set, assigns it to a Job Object with kill-on-close, no breakaway flags, process and memory limits, and an exact inherited-handle allowlist. It inspects the child token for the expected AppContainer SID and verifies Job membership before resuming the first untrusted instruction. Profile deletion occurs only after the process domain has terminated and main has inspected the output.

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

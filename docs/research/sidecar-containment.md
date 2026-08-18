# Open Chords v1: cross-platform analysis-sidecar containment

> Checked 2026-08-14. This is a security architecture decision, not an implementation. It resolves [Validate cross-platform sidecar containment](https://github.com/qisoft/open-chords/issues/19) and qualifies the process boundary proposed in [desktop-sidecar-stack.md](desktop-sidecar-stack.md).

## Decision

Open Chords must **not** claim that an ordinary child process is a cross-platform sandbox, or that v1 can enforce exactly the same containment contract on macOS, Windows, and Linux.

Use a native, fail-closed containment launcher on each platform and make the product claim narrower:

> Analysis runs offline in a least-privilege OS containment domain where the supported platform provides one. The analyzer receives staged copies of only the selected media range and pinned models, writes only inside its disposable analysis storage, and never receives canonical Project/library paths or credentials. Every result is untrusted and is schema/hash/invariant-checked by Electron main before publication. Platform-specific residual access and process-control limits are documented and tested.

The v1 release contract is:

| Platform | Required backend | Enforceable in v1 | Not honestly enforceable as a common claim |
|---|---|---|---|
| macOS 13+ | Native XPC service with App Sandbox, no network entitlements; signed inheriting helpers | Denial of undeclared network access; confinement away from ordinary user data; private writable service container; sandbox inheritance by correctly signed helpers | Exactly one writable subdirectory; aggregate process-count/CPU/memory limit; guaranteed kill of a hostile escaped grandchild |
| Windows x64 | Per-job AppContainer plus non-breakaway Job Object | Default-deny network and user resources; explicit ACL grants; process-tree membership, active-process/resource limits, kill-on-close | Executable allowlisting without machine policy; compatibility of the whole MFA/PostgreSQL stack until proved |
| Linux x64/arm64 | Native launcher: Landlock ABI 3+ filesystem rules, `no_new_privs`, seccomp socket policy; delegated cgroup v2 when present | Descendant-inherited file-open/write/execute policy; no IP sockets with a verified seccomp filter; cgroup process/resource limits and tree kill when delegation exists | One portable guarantee across kernels/distros; process cap/tree kill without delegated cgroup v2; complete local IPC isolation on the minimum Landlock ABI |

Consequences:

1. A containment setup failure is a launch failure, never a silent fallback. A separately named **compatibility mode**, if later offered, must be opt-in and must not carry the containment claim.
2. The sidecar does not read the original local file, Project library, downloaded-model store, browser profile, or account credentials. Electron main stages hash-identified copies into an ephemeral Job Workspace and revalidates outputs before publication.
3. YouTube acquisition is a distinct, explicitly networked phase. `yt-dlp` must not run inside the offline analysis domain.
4. Windows can meet the strongest v1 process-tree contract. Linux can match it only on a declared cgroup-v2 baseline. macOS needs a narrower process-control statement even when App Sandbox is used.
5. The macOS XPC/PyInstaller/MFA combination and the Windows AppContainer/MFA combination are release-blocking packaged proofs of concept. If either cannot run without weakening its sandbox, ship that analyzer later rather than silently broadening the sidecar.

## Threat model and boundaries

The containment domain mitigates a memory-safety or command-injection compromise in media/model parsing, Python/native scientific libraries, FFmpeg, Kaldi/MFA, or a worker process. It protects unrelated user files, canonical Open Chords data, credentials, and the network from that compromised process.

It does not defend against:

- a malicious administrator, kernel, hypervisor, or same-user attacker who can replace the installed application before launch;
- denial of service within limits the OS cannot aggregate;
- a malicious analysis result that passes an incomplete validator;
- source or model content intentionally supplied to the job;
- a vulnerability in the OS sandbox itself.

Signing, hash verification, restricted IPC, and output validation remain separate layers. Hardened Runtime, Authenticode, PyInstaller freezing, `cwd`, a minimal environment, and `shell: false` are valuable but are **not filesystem or network sandboxes**.

## Common job contract

Electron main remains the authority. A platform launcher, not Node's generic `spawn`, establishes containment before the Python bootloader executes.

For every attempt:

1. Main creates a random, mode-restricted Job Workspace and a manifest containing the exact sidecar/tool/model hashes, Project Range, settings, and expected outputs.
2. Main copies or materializes only the selected canonical audio, reference lyrics if present, and pinned model/dictionary data into that workspace. The canonical originals remain outside the analysis domain.
3. The launcher starts the exact packaged binary without a shell, closes every inherited handle/file descriptor except framed stdin/stdout/stderr, clears proxy, credential, browser, dynamic-loader, Python, and user-session variables, and sets `HOME`, temp, cache, MFA, and model paths inside the workspace.
4. The sidecar and every intended worker/tool are identified by full packaged paths. `PATH` lookup, plugins, user Python packages, system FFmpeg, arbitrary `exec`, and self-update are outside the contract.
5. The offline domain gets no IP-network capability. Local IPC needed for multiprocessing or MFA is workspace-scoped as far as the platform supports it.
6. Cancellation first requests cooperative shutdown. Escalation uses the platform tree primitive where one exists. Late output from a cancelled session is rejected.
7. Main accepts only declared artifact roles under the workspace, verifies size and content hash, parses with bounded schemas, enforces musical/domain invariants, and then creates an Analysis Revision. The workspace is disposable.

Staging input/model copies trades disk and startup time for a much clearer boundary. A compromised analyzer may mutate its own copy, but not the user's source, canonical model store, or Project. This also avoids pretending that all three operating systems can safely convey arbitrary host paths as read-only capabilities to all grandchildren.

## macOS 13+

### What Apple supports

Apple states that directly launched helpers inherit the launching sandbox's capabilities, while **XPC services have their own sandbox** and are the preferred privilege-separation mechanism. A child with sandbox inheritance must be signed with exactly `com.apple.security.app-sandbox` and `com.apple.security.inherit`; inherited rights are static and do not include file access granted dynamically after launch ([App Sandbox inheritance](https://developer.apple.com/library/archive/documentation/Miscellaneous/Reference/EntitlementKeyReference/Chapters/EnablingAppSandbox.html#//apple_ref/doc/uid/TP40011195-CH4-SW26), [XPC services](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingXPCServices.html)). Therefore sandboxing the Electron app and launching Python directly is insufficient: the Electron main process needs network and selected-file access that the analyzer must not inherit.

App Sandbox denies network unless the service carries the relevant client/server entitlement. A sandboxed service has unrestricted read/write access to its own container, and security-scoped bookmarks can extend an XPC service's access to selected files ([network entitlements](https://developer.apple.com/documentation/xcode/configuring-the-macos-app-sandbox), [file access and bookmark transfer](https://developer.apple.com/documentation/security/accessing-files-from-the-macos-app-sandbox), [container access](https://developer.apple.com/documentation/security/protecting-user-data-with-app-sandbox)). However, Apple explicitly notes that direct child inheritance does not include dynamic PowerBox access. An unmodified FFmpeg or Kaldi child cannot be assumed to consume a Foundation security-scoped bookmark.

Apple's public solution is App Sandbox/XPC, not custom Sandbox Profile Language. Apple DTS describes SBPL as undocumented and unsuitable as a product dependency; `sandbox-exec`/`sandbox.h` are deprecated or unsupported ([Apple Developer Forums answer](https://developer.apple.com/forums/thread/661939)). Hardened Runtime protects code integrity and injection classes, but it is not an I/O sandbox ([Hardened Runtime](https://developer.apple.com/documentation/security/hardened-runtime)).

### Recommended macOS shape

- Embed a native analysis XPC service in `Contents/XPCServices`. Electron main reaches it through a minimal signed native bridge/addon; the renderer never does.
- Give the service App Sandbox but no `com.apple.security.network.client` or `.server` entitlement.
- Treat the service's **entire private writable container** as the analysis workspace boundary. It may contain job input copies, temp files, local PostgreSQL/MFA state, and outputs. Do not call a single subdirectory an OS-enforced write allowlist.
- Let the native XPC front end resolve any temporary security-scoped inputs and copy them into its container before starting Python. Do not pass original paths or assume the sandbox extension reaches PyInstaller workers.
- Sign every bundled Mach-O helper executable (Python bootloader, FFmpeg/ffprobe, Kaldi/OpenFst/PostgreSQL tools) for inheritance and verify the actual installed bundle. Apple requires sandbox entitlements on included Mach-O executables and records nested signatures from the inside out ([sandboxed helper checklist](https://developer.apple.com/library/archive/qa/qa1773/_index.html), [nested-code signing](https://developer.apple.com/library/archive/documentation/Security/Conceptual/CodeSigningGuide/Procedures/Procedures.html), [bundle placement](https://developer.apple.com/documentation/bundleresources/placing-content-in-a-bundle)).
- Use Developer ID, Hardened Runtime, secure timestamps, notarization, and stapling. Avoid `disable-library-validation`, unsigned executable memory, and DYLD-environment exceptions unless a measured native dependency proves one indispensable; an exception would require a new security review ([notarization requirements](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)).

### macOS residuals

- The service can write anywhere in its own container, not only the current job directory. Cleanup and one-job-at-a-time are application policy.
- There is no cited public macOS equivalent of a Windows non-breakaway Job Object or a delegated cgroup that gives an ordinary desktop app an aggregate descendant process limit and atomic tree kill. Process groups, parent-death monitoring, worker counts, and per-process `setrlimit` are useful conventions, not a hostile-tree guarantee.
- `launchd` manages the XPC service lifecycle and may kill the service, but Apple's XPC documentation does not promise that killing the service atomically kills every helper it spawned. All allowed helpers must remain sandboxed even if lifecycle cleanup fails.
- App Sandbox allows some system/world-readable resources and the private container. The claim is protection of unrelated/canonical data and network, not a literal view containing only three directories.

## Windows x64

### What Windows supports

AppContainer is a kernel security boundary introduced in Windows 8. Its token has a package SID and capability SIDs; access to protected objects is the intersection of the user and AppContainer grants. Without a network capability it cannot use the network, and DACLs can grant a particular AppContainer read or read/write access to specific objects ([launching an AppContainer](https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer), [AppContainer isolation](https://learn.microsoft.com/en-us/windows/win32/secauthz/appcontainer-isolation), [network capabilities](https://learn.microsoft.com/en-us/windows/apps/develop/networking/networking-basics)).

A Job Object manages processes as a unit. Children join the parent's job by default; if neither breakaway flag is enabled, descendants cannot opt out through normal `CreateProcess`. Jobs support active-process and resource limits, `TerminateJobObject`, and `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` ([Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects), [nested jobs](https://learn.microsoft.com/en-us/windows/win32/procthread/nested-jobs)).

Microsoft now documents `Experimental_CreateProcessInSandbox`, including Bound File System read-only/read-write lists, but its minimum client is Windows 11, its header is not public, its schema is `0.1.0`, and the API is explicitly experimental. It is not a maintainable v1 foundation ([experimental API requirements](https://learn.microsoft.com/en-us/windows/win32/secauthz/createprocessinsandbox)).

### Recommended Windows shape

- Use a small signed native launcher with stable AppContainer APIs (`CreateAppContainerProfile`, `SECURITY_CAPABILITIES`, `STARTUPINFOEX`) and an empty network-capability set.
- Create a fresh AppContainer identity/profile per attempt or bounded session. Its profile directory is the Job Workspace; delete the profile only after the process tree is dead and outputs are accepted/rejected.
- Keep signed application executables and libraries under release-managed installation resources exposed read/execute-only to the AppContainer. Stage media, lyrics, downloaded models, temp, and MFA state into the AppContainer profile instead of editing ACLs on arbitrary user files.
- Create a Job Object before resuming execution; set kill-on-close, no breakaway, an active-process limit, job memory/CPU limits chosen by benchmark, and an I/O completion port for reliable lifecycle/accounting. Verify every worker is in the job.
- Run at low integrity/AppContainer, disable Win32k system calls for the headless tree if the packaged stack passes, close unrelated handles, and pass only the protocol pipes.
- Authenticode-sign and timestamp the launcher, sidecar `.exe`, FFmpeg/Kaldi/PostgreSQL executables, and native DLLs; verify both the release manifest hash and Authenticode chain before launch. SignTool supports executable and DLL signing, but a signature does not itself restrict I/O ([Microsoft Authenticode/SignTool](https://learn.microsoft.com/en-us/windows/win32/dxtecharts/authenticode-signing-for-game-developers)).

### Windows residuals

- AppContainer permits some system resources by design, and classic AppContainer DACLs are not the same ergonomic per-launch path policy as the experimental BFS API.
- An AppContainer/Job Object does not by itself allow only a named set of executables. Clean environment/full paths and package hashing are policy; machine-wide WDAC/AppLocker is outside a consumer app's authority. Every spawned process remains contained, which limits the impact of unexpected execution.
- MFA currently starts a local PostgreSQL server by default. Its socket/pipe, shared-memory, registry, DLL, and process behavior must be proven inside AppContainer; failure is not permission to add Internet/private-network capabilities.

## Linux x64 and arm64

### What the kernel supports

Landlock is an unprivileged, stackable LSM. Filesystem rules are inherited by descendant threads/processes and persist across exec. ABI 3 is the minimum useful baseline here because earlier ABIs cannot deny truncation; Landlock must also be built and enabled by the distribution ([Landlock inheritance, ABI and limitations](https://docs.kernel.org/userspace-api/landlock.html)). Landlock does not cover every metadata operation, already-open file descriptors, or all special filesystems. Network control starts with TCP in ABI 4 and does not cover UDP until ABI 10, so Landlock alone is not a portable v1 network-denial mechanism.

Seccomp filters are inherited through fork/clone and exec when those syscalls are allowed. Unprivileged installation requires `PR_SET_NO_NEW_PRIVS`; kernel documentation warns that seccomp filtering is not by itself a complete sandbox ([seccomp filter](https://docs.kernel.org/userspace-api/seccomp_filter.html), [`no_new_privs`](https://docs.kernel.org/userspace-api/no_new_privs.html)).

Cgroup v2 can enforce hierarchical `pids.max`; `cgroup.kill` kills a cgroup and all descendants while handling concurrent forks. An unprivileged app needs a delegated cgroup subtree, normally via the user service manager; delegation is not guaranteed on every desktop distribution ([cgroup v2 PID controller, kill and delegation](https://docs.kernel.org/admin-guide/cgroup-v2.html)).

Mount/network/PID namespaces can give a stronger filesystem view and network isolation. Bubblewrap is a useful low-level constructor, not a policy, and now depends on unprivileged user namespaces; distributions can disable or mediate those. It cannot be the only supported-path assumption unless the Linux baseline explicitly requires it ([bubblewrap security model](https://github.com/containers/bubblewrap#sandboxing), [namespace privilege requirement](https://man7.org/linux/man-pages/man7/namespaces.7.html)).

### Recommended Linux shape

- Ship a small native launcher for both architectures. It opens and canonicalizes the allowlisted roots, closes unrelated FDs, sets `no_new_privs`, installs Landlock, installs seccomp, then `execve`s the packaged sidecar.
- Require a runtime Landlock ABI probe of at least 3 for the containment claim. Allow read/execute only for exact packaged binaries, packaged read-only resources, the required dynamic loader/libraries/configuration, and read/write only for the Job Workspace. Handle all rights supported by the running ABI; deny execute on general system utility directories where the runtime permits a narrower file allowlist.
- Install a seccomp policy which allows `AF_UNIX` only if the measured multiprocessing/MFA stack needs it and denies creation of all IP/packet/vsock/netlink families. Close all inherited sockets first. Deny `io_uring_setup` unless a reviewed filter covers networking operations reachable through io_uring. Test IPv4, IPv6, TCP, UDP, raw/packet, DNS, and loopback.
- Do not expose `$HOME`, D-Bus, display, SSH/GPG agents, keyrings, browser state, `/run/user`, or host temp paths. If pathname UNIX sockets are required, create them under the workspace. Abstract UNIX socket isolation remains a residual on the minimum ABI.
- When the user manager supplies a delegated cgroup v2 scope, set `pids.max`, memory/CPU limits, place the launcher in it before untrusted code runs, and use `cgroup.kill` for escalation. Without that delegation, label process-count and tree-kill enforcement unavailable; a process group plus parent-death signal is cleanup only.
- A stronger optional backend may use bubblewrap with an empty mount namespace, read-only binds, one writable bind, PID namespace, and private network namespace, but it must fail closed if user namespaces are unavailable and still needs an explicit policy/test suite.

### Linux residuals

- Landlock availability is a kernel/distribution property, not an architecture property. “Linux x64/arm64” is not a security baseline until minimum distributions/kernels and cgroup delegation are declared.
- ABI 3 cannot scope abstract UNIX sockets/signals or deny TCP/UDP via Landlock; seccomp and environment/file isolation carry that part of the contract.
- Without delegated cgroup v2, a compromised process can create extra descendants within ordinary user limits and can escape a process group. Landlock/seccomp still follow descendants, but reliable accounting/termination does not.
- Linux has no uniform end-user code-signing enforcement comparable to notarized Developer ID or Authenticode. Package signatures and an app-owned hash manifest establish provenance; they do not defend against a same-user replacement of a user-writable installation.

## PyInstaller and native-tool implications

Retain the **one-folder** recommendation, but treat the folder as a native software distribution, not a single trusted executable. PyInstaller is not a cross-compiler and does not bundle glibc; build/test per OS and architecture ([PyInstaller manual](https://pyinstaller.org/en/stable/index.html), [Linux compatibility](https://pyinstaller.org/en/stable/usage.html#making-gnu-linux-apps-forward-compatible)).

- Call PyInstaller's `multiprocessing.freeze_support()` before multiprocessing or heavy imports. Its override is required on all platforms so worker/resource-tracker invocations of the frozen executable do not rerun application startup ([PyInstaller multiprocessing guidance](https://pyinstaller.org/en/stable/common-issues-and-pitfalls.html#multi-processing)).
- Worker processes and external tools inherit loader state. PyInstaller documents restoring `LD_LIBRARY_PATH` on Linux, calling `SetDllDirectoryW(NULL)`/sanitizing `PATH` before Windows system programs, and sanitizing `DYLD_LIBRARY_PATH` on macOS. Open Chords should instead execute only packaged full paths with an explicit per-tool environment and test their resolved libraries ([launching external programs](https://pyinstaller.org/en/stable/common-issues-and-pitfalls.html#launching-external-programs-from-the-frozen-application)).
- On macOS, PyInstaller can sign collected binaries using an identity and entitlements, but final Apple signing must verify every executable's actual entitlements and sign nested content before the outer Electron app. PyInstaller automation is not evidence that the XPC/inheritance contract is correct ([PyInstaller macOS options](https://pyinstaller.org/en/stable/usage.html#macos-specific-options)).
- Never let a worker outlive the containment session via `PYINSTALLER_RESET_ENVIRONMENT`, daemon mode, `detached`, `setsid`, Windows breakaway, or a background update process.

Node's `subprocess.kill()` sends a signal to one child and explicitly does not terminate grandchildren on Linux; on Windows its supported signal names result in abrupt termination of that one process. It is not the tree primitive ([Node child-process documentation](https://nodejs.org/api/child_process.html#subprocesskillsignal)). Electron `utilityProcess` is a Node-process facility, not a containment replacement for the frozen Python/native tree ([Electron utility process](https://www.electronjs.org/docs/latest/api/utility-process)).

## FFmpeg, MFA/Kaldi, and yt-dlp

### FFmpeg

Build a separate pinned **analysis FFmpeg** with no network protocols and only the file/pipe protocols and codecs demonstrated by the corpus. FFmpeg enables supported protocols by default, but its build can disable all and selectively re-enable; runtime `protocol_whitelist` adds defense in depth ([FFmpeg protocol configuration](https://ffmpeg.org/ffmpeg-protocols.html#Protocol-Options)). Pass input/output as explicit full paths or inherited descriptors, never user-built protocol strings.

This compile/runtime restriction reduces parser reach but is not the OS network boundary. Record the exact configure string and executable hash, and test the build inside every containment backend.

### MFA/Kaldi

MFA is not one Python wheel: its supported installation pulls Kaldi and related native dependencies from conda-forge. It writes a configurable root/temp directory, can use multiple processes, and currently starts a local PostgreSQL server by default with network listening disabled and a local socket directory ([MFA installation and temporary files](https://montreal-forced-aligner.readthedocs.io/en/latest/installation.html), [MFA server behavior](https://montreal-forced-aligner.readthedocs.io/en/stable/user_guide/server/index.html), [`mfa align` options](https://montreal-forced-aligner.readthedocs.io/en/v3.3.3/user_guide/workflows/alignment.html)).

Therefore:

- set `MFA_ROOT_DIR`, temporary directory, profile, corpus, database/socket, model, and output locations inside the Job Workspace;
- pin `--num_jobs` to the process budget and test both multiprocessing and threading choices;
- download models outside analysis, verify license/hash, then stage the selected model/dictionary;
- include every Kaldi/OpenFst/PostgreSQL executable and library in the signed/hashed manifest;
- treat local socket/shared-memory requirements as explicit containment-policy inputs;
- do not ship MFA on a platform until its packaged stack passes cancel, crash, process-limit, no-network, and cleanup tests.

### yt-dlp

`yt-dlp` is inherently networked and may invoke FFmpeg/ffprobe or another external downloader ([yt-dlp options](https://github.com/yt-dlp/yt-dlp/blob/master/README.md), [FFmpeg postprocessor source](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/postprocessor/ffmpeg.py)). It belongs to a separate **Acquisition Job** authorized by main:

- network enabled only for the explicit YouTube acquisition;
- no browser-cookie or credential access from the analysis domain; authenticated acquisition, if ever added, requires a separate privacy/security decision;
- output restricted to an acquisition workspace;
- pinned yt-dlp and acquisition-FFmpeg paths/hashes;
- temp audio handle closed, hashed, then copied/moved into the offline Analysis Job;
- acquisition process tree terminated before offline analysis begins.

Do not weaken the analysis sandbox to accommodate `yt-dlp`. Acquisition has a different threat and privacy contract and needs its own later containment decision.

## Signing and release assembly

Electron Packager's `extraResource` copies arbitrary files into the real Resources directory; it does not prove that nested tools were correctly signed or sandboxed ([Packager `extraResource`](https://electron.github.io/packager/main/interfaces/Options.html#extraResource)). Release assembly must be inside-out:

1. build and test each native tool on its target OS/architecture;
2. generate an SBOM and immutable manifest of executable/library/model hashes, versions, licenses, and build flags;
3. apply platform entitlements/signatures to every nested executable and library;
4. embed the XPC service/native launcher/sidecar/tools in standard bundle locations;
5. sign the outer Electron app and installer, notarize/staple macOS, timestamp Windows;
6. install on a clean machine, re-enumerate and verify nested content from the installed artifact;
7. run the containment acceptance suite before release.

Models are data, not executable updates. Model download verification must never make the model directory executable or allow it to supply plugins/native libraries.

## Required acceptance suite

Each signed/installed platform artifact must test the real PyInstaller, FFmpeg, MFA/Kaldi/PostgreSQL, and multiprocessing stack—not a toy child only.

### Boundary probes

- read the selected staged input: allowed;
- read the original source, Project library, model store, SSH keys, browser profile, and a sibling workspace: denied;
- write/truncate/rename outside the workspace and mutate installed tools/models: denied;
- write, rename, fsync, and atomically publish inside the workspace: allowed;
- connect/listen over IPv4 and IPv6 TCP/UDP, loopback, DNS, packet/raw/vsock: denied;
- exercise required workspace-local pipe/UNIX-socket/named-pipe IPC: allowed only where declared;
- execute every allowed packaged helper; attempt shell/system executable and plugin discovery; record actual platform behavior;
- exceed worker/process/memory/CPU budgets and verify the precise enforced result;
- cancel while Python, FFmpeg, Kaldi, and PostgreSQL each own descendants; verify all enforceably tracked descendants are gone;
- kill Electron main, launcher, sidecar, and a worker independently; verify orphan behavior and cleanup;
- alter a staged input/model and a returned artifact; verify hash/invariant rejection;
- inspect installed macOS entitlements/signatures/notarization, Windows Authenticode/AppContainer token/job membership, and Linux manifest/Landlock/seccomp/cgroup state.

### Fail-closed probes

Analysis must refuse to start when:

- the launcher, sidecar, tool, or model hash differs from the manifest;
- the macOS XPC/inherit entitlement chain is invalid;
- the Windows process is not in the expected AppContainer and Job Object before untrusted code runs;
- required Linux Landlock/seccomp setup fails, or strict Linux process limits are requested without cgroup delegation;
- any unexpected handle/socket survives inheritance;
- a required tool needs an undeclared path, network capability, executable, entitlement, or sandbox exception.

## Rejected claims and mechanisms

| Claim/mechanism | Decision |
|---|---|
| `spawn(..., shell: false, cwd, env)` is a sandbox | Reject. It prevents a command-shell class of bugs but does not restrict file, network, or descendants. |
| `subprocess.kill()` kills the sidecar tree | Reject. Official Node documentation says grandchildren can survive. |
| macOS `sandbox-exec`/custom SBPL | Reject. The policy language is undocumented for third-party product use. |
| Hardened Runtime/notarization or Authenticode is containment | Reject. These establish code-integrity/distribution properties, not an I/O allowlist. |
| Experimental Windows `CreateProcessInSandbox`/BFS | Revisit after it becomes a supported public API; do not base v1 on it. |
| Bubblewrap works on every Linux desktop | Reject unless unprivileged user namespaces become a declared, tested baseline. |
| Landlock alone denies all network | Reject. TCP/UDP coverage is ABI-dependent and incomplete on the minimum filesystem ABI. |
| Process groups are hostile-tree containment | Reject. They are cleanup; descendants can create a new session/group. |
| Give the offline sidecar network for yt-dlp/model downloads | Reject. Acquisition/downloads are separate capabilities and jobs. |
| Pass original host paths read-only on all platforms | Reject for the common contract. Stage hash-identified copies and protect canonical originals. |

## Residual-risk statement for the product spec

The final specification should state all of the following:

- Containment reduces the impact of parser/analyzer compromise; it does not make native media analysis safe by definition.
- macOS enforcement protects user/canonical data and network through XPC App Sandbox, but its private container is broader than one directory and process-tree quotas/kill are not equivalent to Windows Jobs.
- Windows has the strongest complete tree/resource primitive, subject to AppContainer compatibility of native dependencies.
- Linux containment is conditional on an explicit kernel/distribution baseline. Landlock+seccomp can remain on descendants that escape cleanup, while cgroup delegation determines whether process caps and atomic tree kill are enforceable.
- Signed/hashed code and models, offline execution, staged inputs, untrusted-output validation, and deletion of temporary audio are mandatory even when an OS sandbox is active.

This narrower claim is feasible and testable. The stronger sentence “the sidecar and all subprocesses can only read approved resources, write one directory, never network, create at most N processes, and are always killed as one tree on every supported OS” is **not established for v1** and must not appear in the specification.

## Context7 check

Context7 was available in this task. `resolve-library-id` followed by `query-docs` was used for Electron (`/electron/electron`), PyInstaller (`/websites/pyinstaller_en_stable`), and MFA (`/websites/montreal-forced-aligner_readthedocs_io_en_user_guide`). It confirmed the current official process/resource APIs, PyInstaller multiprocessing/one-folder behavior, and MFA model/temp/job controls. Durable citations above point to the primary project and OS documentation.

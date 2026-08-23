# Main-sidecar lifecycle proof

Issue #50 validates one narrow Electron-main orchestration seam before the analysis stack or its platform launchers exist.

## Decision

Adopt one main-owned Effect `ManagedRuntime` for the future sidecar supervisor. Keep Effect behind the `SidecarClient` interface and out of renderer, preload, IPC DTOs, and domain code. Keep Zod as the framed-wire validator.

The Promise and Effect implementations run the same black-box contract tests. Both implementations:

- accept one `runSession` command and reject concurrent sessions;
- require a versioned, manifest-bound handshake with a per-session nonce;
- enforce monotonic sequence numbers, stable job/request identifiers, and a one-MiB frame limit;
- return only a typed, schema-validated terminal result;
- turn cancellation, timeout, EOF, malformed protocol, and disposal into typed failures;
- send cancellation before releasing the process and ignore output after cancellation; and
- await process cleanup before `runSession` or `dispose` settles.

The Effect version earns its place narrowly: `acquireUseRelease` keeps acquisition and cleanup in one scoped workflow, timeout interrupts the protocol wait, and disposing the client interrupts and drains its active session before disposing the runtime. The Promise comparison reaches the same behavior, but manually coordinates a timeout controller, active-session guard, and `try/finally` cleanup. The public interface and wire types contain no Effect values, so this decision can be reversed without changing callers or persisted data.

## Evidence

`tests/sidecar-session.test.ts` runs the same scenarios against both implementations: fragmented success, manifest/nonce validation, cancellation with a late result, timeout, EOF, disposal, and one-MiB framing. `tests/sidecar-spawn.test.ts` sends the same protocol through real child-process pipes and verifies that the child is reaped.

The cross-process adapter is deliberately named `createUncontainedSpawnLauncherForProof`. It launches an exact executable with an argument array, `shell: false`, a supplied working directory, a supplied environment, and hidden Windows console state. It is not a production or packaged containment adapter, and it must never be presented as one. The production seam remains a fail-closed platform launcher: macOS XPC/App Sandbox, Windows AppContainer plus Job Object, and Linux Landlock/seccomp with cgroup support where promised. Signed installed-artifact containment tests remain release gates owned by the platform-sidecar work.

## Boundaries for the next slice

- Replace the proof launcher with a platform containment adapter; do not silently fall back to ordinary `spawn`.
- Add the frozen sidecar handshake capabilities and model manifest without widening `SidecarClient`.
- Keep large inputs/results in a disposable Job Workspace and exchange only bounded descriptors and hashes.
- Extend cancellation inside the platform adapter to protocol acknowledgement, bounded graceful drain, and platform tree termination. The proof adapter demonstrates child cleanup only; it does not prove hostile descendant cleanup.
- Publish no Analysis Revision until main has independently validated artifact paths, sizes, hashes, schemas, and musical invariants.

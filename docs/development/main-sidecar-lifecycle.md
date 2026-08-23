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
- send cancellation, require its acknowledgement within one second, allow ten seconds for cooperative cleanup, and ignore late terminal output; and
- await process cleanup before `runSession` or `dispose` settles.

The Effect version earns its place narrowly: a real `Layer` supplies the launcher and a scoped session guard to `ManagedRuntime`, while `acquireUseRelease` keeps process acquisition and cleanup in one workflow. Closing the runtime scope finalizes the guard, interrupts any active session, and waits for its process release. The Promise comparison reaches the same behavior, but manually coordinates acquisition, an active-session guard, and `try/finally` cleanup. Both pass the same abort signal into acquisition and use the same explicit timeout signal, so a hanging launch returns a typed timeout and cancellation acknowledgement/cooperative cleanup finish before resource release. The public interface and wire types contain no Effect values, so this decision can be reversed without changing callers or persisted data.

## Evidence

`tests/sidecar-session.test.ts` runs the same scenarios against both implementations: fragmented success, manifest/nonce/sequence validation, bounded remote failure, cancellation acknowledgement and cooperative cleanup, late-result isolation across consecutive sessions, abort during acquisition, delayed-acquisition cleanup, handshake/heartbeat/session timeout, EOF, disposal, and one-MiB framing. `tests/sidecar-spawn.test.ts` sends the same protocol through real child-process pipes and verifies that the child is reaped. `tests/frozen-sidecar.test.ts` runs the manifest-verified PyInstaller executable twice with an empty environment and compares canonical decode manifests. `tests/packaged/security.spec.ts` extracts the Forge artifact and launches Electron in its main-only proof mode. Packaged main starts the same frozen Python executable and project-built FFmpeg shipped in `Resources`, performs a real framed decode, validates the file descriptor, terminates and reaps the sidecar, and only then exits successfully. See [Frozen analysis sidecar and canonical decode](frozen-analysis-sidecar.md).

The observable traces are identical at the module seam:

| Scenario | Promise trace | Effect trace |
| --- | --- | --- |
| Success | `start -> handshake -> result -> stop(completed)` | `start -> handshake -> result -> stop(completed)` |
| Cancel with late result | `start -> cancel -> late result ignored -> cancel_ack -> cleanup_complete -> stop(cancelled)` | `start -> cancel -> late result ignored -> cancel_ack -> cleanup_complete -> stop(cancelled)` |
| Silent timeout | `deadline -> cancel -> bounded ack wait -> stop(timeout)` | `deadline -> cancel -> bounded ack wait -> stop(timeout)` |

Debugging produced two concrete differences. A rejected Promise preserved `SidecarSessionError.code` directly. A raw Effect `runPromise` initially surfaced a `FiberFailure` wrapper, so the boundary now runs `Effect.either` and rethrows the typed error before it reaches callers. An earlier fire-and-forget async-iterator return also could not prove late-output drainage; the protocol inbox now retains those frames, waits for `cancel_ack` and `cleanup_complete`, and only then lets the session guard admit the next run. This makes the trace and cleanup ordering inspectable without exposing Effect internals.

The cross-process adapter is deliberately named `createUncontainedSpawnLauncherForProof`. It launches an exact executable with an argument array, `shell: false`, a supplied working directory, a supplied environment, hidden Windows console state, and the session abort signal. On release it allows five seconds after graceful termination before force termination. The cross-process and packaged proofs establish protocol and lifecycle behavior, not containment. The production seam remains a fail-closed platform launcher: macOS XPC/App Sandbox, Windows AppContainer plus Job Object, and Linux Landlock/seccomp with cgroup support where promised. Signed installed-artifact containment tests remain release gates owned by the platform-sidecar work.

## Boundaries for the next slice

- Replace the proof launcher with a platform containment adapter; do not silently fall back to ordinary `spawn`.
- Extend the frozen handshake with exact analyzer/model capabilities when those artifacts exist, without widening `SidecarClient`.
- Keep every later large input/result in the established disposable Job Workspace and exchange only bounded descriptors and hashes.
- Implement graceful/force termination with the platform tree primitive. Protocol acknowledgement and cooperative cleanup are already bounded above the adapter; the proof adapter demonstrates child cleanup only and does not prove hostile descendant cleanup.
- Publish no Analysis Revision until main has independently validated artifact paths, sizes, hashes, schemas, and musical invariants.

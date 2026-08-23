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

The Effect version earns its place narrowly: `acquireUseRelease` keeps acquisition and cleanup in one scoped workflow, while disposing the client interrupts and drains its active session before disposing the runtime. The Promise comparison reaches the same behavior, but manually coordinates acquisition, an active-session guard, and `try/finally` cleanup. Both use the same explicit timeout signal so cancellation acknowledgement and cooperative cleanup finish before resource release. The public interface and wire types contain no Effect values, so this decision can be reversed without changing callers or persisted data.

## Evidence

`tests/sidecar-session.test.ts` runs the same scenarios against both implementations: fragmented success, manifest/nonce/sequence validation, bounded remote failure, cancellation acknowledgement and cooperative cleanup, late-result isolation across consecutive sessions, handshake/heartbeat/session timeout, EOF, disposal, and one-MiB framing. `tests/sidecar-spawn.test.ts` sends the same protocol through real child-process pipes and verifies that the child is reaped. `tests/packaged/security.spec.ts` inspects the installed ASAR source maps and proves that the lifecycle module is built into Electron main but not preload.

The observable traces are identical at the module seam:

| Scenario | Promise trace | Effect trace |
| --- | --- | --- |
| Success | `start -> handshake -> result -> stop(completed)` | `start -> handshake -> result -> stop(completed)` |
| Cancel with late result | `start -> cancel -> late result ignored -> cancel_ack -> cleanup_complete -> stop(cancelled)` | `start -> cancel -> late result ignored -> cancel_ack -> cleanup_complete -> stop(cancelled)` |
| Silent timeout | `deadline -> cancel -> bounded ack wait -> stop(timeout)` | `deadline -> cancel -> bounded ack wait -> stop(timeout)` |

Debugging produced two concrete differences. A rejected Promise preserved `SidecarSessionError.code` directly. A raw Effect `runPromise` initially surfaced a `FiberFailure` wrapper, so the boundary now runs `Effect.either` and rethrows the typed error before it reaches callers. An earlier fire-and-forget async-iterator return also could not prove late-output drainage; the protocol inbox now retains those frames, waits for `cancel_ack` and `cleanup_complete`, and only then lets the session guard admit the next run. This makes the trace and cleanup ordering inspectable without exposing Effect internals.

The cross-process adapter is deliberately named `createUncontainedSpawnLauncherForProof`. It launches an exact executable with an argument array, `shell: false`, a supplied working directory, a supplied environment, and hidden Windows console state. On release it allows five seconds after graceful termination before force termination. It is not a production containment adapter, and it must never be presented as one. The production seam remains a fail-closed platform launcher: macOS XPC/App Sandbox, Windows AppContainer plus Job Object, and Linux Landlock/seccomp with cgroup support where promised. Signed installed-artifact containment tests remain release gates owned by the platform-sidecar work.

## Boundaries for the next slice

- Replace the proof launcher with a platform containment adapter; do not silently fall back to ordinary `spawn`.
- Add the frozen sidecar handshake capabilities and model manifest without widening `SidecarClient`.
- Keep large inputs/results in a disposable Job Workspace and exchange only bounded descriptors and hashes.
- Implement graceful/force termination with the platform tree primitive. Protocol acknowledgement and cooperative cleanup are already bounded above the adapter; the proof adapter demonstrates child cleanup only and does not prove hostile descendant cleanup.
- Publish no Analysis Revision until main has independently validated artifact paths, sizes, hashes, schemas, and musical invariants.

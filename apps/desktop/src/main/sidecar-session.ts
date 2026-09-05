import { Context, Effect, Either, Layer, ManagedRuntime } from "effect";

import {
  normalizeSidecarError,
  resolveProtocolPolicy,
  runSidecarProtocol,
  SidecarSessionError,
  validateSidecarRequest,
  type SidecarProcess,
  type SidecarProcessLauncher,
  type SidecarProtocolPolicy,
  type SidecarSessionErrorCode,
  type SidecarSessionRequest,
  type SidecarSessionResult,
} from "./sidecar-protocol.ts";

export {
  encodeSidecarFrame,
  parseSidecarSessionRequest,
  parseSidecarSessionResult,
  SidecarSessionError,
  type SidecarProcess,
  type SidecarProcessLauncher,
  type SidecarProtocolPolicy,
  type SidecarSessionErrorCode,
  type SidecarSessionRequest,
  type SidecarSessionRequestInput,
  type SidecarSessionResult,
} from "./sidecar-protocol.ts";
export { createUncontainedSpawnLauncherForProof } from "./sidecar-proof-process.ts";
export {
  createNativeContainmentLauncher,
  type NativeContainmentBroker,
  type NativeContainmentEvidence,
  type NativeContainmentPlatform,
} from "./sidecar-containment-launcher.ts";
export { createLinuxSystemdContainmentBroker } from "./sidecar-linux-systemd-broker.ts";

export interface SidecarClient {
  runSession(request: SidecarSessionRequest): Promise<SidecarSessionResult>;
  dispose(): Promise<void>;
}

type SessionGuard = ReturnType<typeof createSessionGuard>;
const SidecarLauncherService = Context.GenericTag<SidecarProcessLauncher>(
  "open-chords/SidecarLauncher",
);
const SessionGuardService = Context.GenericTag<SessionGuard>("open-chords/SidecarSessionGuard");

function createSessionGuard() {
  let active = false;
  let activeController: AbortController | undefined;
  let activeFinished: Promise<void> | undefined;
  let finishActive: (() => void) | undefined;
  let disposed = false;
  return {
    async dispose(): Promise<void> {
      disposed = true;
      activeController?.abort(
        new SidecarSessionError("disposed", "Sidecar client was disposed during a session"),
      );
      await activeFinished;
    },
    enter(): AbortSignal {
      if (disposed) throw new SidecarSessionError("disposed", "Sidecar client is disposed");
      if (active) {
        throw new SidecarSessionError("busy", "Only one sidecar session may run at a time");
      }
      active = true;
      activeController = new AbortController();
      activeFinished = new Promise<void>((resolve) => {
        finishActive = resolve;
      });
      return activeController.signal;
    },
    leave(): void {
      active = false;
      activeController = undefined;
      finishActive?.();
      finishActive = undefined;
      activeFinished = undefined;
    },
  };
}

export function createPromiseSidecarClient(
  launcher: SidecarProcessLauncher,
  policyOverrides: Partial<SidecarProtocolPolicy> = {},
): SidecarClient {
  const policy = resolveProtocolPolicy(policyOverrides);
  const guard = createSessionGuard();
  return {
    async dispose() {
      await guard.dispose();
    },
    async runSession(request) {
      validateSidecarRequest(request);
      const disposeSignal = guard.enter();
      const timeout = createSessionTimeout(request.timeoutMs);
      let process: SidecarProcess | undefined;
      let stopReason: "completed" | SidecarSessionErrorCode = "completed";
      try {
        process = await acquireSidecarProcess(
          launcher,
          request,
          combineAcquisitionSignals(request.signal, timeout.signal, disposeSignal),
        );
        return await runSidecarProtocol(
          process,
          request,
          AbortSignal.any([timeout.signal, disposeSignal]),
          policy,
        );
      } catch (error) {
        const failure = normalizeSidecarError(error);
        stopReason = failure.code;
        throw failure;
      } finally {
        timeout.clear();
        await releaseProcess(process, stopReason).finally(() => guard.leave());
      }
    },
  };
}

export function createEffectSidecarClient(
  launcher: SidecarProcessLauncher,
  policyOverrides: Partial<SidecarProtocolPolicy> = {},
): SidecarClient {
  const policy = resolveProtocolPolicy(policyOverrides);
  const runtime = ManagedRuntime.make(
    Layer.merge(
      Layer.succeed(SidecarLauncherService, launcher),
      Layer.scoped(
        SessionGuardService,
        Effect.acquireRelease(Effect.sync(createSessionGuard), (guard) =>
          Effect.promise(() => guard.dispose()),
        ),
      ),
    ),
  );
  const guardPromise = runtime.runPromise(SessionGuardService);
  return {
    async dispose() {
      await guardPromise;
      await runtime.dispose();
    },
    async runSession(request) {
      validateSidecarRequest(request);
      const guard = await guardPromise;
      const disposeSignal = guard.enter();
      const timeout = createSessionTimeout(request.timeoutMs);
      let cleanupFailure: SidecarSessionError | undefined;
      let stopReason: "completed" | SidecarSessionErrorCode = "completed";
      const acquire = Effect.flatMap(SidecarLauncherService, (launcherService) =>
        Effect.tryPromise({
          catch: normalizeSidecarError,
          try: (signal) =>
            acquireSidecarProcess(
              launcherService,
              request,
              combineAcquisitionSignals(request.signal, signal, disposeSignal, timeout.signal),
            ),
        }),
      );
      const program = Effect.acquireUseRelease(
        acquire,
        (process) =>
          Effect.tryPromise({
            catch: normalizeSidecarError,
            try: (signal) =>
              runSidecarProtocol(
                process,
                request,
                AbortSignal.any([signal, disposeSignal, timeout.signal]),
                policy,
              ),
          }).pipe(
            Effect.tapError((failure) =>
              Effect.sync(() => {
                stopReason = failure.code;
              }),
            ),
          ),
        (process) =>
          Effect.tryPromise({
            catch: (cause) =>
              new SidecarSessionError("cleanup_failure", "Sidecar cleanup failed", { cause }),
            try: () => process.stop(stopReason),
          }).pipe(
            Effect.catchAll((failure) =>
              Effect.sync(() => {
                cleanupFailure = failure;
              }),
            ),
          ),
      );
      try {
        const result = await runtime.runPromise(Effect.either(program));
        if (cleanupFailure !== undefined) throw cleanupFailure;
        if (Either.isLeft(result)) throw result.left;
        return result.right;
      } finally {
        timeout.clear();
        guard.leave();
      }
    },
  };
}

function createSessionTimeout(timeoutMs: number): {
  clear(): void;
  signal: AbortSignal;
} {
  const controller = new AbortController();
  const handle = setTimeout(
    () => controller.abort(new SidecarSessionError("timeout", "Sidecar session timed out")),
    timeoutMs,
  );
  return { clear: () => clearTimeout(handle), signal: controller.signal };
}

async function releaseProcess(
  process: SidecarProcess | undefined,
  reason: "completed" | SidecarSessionErrorCode,
): Promise<void> {
  if (process === undefined) return;
  try {
    await process.stop(reason);
  } catch (cause) {
    throw new SidecarSessionError("cleanup_failure", "Sidecar cleanup failed", { cause });
  }
}

async function acquireSidecarProcess(
  launcher: SidecarProcessLauncher,
  request: SidecarSessionRequest,
  signal: AbortSignal,
): Promise<SidecarProcess> {
  if (signal.aborted) throw acquisitionAbortError(request, signal);
  let process: SidecarProcess;
  try {
    process = await launcher.launch(request, signal);
  } catch (error) {
    if (error instanceof SidecarSessionError && error.code === "cleanup_failure") throw error;
    if (signal.aborted) throw acquisitionAbortError(request, signal);
    throw error instanceof SidecarSessionError
      ? error
      : new SidecarSessionError("launch_failure", "Sidecar launch failed", { cause: error });
  }
  if (!signal.aborted) return process;

  const reason = signal.reason instanceof SidecarSessionError ? signal.reason.code : "cancelled";
  await releaseProcess(process, reason);
  throw acquisitionAbortError(request, signal);
}

function acquisitionAbortError(
  request: SidecarSessionRequest,
  lifecycleSignal: AbortSignal,
): SidecarSessionError {
  if (request.signal?.aborted === true) {
    return new SidecarSessionError("cancelled", "Sidecar acquisition was cancelled", {
      cause: request.signal.reason,
    });
  }
  return lifecycleSignal.reason instanceof SidecarSessionError
    ? lifecycleSignal.reason
    : new SidecarSessionError("cancelled", "Sidecar acquisition was interrupted", {
        cause: lifecycleSignal.reason,
      });
}

function combineAcquisitionSignals(
  requestSignal: AbortSignal | undefined,
  ...lifecycleSignals: readonly AbortSignal[]
): AbortSignal {
  return AbortSignal.any(
    requestSignal === undefined ? [...lifecycleSignals] : [...lifecycleSignals, requestSignal],
  );
}

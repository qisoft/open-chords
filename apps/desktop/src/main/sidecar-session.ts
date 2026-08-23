import { Effect, Either, Layer, ManagedRuntime } from "effect";

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
  SidecarSessionError,
  type SidecarProcess,
  type SidecarProcessLauncher,
  type SidecarProtocolPolicy,
  type SidecarSessionErrorCode,
  type SidecarSessionRequest,
  type SidecarSessionResult,
} from "./sidecar-protocol.ts";
export { createUncontainedSpawnLauncherForProof } from "./sidecar-proof-process.ts";

export const MAIN_SIDECAR_PACKAGED_SEAM = "open-chords/main-sidecar-lifecycle/v1";

export interface SidecarClient {
  runSession(request: SidecarSessionRequest): Promise<SidecarSessionResult>;
  dispose(): Promise<void>;
}

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
        try {
          process = await launcher.launch(request);
        } catch (cause) {
          throw new SidecarSessionError("launch_failure", "Sidecar launch failed", { cause });
        }
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
  const runtime = ManagedRuntime.make(Layer.empty);
  const guard = createSessionGuard();
  return {
    async dispose() {
      await guard.dispose();
      await runtime.dispose();
    },
    async runSession(request) {
      validateSidecarRequest(request);
      const disposeSignal = guard.enter();
      const timeout = createSessionTimeout(request.timeoutMs);
      let cleanupFailure: SidecarSessionError | undefined;
      let stopReason: "completed" | SidecarSessionErrorCode = "completed";
      const acquire = Effect.tryPromise({
        catch: (cause) =>
          new SidecarSessionError("launch_failure", "Sidecar launch failed", { cause }),
        try: () => launcher.launch(request),
      });
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

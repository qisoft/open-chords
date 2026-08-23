import { SidecarSessionError } from "./sidecar-protocol.ts";

export interface UtilityProcessHandle {
  readonly pid: number | undefined;
  kill(): boolean;
  once(event: "exit", listener: (code: number) => void): this;
  once(event: "spawn", listener: () => void): this;
}

export function observeUtilityExit(child: UtilityProcessHandle): Promise<number> {
  return new Promise((resolve) => child.once("exit", resolve));
}

export async function waitForUtilitySpawn(
  child: UtilityProcessHandle,
  exited: Promise<number>,
  signal: AbortSignal,
  reapTimeoutMs = 5_000,
): Promise<void> {
  let terminateOnSpawn = signal.aborted;
  let abortDeadlineAt: number | undefined;
  let abortTimer: ReturnType<typeof setTimeout> | undefined;
  let expireAbort!: () => void;
  const abortDeadline = new Promise<{ type: "abort_timeout" }>((resolve) => {
    expireAbort = () => resolve({ type: "abort_timeout" });
  });
  const abort = () => {
    terminateOnSpawn = true;
    if (child.pid !== undefined) child.kill();
    if (abortDeadlineAt === undefined) {
      abortDeadlineAt = Date.now() + reapTimeoutMs;
      abortTimer = setTimeout(expireAbort, reapTimeoutMs);
    }
  };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const outcome = await Promise.race([
    new Promise<{ type: "spawned" }>((resolve) => {
      child.once("spawn", () => {
        if (terminateOnSpawn) child.kill();
        resolve({ type: "spawned" });
      });
    }),
    exited.then((code) => ({ code, type: "exited" }) as const),
    abortDeadline,
  ]).finally(() => signal.removeEventListener("abort", abort));

  if (abortTimer !== undefined) clearTimeout(abortTimer);
  if (outcome.type === "abort_timeout") {
    throw new SidecarSessionError(
      "cleanup_failure",
      "Packaged sidecar utility process did not spawn or exit after cancellation",
    );
  }

  if (signal.aborted) {
    if (outcome.type === "spawned" && child.pid !== undefined) child.kill();
    await waitForUtilityReap(
      exited,
      Math.max(1, (abortDeadlineAt ?? Date.now() + reapTimeoutMs) - Date.now()),
    );
    throw signal.reason;
  }
  if (outcome.type === "exited") {
    throw new SidecarSessionError(
      "launch_failure",
      `Packaged sidecar utility process exited during launch with code ${String(outcome.code)}`,
    );
  }
}

export async function waitForUtilityReap(
  exited: Promise<number>,
  timeoutMs = 5_000,
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout>;
  const result = await Promise.race([
    exited.then(() => true as const),
    new Promise<false>((resolve) => {
      timeout = setTimeout(() => resolve(false), timeoutMs);
    }),
  ]);
  clearTimeout(timeout!);
  if (!result) {
    throw new SidecarSessionError(
      "cleanup_failure",
      "Packaged sidecar utility process was not reaped",
    );
  }
}

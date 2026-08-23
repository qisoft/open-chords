import { spawn } from "node:child_process";
import { once } from "node:events";

import { Effect, Either, Layer, ManagedRuntime } from "effect";
import { z } from "zod";

const MAX_FRAME_BYTES = 1024 * 1024;
const PROTOCOL_VERSION = 1;

const HashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const RelativeArtifactPathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (path) =>
      !path.startsWith("/") &&
      !path.startsWith("\\") &&
      !/^[a-z]:/iu.test(path) &&
      !path.split(/[\\/]/u).includes(".."),
    "Artifact path must remain relative to the job workspace",
  );
const HandshakeSchema = z.object({
  capabilities: z.array(z.string()).max(32),
  manifestHash: HashSchema,
  nonce: z.string().min(1).max(256),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  sequence: z.literal(0),
  type: z.literal("handshake"),
});
const HeartbeatSchema = z.object({
  nonce: z.string().min(1).max(256),
  sequence: z.number().int().positive(),
  type: z.literal("heartbeat"),
});
const ResultSchema = z.object({
  artifact: z.object({
    byteSize: z.number().int().nonnegative(),
    path: RelativeArtifactPathSchema,
    sha256: HashSchema,
  }),
  jobId: z.string().min(1).max(256),
  nonce: z.string().min(1).max(256),
  requestId: z.string().min(1).max(256),
  sequence: z.number().int().positive(),
  type: z.literal("result"),
});
const ErrorSchema = z.object({
  code: z.string().min(1).max(64),
  jobId: z.string().min(1).max(256),
  message: z.string().min(1).max(2048),
  nonce: z.string().min(1).max(256),
  requestId: z.string().min(1).max(256),
  sequence: z.number().int().positive(),
  type: z.literal("error"),
});
const SidecarMessageSchema = z.discriminatedUnion("type", [
  HandshakeSchema,
  HeartbeatSchema,
  ResultSchema,
  ErrorSchema,
]);

export type SidecarSessionRequest = {
  jobId: string;
  manifestHash: string;
  nonce: string;
  requestId: string;
  signal?: AbortSignal;
  timeoutMs: number;
};

export type SidecarSessionResult = {
  artifact: { byteSize: number; path: string; sha256: string };
  jobId: string;
  requestId: string;
};

export interface SidecarProcess {
  readonly stdout: AsyncIterable<Uint8Array>;
  write(frame: Uint8Array): Promise<void>;
  stop(reason: string): Promise<void>;
}

export interface SidecarProcessLauncher {
  launch(request: SidecarSessionRequest): Promise<SidecarProcess>;
}

export interface SidecarClient {
  runSession(request: SidecarSessionRequest): Promise<SidecarSessionResult>;
  dispose(): Promise<void>;
}

export type SidecarProtocolPolicy = {
  handshakeTimeoutMs: number;
  heartbeatTimeoutMs: number;
};

const DEFAULT_PROTOCOL_POLICY: SidecarProtocolPolicy = {
  handshakeTimeoutMs: 10_000,
  heartbeatTimeoutMs: 20_000,
};

type ProofSpawnOptions = {
  args: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
  executablePath: string;
  onSpawn?: (pid: number) => void;
};

export class SidecarSessionError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
  }
}

class FrameDecoder {
  #buffer = Buffer.alloc(0);

  push(chunk: Uint8Array): unknown[] {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    const messages: unknown[] = [];
    while (this.#buffer.byteLength >= 4) {
      const length = this.#buffer.readUInt32BE(0);
      if (length > MAX_FRAME_BYTES) {
        throw new SidecarSessionError("frame_too_large", "Sidecar frame exceeds one MiB");
      }
      if (this.#buffer.byteLength < length + 4) break;
      const payload = this.#buffer.subarray(4, length + 4);
      this.#buffer = this.#buffer.subarray(length + 4);
      try {
        messages.push(JSON.parse(payload.toString("utf8")));
      } catch (cause) {
        throw new SidecarSessionError("protocol_violation", "Sidecar emitted invalid JSON", {
          cause,
        });
      }
    }
    return messages;
  }

  finish(): void {
    if (this.#buffer.byteLength !== 0) {
      throw new SidecarSessionError("protocol_violation", "Sidecar closed with a partial frame");
    }
  }
}

export function encodeSidecarFrame(message: unknown): Uint8Array {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  if (payload.byteLength > MAX_FRAME_BYTES) {
    throw new SidecarSessionError("frame_too_large", "Sidecar frame exceeds one MiB");
  }
  const frame = Buffer.allocUnsafe(payload.byteLength + 4);
  frame.writeUInt32BE(payload.byteLength, 0);
  payload.copy(frame, 4);
  return frame;
}

/**
 * Cross-process protocol proof only. This is intentionally not the production
 * launcher: ordinary spawn cannot provide the platform containment contract.
 */
export function createUncontainedSpawnLauncherForProof(
  options: ProofSpawnOptions,
): SidecarProcessLauncher {
  return {
    async launch() {
      const child = spawn(options.executablePath, [...options.args], {
        cwd: options.cwd,
        env: { ...options.env },
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      await Promise.race([
        once(child, "spawn"),
        once(child, "error").then(([error]) => Promise.reject(error)),
      ]);
      if (child.pid === undefined || child.stdout === null || child.stdin === null) {
        throw new SidecarSessionError("launch_failure", "Sidecar process pipes were unavailable");
      }
      options.onSpawn?.(child.pid);
      let stopped = false;
      return {
        stdout: child.stdout,
        async stop() {
          if (stopped) return;
          stopped = true;
          if (child.exitCode !== null || child.signalCode !== null) return;
          child.kill("SIGTERM");
          if (await waitForExit(child, 5_000)) return;
          child.kill("SIGKILL");
          if (!(await waitForExit(child, 5_000))) {
            throw new SidecarSessionError("cleanup_failure", "Sidecar process did not terminate");
          }
        },
        async write(frame) {
          if (child.stdin.write(frame)) return;
          await once(child.stdin, "drain");
        },
      };
    },
  };
}

async function waitForExit(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  let timeout: ReturnType<typeof setTimeout>;
  const timedOut = new Promise<false>((resolve) => {
    timeout = setTimeout(() => resolve(false), timeoutMs);
  });
  const exited = once(child, "exit").then(() => true as const);
  const result = await Promise.race([exited, timedOut]);
  clearTimeout(timeout!);
  return result;
}

function normalizeError(error: unknown): SidecarSessionError {
  if (error instanceof SidecarSessionError) return error;
  return new SidecarSessionError("process_failure", "Sidecar session failed", { cause: error });
}

function validateRequest(request: SidecarSessionRequest): void {
  if (!HashSchema.safeParse(request.manifestHash).success) {
    throw new SidecarSessionError("invalid_request", "Manifest hash must be SHA-256 hex");
  }
  if (!Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0) {
    throw new SidecarSessionError("invalid_request", "Timeout must be positive");
  }
}

async function nextOrAbort<T>(
  iterator: AsyncIterator<T>,
  signals: readonly AbortSignal[],
): Promise<IteratorResult<T>> {
  const aborted = signals.find((signal) => signal.aborted);
  if (aborted !== undefined) throw aborted.reason;
  return new Promise((resolve, reject) => {
    const listeners = new Map<AbortSignal, () => void>();
    const settle = (action: () => void) => {
      for (const [signal, listener] of listeners) signal.removeEventListener("abort", listener);
      action();
    };
    for (const signal of signals) {
      const listener = () => settle(() => reject(signal.reason));
      listeners.set(signal, listener);
      signal.addEventListener("abort", listener, { once: true });
    }
    void iterator.next().then(
      (value) => settle(() => resolve(value)),
      (error: unknown) => settle(() => reject(error)),
    );
  });
}

async function nextWithDeadline<T>(
  iterator: AsyncIterator<T>,
  signals: readonly AbortSignal[],
  deadlineAt: number,
  code: "handshake_timeout" | "heartbeat_timeout",
): Promise<IteratorResult<T>> {
  const deadline = new AbortController();
  const timeout = setTimeout(
    () => deadline.abort(new SidecarSessionError(code, `Sidecar ${code.replace("_", " ")}`)),
    Math.max(0, deadlineAt - Date.now()),
  );
  try {
    return await nextOrAbort(iterator, [...signals, deadline.signal]);
  } finally {
    clearTimeout(timeout);
  }
}

async function runProtocol(
  process: SidecarProcess,
  request: SidecarSessionRequest,
  lifecycleSignal: AbortSignal,
  policy: SidecarProtocolPolicy,
): Promise<SidecarSessionResult> {
  const decoder = new FrameDecoder();
  const iterator = process.stdout[Symbol.asyncIterator]();
  const signals =
    request.signal === undefined ? [lifecycleSignal] : [lifecycleSignal, request.signal];
  let handshakeAccepted = false;
  let messageDeadlineAt = Date.now() + policy.handshakeTimeoutMs;
  let expectedSequence = 0;
  await process.write(
    encodeSidecarFrame({
      jobId: request.jobId,
      manifestHash: request.manifestHash,
      nonce: request.nonce,
      requestId: request.requestId,
      sequence: 0,
      type: "start",
    }),
  );

  try {
    while (true) {
      const chunk = await nextWithDeadline(
        iterator,
        signals,
        messageDeadlineAt,
        handshakeAccepted ? "heartbeat_timeout" : "handshake_timeout",
      );
      if (chunk.done) {
        decoder.finish();
        throw new SidecarSessionError("unexpected_eof", "Sidecar exited before a result");
      }
      for (const rawMessage of decoder.push(chunk.value)) {
        const parsed = SidecarMessageSchema.safeParse(rawMessage);
        if (!parsed.success) {
          throw new SidecarSessionError(
            "protocol_violation",
            "Sidecar message failed schema validation",
            {
              cause: parsed.error,
            },
          );
        }
        const message = parsed.data;
        if (!handshakeAccepted) {
          if (message.type !== "handshake") {
            throw new SidecarSessionError(
              "protocol_violation",
              "Handshake must be the first message",
            );
          }
          if (
            message.nonce !== request.nonce ||
            message.manifestHash !== request.manifestHash ||
            !message.capabilities.includes("analysis")
          ) {
            throw new SidecarSessionError(
              "protocol_violation",
              "Sidecar handshake did not match the session",
            );
          }
          handshakeAccepted = true;
          expectedSequence = 1;
          messageDeadlineAt = Date.now() + policy.heartbeatTimeoutMs;
          continue;
        }
        if (message.type === "handshake" || message.nonce !== request.nonce) {
          throw new SidecarSessionError("protocol_violation", "Sidecar session identity changed");
        }
        if (message.sequence !== expectedSequence) {
          throw new SidecarSessionError("protocol_violation", "Sidecar sequence was not monotonic");
        }
        expectedSequence += 1;
        messageDeadlineAt = Date.now() + policy.heartbeatTimeoutMs;
        if (message.type === "result" || message.type === "error") {
          if (message.jobId !== request.jobId || message.requestId !== request.requestId) {
            throw new SidecarSessionError(
              "protocol_violation",
              "Sidecar result identifiers did not match",
            );
          }
          if (message.type === "error") {
            throw new SidecarSessionError(
              "remote_failure",
              `Sidecar ${message.code}: ${message.message}`,
            );
          }
          return { artifact: message.artifact, jobId: message.jobId, requestId: message.requestId };
        }
      }
    }
  } catch (error) {
    const failure = normalizeError(error);
    if (request.signal?.aborted === true) {
      await sendCancel(process, request, expectedSequence);
      throw new SidecarSessionError("cancelled", "Sidecar session was cancelled", { cause: error });
    }
    if (failure.code === "handshake_timeout" || failure.code === "heartbeat_timeout") {
      await sendCancel(process, request, expectedSequence);
      throw failure;
    }
    if (lifecycleSignal.aborted) {
      await sendCancel(process, request, expectedSequence);
      if (lifecycleSignal.reason instanceof SidecarSessionError) {
        throw lifecycleSignal.reason;
      }
      throw new SidecarSessionError("timeout", "Sidecar session timed out", { cause: error });
    }
    throw failure;
  } finally {
    void iterator.return?.();
  }
}

async function sendCancel(
  process: SidecarProcess,
  request: SidecarSessionRequest,
  sequence: number,
): Promise<void> {
  try {
    await process.write(
      encodeSidecarFrame({
        jobId: request.jobId,
        nonce: request.nonce,
        requestId: request.requestId,
        sequence,
        type: "cancel",
      }),
    );
  } catch {
    // Cleanup still owns termination when the protocol pipe is already closed.
  }
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
      if (active)
        throw new SidecarSessionError("busy", "Only one sidecar session may run at a time");
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
  policy: SidecarProtocolPolicy = DEFAULT_PROTOCOL_POLICY,
): SidecarClient {
  const guard = createSessionGuard();
  return {
    async dispose() {
      await guard.dispose();
    },
    async runSession(request) {
      validateRequest(request);
      const disposeSignal = guard.enter();
      const timeout = new AbortController();
      const timeoutHandle = setTimeout(
        () => timeout.abort(new SidecarSessionError("timeout", "Sidecar session timed out")),
        request.timeoutMs,
      );
      let process: SidecarProcess | undefined;
      let stopReason = "completed";
      try {
        try {
          process = await launcher.launch(request);
        } catch (cause) {
          throw new SidecarSessionError("launch_failure", "Sidecar launch failed", { cause });
        }
        return await runProtocol(
          process,
          request,
          AbortSignal.any([timeout.signal, disposeSignal]),
          policy,
        );
      } catch (error) {
        const failure = normalizeError(error);
        stopReason = failure.code;
        throw failure;
      } finally {
        clearTimeout(timeoutHandle);
        await (
          process === undefined
            ? Promise.resolve()
            : process.stop(stopReason).catch((cause: unknown) => {
                throw new SidecarSessionError("cleanup_failure", "Sidecar cleanup failed", {
                  cause,
                });
              })
        ).finally(() => guard.leave());
      }
    },
  };
}

export function createEffectSidecarClient(
  launcher: SidecarProcessLauncher,
  policy: SidecarProtocolPolicy = DEFAULT_PROTOCOL_POLICY,
): SidecarClient {
  const runtime = ManagedRuntime.make(Layer.empty);
  const guard = createSessionGuard();
  return {
    async dispose() {
      await guard.dispose();
      await runtime.dispose();
    },
    async runSession(request) {
      validateRequest(request);
      const disposeSignal = guard.enter();
      let cleanupFailure: SidecarSessionError | undefined;
      let stopReason = "completed";
      const acquire = Effect.tryPromise({
        catch: (cause) =>
          new SidecarSessionError("launch_failure", "Sidecar launch failed", { cause }),
        try: () => launcher.launch(request),
      });
      const program = Effect.acquireUseRelease(
        acquire,
        (process) =>
          Effect.tryPromise({
            catch: normalizeError,
            try: (signal) =>
              runProtocol(process, request, AbortSignal.any([signal, disposeSignal]), policy),
          }).pipe(
            Effect.timeoutFail({
              duration: request.timeoutMs,
              onTimeout: () => new SidecarSessionError("timeout", "Sidecar session timed out"),
            }),
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
        guard.leave();
      }
    },
  };
}

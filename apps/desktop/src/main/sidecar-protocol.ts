import { z } from "zod";

const MAX_FRAME_BYTES = 1024 * 1024;
const PROTOCOL_VERSION = 1;

const Sha256Schema = z
  .string()
  .regex(/^[a-f0-9]{64}$/u)
  .brand<"Sha256">();
const JobIdSchema = z.string().min(1).max(256).brand<"SidecarJobId">();
const NonceSchema = z.string().min(1).max(256).brand<"SidecarNonce">();
const RequestIdSchema = z.string().min(1).max(256).brand<"SidecarRequestId">();
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
  )
  .brand<"JobWorkspaceRelativePath">();
const HandshakeSchema = z.object({
  capabilities: z.array(z.string()).max(32),
  manifestHash: Sha256Schema,
  nonce: NonceSchema,
  protocolVersion: z.literal(PROTOCOL_VERSION),
  sequence: z.literal(0),
  type: z.literal("handshake"),
});
const HeartbeatSchema = z.object({
  nonce: NonceSchema,
  sequence: z.number().int().positive(),
  type: z.literal("heartbeat"),
});
const SessionMessageBaseSchema = z
  .object({
    jobId: JobIdSchema,
    nonce: NonceSchema,
    requestId: RequestIdSchema,
    sequence: z.number().int().positive(),
  })
  .strict();
const ResultSchema = SessionMessageBaseSchema.extend({
  artifact: z.object({
    byteSize: z.number().int().nonnegative(),
    path: RelativeArtifactPathSchema,
    sha256: Sha256Schema,
  }),
  type: z.literal("result"),
});
const ErrorSchema = SessionMessageBaseSchema.extend({
  code: z.string().min(1).max(64),
  message: z.string().min(1).max(2048),
  type: z.literal("error"),
});
const CancelAckSchema = SessionMessageBaseSchema.extend({
  type: z.literal("cancel_ack"),
});
const CleanupCompleteSchema = SessionMessageBaseSchema.extend({
  type: z.literal("cleanup_complete"),
});
const SidecarMessageSchema = z.discriminatedUnion("type", [
  HandshakeSchema,
  HeartbeatSchema,
  ResultSchema,
  ErrorSchema,
  CancelAckSchema,
  CleanupCompleteSchema,
]);
type SidecarMessage = z.infer<typeof SidecarMessageSchema>;

export type SidecarSessionErrorCode =
  | "busy"
  | "cancelled"
  | "cleanup_failure"
  | "disposed"
  | "frame_too_large"
  | "handshake_timeout"
  | "heartbeat_timeout"
  | "invalid_request"
  | "launch_failure"
  | "process_failure"
  | "protocol_violation"
  | "remote_failure"
  | "timeout"
  | "unexpected_eof";

const SidecarSessionRequestSchema = z.object({
  jobId: JobIdSchema,
  manifestHash: Sha256Schema,
  nonce: NonceSchema,
  requestId: RequestIdSchema,
  signal: z.instanceof(AbortSignal).optional(),
  timeoutMs: z.number().positive().finite(),
});

export type SidecarSessionRequestInput = z.input<typeof SidecarSessionRequestSchema>;
export type SidecarSessionRequest = z.output<typeof SidecarSessionRequestSchema>;

type SidecarSessionIdentity = Pick<SidecarSessionRequest, "jobId" | "nonce" | "requestId">;

export type SidecarSessionResult = Pick<
  z.output<typeof ResultSchema>,
  "artifact" | "jobId" | "requestId"
>;

export interface SidecarProcess {
  readonly stdout: AsyncIterable<Uint8Array>;
  write(frame: Uint8Array): Promise<void>;
  stop(reason: "completed" | SidecarSessionErrorCode): Promise<void>;
}

export interface SidecarProcessLauncher {
  launch(request: SidecarSessionRequest, signal: AbortSignal): Promise<SidecarProcess>;
}

export type SidecarProtocolPolicy = {
  cancelAckTimeoutMs: number;
  cooperativeCleanupTimeoutMs: number;
  handshakeTimeoutMs: number;
  heartbeatTimeoutMs: number;
};

const DEFAULT_PROTOCOL_POLICY: SidecarProtocolPolicy = {
  cancelAckTimeoutMs: 1_000,
  cooperativeCleanupTimeoutMs: 10_000,
  handshakeTimeoutMs: 10_000,
  heartbeatTimeoutMs: 20_000,
};

export class SidecarSessionError extends Error {
  readonly code: SidecarSessionErrorCode;

  constructor(code: SidecarSessionErrorCode, message: string, options?: ErrorOptions) {
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

class OutputInbox {
  #ended = false;
  #failure: SidecarSessionError | undefined;
  readonly #messages: unknown[] = [];
  readonly #waiters = new Set<() => void>();

  constructor(stdout: AsyncIterable<Uint8Array>) {
    void this.#pump(stdout);
  }

  async next(
    deadlineAt: number,
    timeoutCode: SidecarSessionErrorCode,
    signals: readonly AbortSignal[] = [],
  ): Promise<unknown> {
    while (true) {
      const aborted = signals.find((signal) => signal.aborted);
      if (aborted !== undefined) throw aborted.reason;
      const message = this.#messages.shift();
      if (message !== undefined) return message;
      if (this.#failure !== undefined) throw this.#failure;
      if (this.#ended) {
        throw new SidecarSessionError("unexpected_eof", "Sidecar exited before a result");
      }
      await new Promise<void>((resolve, reject) => {
        const listeners = new Map<AbortSignal, () => void>();
        const cleanup = () => {
          clearTimeout(timeout);
          this.#waiters.delete(wake);
          for (const [signal, listener] of listeners) {
            signal.removeEventListener("abort", listener);
          }
        };
        const wake = () => {
          cleanup();
          resolve();
        };
        const timeout = setTimeout(
          () => {
            cleanup();
            reject(
              new SidecarSessionError(timeoutCode, `Sidecar ${timeoutCode.replaceAll("_", " ")}`),
            );
          },
          Math.max(0, deadlineAt - Date.now()),
        );
        this.#waiters.add(wake);
        for (const signal of signals) {
          const listener = () => {
            cleanup();
            reject(signal.reason);
          };
          listeners.set(signal, listener);
          signal.addEventListener("abort", listener, { once: true });
        }
      });
    }
  }

  async #pump(stdout: AsyncIterable<Uint8Array>): Promise<void> {
    try {
      for await (const message of decodeSidecarFrames(stdout)) {
        this.#messages.push(message);
        this.#notify();
      }
    } catch (error) {
      this.#failure = normalizeSidecarError(error);
    } finally {
      this.#ended = true;
      this.#notify();
    }
  }

  #notify(): void {
    for (const wake of [...this.#waiters]) wake();
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

export async function* decodeSidecarFrames(input: AsyncIterable<Uint8Array>): AsyncGenerator {
  const decoder = new FrameDecoder();
  for await (const chunk of input) {
    yield* decoder.push(chunk);
  }
  decoder.finish();
}

export function normalizeSidecarError(error: unknown): SidecarSessionError {
  if (error instanceof SidecarSessionError) return error;
  return new SidecarSessionError("process_failure", "Sidecar session failed", { cause: error });
}

export function validateSidecarRequest(request: SidecarSessionRequest): void {
  const parsed = SidecarSessionRequestSchema.safeParse(request);
  if (!parsed.success) throw new SidecarSessionError("invalid_request", "Invalid sidecar request");
}

export function parseSidecarSessionRequest(
  input: SidecarSessionRequestInput,
): SidecarSessionRequest {
  const parsed = SidecarSessionRequestSchema.safeParse(input);
  if (!parsed.success) {
    throw new SidecarSessionError("invalid_request", "Invalid sidecar request", {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

export function resolveProtocolPolicy(
  overrides: Partial<SidecarProtocolPolicy>,
): SidecarProtocolPolicy {
  const policy = { ...DEFAULT_PROTOCOL_POLICY, ...overrides };
  if (Object.values(policy).some((duration) => !Number.isFinite(duration) || duration <= 0)) {
    throw new SidecarSessionError("invalid_request", "Protocol deadlines must be positive");
  }
  return policy;
}

export async function runSidecarProtocol(
  process: SidecarProcess,
  request: SidecarSessionRequest,
  lifecycleSignal: AbortSignal,
  policy: SidecarProtocolPolicy,
): Promise<SidecarSessionResult> {
  const inbox = new OutputInbox(process.stdout);
  const signals =
    request.signal === undefined ? [lifecycleSignal] : [lifecycleSignal, request.signal];
  let handshakeAccepted = false;
  let messageDeadlineAt = Date.now() + policy.handshakeTimeoutMs;
  let expectedSequence = 0;
  await process.write(
    encodeSidecarFrame({
      ...sessionIdentity(request),
      manifestHash: request.manifestHash,
      sequence: 0,
      type: "start",
    }),
  );

  try {
    while (true) {
      const rawMessage = await inbox.next(
        messageDeadlineAt,
        handshakeAccepted ? "heartbeat_timeout" : "handshake_timeout",
        signals,
      );
      const message = parseSidecarMessage(rawMessage);
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
      validateSessionMessage(message, request, expectedSequence);
      expectedSequence += 1;
      messageDeadlineAt = Date.now() + policy.heartbeatTimeoutMs;
      if (message.type === "cancel_ack" || message.type === "cleanup_complete") {
        throw new SidecarSessionError(
          "protocol_violation",
          "Sidecar emitted cancellation control during an active session",
        );
      }
      if (message.type === "error") {
        throw new SidecarSessionError(
          "remote_failure",
          `Sidecar ${message.code}: ${message.message}`,
        );
      }
      if (message.type === "result") {
        return { artifact: message.artifact, jobId: message.jobId, requestId: message.requestId };
      }
    }
  } catch (error) {
    const failure = normalizeSidecarError(error);
    let terminalFailure = failure;
    if (request.signal?.aborted === true) {
      terminalFailure = new SidecarSessionError("cancelled", "Sidecar session was cancelled", {
        cause: error,
      });
    } else if (lifecycleSignal.aborted) {
      terminalFailure =
        lifecycleSignal.reason instanceof SidecarSessionError
          ? lifecycleSignal.reason
          : new SidecarSessionError("timeout", "Sidecar session timed out", { cause: error });
    }
    if (
      terminalFailure.code === "cancelled" ||
      terminalFailure.code === "disposed" ||
      terminalFailure.code === "handshake_timeout" ||
      terminalFailure.code === "heartbeat_timeout" ||
      terminalFailure.code === "timeout"
    ) {
      await requestCooperativeCancellation(inbox, process, request, expectedSequence, policy).catch(
        () => undefined,
      );
    }
    throw terminalFailure;
  }
}

function parseSidecarMessage(rawMessage: unknown): SidecarMessage {
  const parsed = SidecarMessageSchema.safeParse(rawMessage);
  if (!parsed.success) {
    throw new SidecarSessionError(
      "protocol_violation",
      "Sidecar message failed schema validation",
      { cause: parsed.error },
    );
  }
  return parsed.data;
}

function validateSessionMessage(
  message: SidecarMessage,
  request: SidecarSessionRequest,
  expectedSequence: number,
): void {
  if (message.type === "handshake" || message.nonce !== request.nonce) {
    throw new SidecarSessionError("protocol_violation", "Sidecar session identity changed");
  }
  if (message.sequence !== expectedSequence) {
    throw new SidecarSessionError("protocol_violation", "Sidecar sequence was not monotonic");
  }
  if (
    "jobId" in message &&
    (message.jobId !== request.jobId || message.requestId !== request.requestId)
  ) {
    throw new SidecarSessionError(
      "protocol_violation",
      "Sidecar message identifiers did not match",
    );
  }
}

function sessionIdentity(request: SidecarSessionRequest): SidecarSessionIdentity {
  return {
    jobId: request.jobId,
    nonce: request.nonce,
    requestId: request.requestId,
  };
}

async function requestCooperativeCancellation(
  inbox: OutputInbox,
  process: SidecarProcess,
  request: SidecarSessionRequest,
  firstSequence: number,
  policy: SidecarProtocolPolicy,
): Promise<void> {
  await sendCancel(process, request, firstSequence);
  let expectedSequence = firstSequence;
  const ackDeadline = Date.now() + policy.cancelAckTimeoutMs;
  while (true) {
    const message = parseSidecarMessage(await inbox.next(ackDeadline, "timeout"));
    validateSessionMessage(message, request, expectedSequence);
    expectedSequence += 1;
    if (message.type === "cancel_ack") break;
  }
  const cleanupDeadline = Date.now() + policy.cooperativeCleanupTimeoutMs;
  while (true) {
    const message = parseSidecarMessage(await inbox.next(cleanupDeadline, "timeout"));
    validateSessionMessage(message, request, expectedSequence);
    expectedSequence += 1;
    if (message.type === "cleanup_complete") return;
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
        ...sessionIdentity(request),
        sequence,
        type: "cancel",
      }),
    );
  } catch {
    // Cleanup still owns termination when the protocol pipe is already closed.
  }
}

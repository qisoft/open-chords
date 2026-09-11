import { randomUUID } from "node:crypto";

import { z } from "zod";

import { AcquisitionBroker, AcquisitionBrokerError } from "./acquisition-broker.ts";
import {
  decodeSidecarFrames,
  encodeSidecarFrame,
  type SidecarProcess,
} from "./sidecar-protocol.ts";

const Identity = { nonce: z.string().uuid(), sequence: z.number().int().min(0).max(100_000) };
const Ready = z.strictObject({
  ...Identity,
  op: z.literal("ready"),
  sequence: z.literal(0),
  extractor: z.literal("Youtube"),
  handler: z.literal("BrokerRH"),
  ytDlp: z.literal("2026.07.04"),
  ejs: z.literal("0.8.0"),
  proof: z.boolean(),
});
const Open = z.strictObject({
  ...Identity,
  op: z.literal("open"),
  url: z.string().max(16384),
  method: z.enum(["GET", "HEAD", "POST"]),
  headers: z.record(z.string(), z.string()).optional(),
  body: z
    .string()
    .max(700_000)
    .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u)
    .optional(),
});
const Read = z.strictObject({
  ...Identity,
  op: z.literal("read"),
  stream: z.number().int().positive(),
  amount: z.number().int().min(1).max(262144),
});
const Close = z.strictObject({
  ...Identity,
  op: z.literal("close"),
  stream: z.number().int().positive(),
});
const Result = z.strictObject({
  ...Identity,
  op: z.literal("result"),
  proof: z.boolean(),
  format: z
    .strictObject({
      container: z.enum(["mp4", "webm"]),
      audioCodec: z
        .string()
        .min(1)
        .max(64)
        .regex(/^[a-zA-Z0-9_.-]+$/u),
      mimeType: z.enum(["audio/mp4", "video/mp4", "audio/webm", "video/webm"]),
      providerFormatId: z
        .string()
        .min(1)
        .max(64)
        .regex(/^[a-zA-Z0-9_.-]+$/u),
    })
    .optional(),
  containment: z
    .strictObject({ workerNetworkDenied: z.literal(true), helperNetworkDenied: z.literal(true) })
    .optional(),
  artifact: z.strictObject({
    path: z.literal("media.bin"),
    bytes: z
      .number()
      .int()
      .positive()
      .max(256 * 1024 * 1024),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  }),
});
const Failure = z.strictObject({
  ...Identity,
  op: z.literal("failure"),
  reason: z.enum(["provider_unavailable", "bot_check", "unsupported_delivery", "worker_failed"]),
});
const Message = z.discriminatedUnion("op", [Ready, Open, Read, Close, Result, Failure]);

export class AcquisitionSessionError extends Error {
  readonly code:
    | "protocol_violation"
    | "cancelled"
    | "deadline"
    | "worker_failed"
    | "cleanup_failure"
    | "provider_unavailable"
    | "bot_check"
    | "unsupported_delivery";
  constructor(code: AcquisitionSessionError["code"]) {
    super(code);
    this.code = code;
  }
}

export async function runAcquisitionSession(options: {
  videoId: string;
  broker: AcquisitionBroker;
  launch(signal: AbortSignal): Promise<SidecarProcess>;
  signal?: AbortSignal;
  proof?: boolean;
}) {
  if (!/^[a-zA-Z0-9_-]{11}$/.test(options.videoId))
    throw new AcquisitionSessionError("protocol_violation");
  const abort = new AbortController();
  const cancelled = () => abort.abort(new AcquisitionSessionError("cancelled"));
  options.signal?.addEventListener("abort", cancelled, { once: true });
  if (options.signal?.aborted) cancelled();
  const timeout = setTimeout(() => abort.abort(new AcquisitionSessionError("deadline")), 180000);
  timeout.unref();
  let process: SidecarProcess | undefined;
  let launching: Promise<void> | undefined;
  let cleaning = false;
  let stopping: Promise<void> | undefined;
  const stopProcess = () => {
    if (process) stopping ??= process.stop("completed");
    return stopping;
  };
  const streams = new Map<
    number,
    { reader: ReadableStreamDefaultReader<Uint8Array>; pending: Uint8Array }
  >();
  let nextStream = 1;
  const nonce = randomUUID();
  let ready = false;
  let sequence = 0;
  let result: z.infer<typeof Result> | undefined;
  let rejectAbort: () => void = () => undefined;
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = () => reject(abort.signal.reason);
    abort.signal.addEventListener("abort", rejectAbort, { once: true });
    if (abort.signal.aborted) rejectAbort();
  });
  const exchange = async () => {
    abort.signal.throwIfAborted();
    launching = options.launch(abort.signal).then(async (launched) => {
      process = launched;
      // Even a launch that arrives after the cleanup deadline must be reaped.
      if (cleaning) await stopProcess();
      return undefined;
    });
    await launching;
    abort.signal.throwIfAborted();
    if (!process) throw new AcquisitionSessionError("worker_failed");
    await process.write(
      encodeSidecarFrame({ op: "start", nonce, videoId: options.videoId, protocol: 1 }),
    );
    for await (const raw of decodeSidecarFrames(process.stdout)) {
      abort.signal.throwIfAborted();
      const parsed = Message.safeParse(raw);
      if (!parsed.success) throw new AcquisitionSessionError("protocol_violation");
      const message = parsed.data;
      if (message.nonce !== nonce || message.sequence !== sequence++ || result)
        throw new AcquisitionSessionError("protocol_violation");
      if (message.op === "ready") {
        if (ready || message.proof !== (options.proof ?? false))
          throw new AcquisitionSessionError("protocol_violation");
        ready = true;
        continue;
      }
      if (!ready) throw new AcquisitionSessionError("protocol_violation");
      if (message.op === "failure") throw new AcquisitionSessionError(message.reason);
      if (message.op === "result") {
        if (message.proof !== (options.proof ?? false))
          throw new AcquisitionSessionError("protocol_violation");
        result = message;
        continue;
      }
      let value: unknown;
      try {
        if (message.op === "open") {
          if (streams.size >= 4) throw new AcquisitionSessionError("protocol_violation");
          const response = await options.broker.open({
            url: message.url,
            method: message.method,
            ...(message.headers === undefined ? {} : { headers: message.headers }),
            ...(message.body === undefined ? {} : { body: Buffer.from(message.body, "base64") }),
          });
          const stream = nextStream++;
          if (response.body)
            streams.set(stream, { reader: response.body.getReader(), pending: new Uint8Array() });
          value = {
            stream,
            status: response.status,
            url: response.url,
            headers: Object.fromEntries(response.headers),
            eof: !response.body,
          };
        } else if (message.op === "read") {
          const stream = streams.get(message.stream);
          if (!stream) throw new AcquisitionSessionError("protocol_violation");
          if (stream.pending.byteLength === 0) {
            const next = await stream.reader.read();
            if (next.done) {
              streams.delete(message.stream);
              value = { data: "", eof: true };
            } else stream.pending = next.value;
          }
          if (value === undefined) {
            const data = stream.pending.subarray(0, message.amount);
            stream.pending = stream.pending.subarray(data.byteLength);
            value = { data: Buffer.from(data).toString("base64"), eof: false };
          }
        } else {
          const stream = streams.get(message.stream);
          if (!stream) throw new AcquisitionSessionError("protocol_violation");
          await stream.reader.cancel();
          streams.delete(message.stream);
          value = {};
        }
      } catch (error) {
        if (!(error instanceof AcquisitionBrokerError) || error.code !== "network_unavailable")
          throw error;
        if (message.op === "read") streams.delete(message.stream);
        await process.write(
          encodeSidecarFrame({
            nonce,
            sequence: message.sequence,
            ok: false,
            error: "network_unavailable",
          }),
        );
        continue;
      }
      await process.write(
        encodeSidecarFrame({ nonce, sequence: message.sequence, ok: true, value }),
      );
    }
    if (!ready || !result) throw new AcquisitionSessionError("worker_failed");
    return {
      proof: result.proof,
      artifact: result.artifact,
      ...(result.format ? { format: result.format } : {}),
      ...(result.containment ? { containment: result.containment } : {}),
    };
  };
  const running = exchange();
  const outcome = await Promise.race([running, aborted]).then(
    (value) => ({ value }),
    (error: unknown) => ({
      error:
        error instanceof AcquisitionSessionError || error instanceof AcquisitionBrokerError
          ? error
          : new AcquisitionSessionError("worker_failed"),
    }),
  );
  clearTimeout(timeout);
  options.signal?.removeEventListener("abort", cancelled);
  abort.signal.removeEventListener("abort", rejectAbort);
  cleaning = true;
  let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
  const reap = async () => {
    try {
      await launching;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "cleanup_failure")
        throw error;
    }
    await stopProcess();
  };
  const cleanupDeadline = new Promise<never>((_, reject) => {
    cleanupTimer = setTimeout(() => reject(new AcquisitionSessionError("cleanup_failure")), 15000);
    cleanupTimer.unref();
  });
  const disposed = await Promise.allSettled([
    options.broker.close(),
    Promise.race([reap(), cleanupDeadline]),
  ]);
  clearTimeout(cleanupTimer);
  streams.clear();
  if (disposed.some((item) => item.status === "rejected"))
    throw new AcquisitionSessionError("cleanup_failure");
  if ("error" in outcome) throw outcome.error;
  return outcome.value;
}

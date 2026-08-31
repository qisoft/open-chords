import { describe, expect, it } from "vitest";

import {
  createEffectSidecarClient,
  createPromiseSidecarClient,
  encodeSidecarFrame,
  parseSidecarSessionRequest,
  SidecarSessionError,
  type SidecarProcess,
  type SidecarProcessLauncher,
  type SidecarSessionRequest,
} from "../apps/desktop/src/main/sidecar-session.ts";

const request = parseSidecarSessionRequest({
  jobId: "job-1",
  manifestHash: "a".repeat(64),
  nonce: "nonce-1",
  requestId: "request-1",
  timeoutMs: 100,
});

describe("sidecar session identity bounds", () => {
  it("uses the same 256 UTF-8 byte limit as the frozen protocol", () => {
    expect(
      parseSidecarSessionRequest({
        ...request,
        jobId: "é".repeat(128),
      }).jobId,
    ).toBe("é".repeat(128));
    expect(() =>
      parseSidecarSessionRequest({ ...request, jobId: `${"é".repeat(128)}a` }),
    ).toThrowError(SidecarSessionError);
    expect(() => parseSidecarSessionRequest({ ...request, jobId: "é".repeat(129) })).toThrowError(
      SidecarSessionError,
    );
    expect(() => parseSidecarSessionRequest({ ...request, nonce: "é".repeat(129) })).toThrowError(
      SidecarSessionError,
    );
    expect(() =>
      parseSidecarSessionRequest({ ...request, requestId: "é".repeat(129) }),
    ).toThrowError(SidecarSessionError);
    expect(() => parseSidecarSessionRequest({ ...request, jobId: "\uD800" })).toThrowError(
      SidecarSessionError,
    );
  });
});

class FakeProcess implements SidecarProcess {
  readonly commands: unknown[] = [];
  readonly events: string[] = [];
  readonly stops: string[] = [];
  stdout: AsyncIterable<Uint8Array>;

  constructor(messages: readonly unknown[], splitAt?: number) {
    const framed = Buffer.concat(messages.map((message) => encodeSidecarFrame(message)));
    const chunks =
      splitAt === undefined ? [framed] : [framed.subarray(0, splitAt), framed.subarray(splitAt)];
    this.stdout = (async function* () {
      for (const chunk of chunks) yield chunk;
    })();
  }

  async stop(reason: string): Promise<void> {
    this.events.push(`stop:${reason}`);
    this.stops.push(reason);
  }

  async write(frame: Uint8Array): Promise<void> {
    const command = decodeSingleFrame(frame);
    this.commands.push(command);
    const type =
      typeof command === "object" && command !== null && "type" in command
        ? command.type
        : undefined;
    this.events.push(`write:${String(type)}`);
  }
}

function launcherFor(process: FakeProcess): SidecarProcessLauncher {
  return { launch: async () => process };
}

function createHangingLauncherProbe(): {
  launcher: SidecarProcessLauncher;
  wasAborted(): boolean;
} {
  let aborted = false;
  return {
    launcher: {
      launch: async (_request, signal) =>
        new Promise<SidecarProcess>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(signal.reason);
            },
            { once: true },
          );
        }),
    },
    wasAborted: () => aborted,
  };
}

function decodeSingleFrame(frame: Uint8Array): unknown {
  const buffer = Buffer.from(frame);
  return JSON.parse(buffer.subarray(4, 4 + buffer.readUInt32BE(0)).toString("utf8"));
}

function successMessages(session: SidecarSessionRequest = request) {
  return [
    {
      capabilities: ["analysis"],
      manifestHash: session.manifestHash,
      nonce: session.nonce,
      protocolVersion: 1,
      sequence: 0,
      type: "handshake",
    },
    {
      artifact: { byteSize: 42, path: "result.json", sha256: "b".repeat(64) },
      jobId: session.jobId,
      nonce: session.nonce,
      requestId: session.requestId,
      sequence: 1,
      type: "result",
    },
  ] as const;
}

const clients = [
  ["Promise", createPromiseSidecarClient],
  ["Effect", createEffectSidecarClient],
] as const;

describe.each(clients)("%s sidecar client", (_name, createClient) => {
  it("runs a fragmented, manifest-verified session and releases the process", async () => {
    const process = new FakeProcess(successMessages(), 7);
    const client = createClient(launcherFor(process), {
      cancelAckTimeoutMs: 5,
      cooperativeCleanupTimeoutMs: 5,
    });

    await expect(client.runSession(request)).resolves.toEqual({
      artifact: { byteSize: 42, path: "result.json", sha256: "b".repeat(64) },
      jobId: request.jobId,
      requestId: request.requestId,
    });
    expect(process.commands).toEqual([
      {
        jobId: request.jobId,
        manifestHash: request.manifestHash,
        nonce: request.nonce,
        requestId: request.requestId,
        sequence: 0,
        type: "start",
      },
    ]);
    expect(process.stops).toEqual(["completed"]);
    await client.dispose();
  });

  it("rejects a mismatched nonce as a typed protocol failure", async () => {
    const process = new FakeProcess([{ ...successMessages()[0], nonce: "wrong-nonce" }]);
    const client = createClient(launcherFor(process), {
      cancelAckTimeoutMs: 5,
      cooperativeCleanupTimeoutMs: 5,
    });

    await expect(client.runSession(request)).rejects.toMatchObject({
      code: "protocol_violation",
    });
    expect(process.stops).toEqual(["protocol_violation"]);
    await client.dispose();
  });

  it("rejects a skipped sidecar sequence", async () => {
    const process = new FakeProcess([
      successMessages()[0],
      { ...successMessages()[1], sequence: 2 },
    ]);
    const client = createClient(launcherFor(process));

    await expect(client.runSession(request)).rejects.toMatchObject({
      code: "protocol_violation",
    });
    expect(process.stops).toEqual(["protocol_violation"]);
    await client.dispose();
  });

  it("rejects an oversized inbound frame before reading its payload", async () => {
    const header = Buffer.alloc(4);
    header.writeUInt32BE(1024 * 1024 + 1, 0);
    const process = new FakeProcess([]);
    process.stdout = (async function* () {
      yield header;
    })();
    const client = createClient(launcherFor(process));

    await expect(client.runSession(request)).rejects.toMatchObject({
      code: "frame_too_large",
    });
    expect(process.stops).toEqual(["frame_too_large"]);
    await client.dispose();
  });

  it("accepts a valid heartbeat before the terminal result", async () => {
    const process = new FakeProcess([
      successMessages()[0],
      { nonce: request.nonce, sequence: 1, type: "heartbeat" },
      { ...successMessages()[1], sequence: 2 },
    ]);
    const client = createClient(launcherFor(process));

    await expect(client.runSession(request)).resolves.toMatchObject({
      jobId: request.jobId,
      requestId: request.requestId,
    });
    expect(process.stops).toEqual(["completed"]);
    await client.dispose();
  });

  it("cancels, cleans up, and ignores a late result", async () => {
    const controller = new AbortController();
    let releaseOutput!: () => void;
    const process = new FakeProcess([]);
    process.stdout = (async function* () {
      yield encodeSidecarFrame(successMessages()[0]);
      await new Promise<void>((resolve) => {
        releaseOutput = resolve;
      });
      process.events.push("receive:late_result");
      yield encodeSidecarFrame(successMessages()[1]);
      process.events.push("receive:cancel_ack");
      yield encodeSidecarFrame({
        jobId: request.jobId,
        nonce: request.nonce,
        requestId: request.requestId,
        sequence: 2,
        type: "cancel_ack",
      });
      process.events.push("receive:cleanup_complete");
      yield encodeSidecarFrame({
        jobId: request.jobId,
        nonce: request.nonce,
        requestId: request.requestId,
        sequence: 3,
        type: "cleanup_complete",
      });
    })();
    const client = createClient(launcherFor(process), {
      cancelAckTimeoutMs: 5,
      cooperativeCleanupTimeoutMs: 5,
    });
    const result = client.runSession({ ...request, signal: controller.signal });
    const rejection = result.catch((error: unknown) => error);
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort();
    while (process.commands.length < 2) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    releaseOutput();

    expect(await rejection).toMatchObject({ code: "cancelled" });
    expect(process.commands).toContainEqual({
      jobId: request.jobId,
      nonce: request.nonce,
      requestId: request.requestId,
      sequence: 1,
      type: "cancel",
    });
    expect(process.stops).toEqual(["cancelled"]);
    expect(process.events).toEqual([
      "write:start",
      "write:cancel",
      "receive:late_result",
      "receive:cancel_ack",
      "receive:cleanup_complete",
      "stop:cancelled",
    ]);
    await client.dispose();
  });

  it("cannot publish a cancelled session's late result into the next session", async () => {
    const controller = new AbortController();
    let releaseCancelledOutput!: () => void;
    const cancelledProcess = new FakeProcess([]);
    cancelledProcess.stdout = (async function* () {
      yield encodeSidecarFrame(successMessages()[0]);
      await new Promise<void>((resolve) => {
        releaseCancelledOutput = resolve;
      });
      yield encodeSidecarFrame(successMessages()[1]);
      yield encodeSidecarFrame({
        jobId: request.jobId,
        nonce: request.nonce,
        requestId: request.requestId,
        sequence: 2,
        type: "cancel_ack",
      });
      yield encodeSidecarFrame({
        jobId: request.jobId,
        nonce: request.nonce,
        requestId: request.requestId,
        sequence: 3,
        type: "cleanup_complete",
      });
    })();
    const nextRequest = parseSidecarSessionRequest({
      ...request,
      jobId: "job-2",
      nonce: "nonce-2",
      requestId: "request-2",
    });
    const nextProcess = new FakeProcess(successMessages(nextRequest));
    const launches = [cancelledProcess, nextProcess];
    const client = createClient(
      {
        launch: async () => {
          const process = launches.shift();
          if (process === undefined) throw new Error("Unexpected launch");
          return process;
        },
      },
      { cancelAckTimeoutMs: 5, cooperativeCleanupTimeoutMs: 5 },
    );
    const cancelled = client
      .runSession({ ...request, signal: controller.signal })
      .catch((error: unknown) => error);
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort();
    while (cancelledProcess.commands.length < 2) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    releaseCancelledOutput();

    expect(await cancelled).toMatchObject({ code: "cancelled" });
    await expect(client.runSession(nextRequest)).resolves.toMatchObject({
      jobId: nextRequest.jobId,
      requestId: nextRequest.requestId,
    });
    expect(cancelledProcess.stops).toEqual(["cancelled"]);
    expect(nextProcess.stops).toEqual(["completed"]);
    await client.dispose();
  });

  it("times out a silent process and still releases it", async () => {
    const process = new FakeProcess([]);
    process.stdout = {
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise<IteratorResult<Uint8Array>>(() => undefined),
      }),
    };
    const client = createClient(launcherFor(process), {
      cancelAckTimeoutMs: 5,
      cooperativeCleanupTimeoutMs: 5,
    });

    await expect(client.runSession({ ...request, timeoutMs: 5 })).rejects.toMatchObject({
      code: "timeout",
    });
    expect(process.stops).toEqual(["timeout"]);
    await client.dispose();
  });

  it("interrupts a hanging acquisition with a typed timeout", async () => {
    const probe = createHangingLauncherProbe();
    const client = createClient(probe.launcher, {
      cancelAckTimeoutMs: 5,
      cooperativeCleanupTimeoutMs: 5,
    });

    await expect(client.runSession({ ...request, timeoutMs: 5 })).rejects.toMatchObject({
      code: "timeout",
    });
    expect(probe.wasAborted()).toBe(true);
    await client.dispose();
  });

  it("interrupts a hanging acquisition with typed user cancellation", async () => {
    const controller = new AbortController();
    const probe = createHangingLauncherProbe();
    const client = createClient(probe.launcher);
    const result = client
      .runSession({ ...request, signal: controller.signal })
      .catch((error: unknown) => error);
    await new Promise<void>((resolve) => setImmediate(resolve));

    controller.abort();

    expect(await result).toMatchObject({ code: "cancelled" });
    expect(probe.wasAborted()).toBe(true);
    await client.dispose();
  });

  it("awaits cleanup when acquisition resolves after cancellation", async () => {
    const controller = new AbortController();
    let finishStop!: () => void;
    let stopStarted = false;
    let stopFinished = false;
    const process = new FakeProcess([]);
    process.stop = async (reason) => {
      process.stops.push(reason);
      stopStarted = true;
      await new Promise<void>((resolve) => {
        finishStop = resolve;
      });
      stopFinished = true;
    };
    const client = createClient({
      launch: async (_request, signal) => {
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return process;
      },
    });
    let settled = false;
    const result = client
      .runSession({ ...request, signal: controller.signal })
      .catch((error: unknown) => error)
      .finally(() => {
        settled = true;
      });
    await new Promise<void>((resolve) => setImmediate(resolve));

    controller.abort();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(stopStarted).toBe(true);
    expect(settled).toBe(false);
    finishStop();
    expect(await result).toMatchObject({ code: "cancelled" });
    expect(stopFinished).toBe(true);
    expect(process.stops).toEqual(["cancelled"]);
    await client.dispose();
  });

  it("preserves acquisition cleanup failure over cancellation", async () => {
    const controller = new AbortController();
    const client = createClient({
      launch: async (_request, signal) => {
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        throw new SidecarSessionError("cleanup_failure", "Late process could not be reaped");
      },
    });
    const result = client
      .runSession({ ...request, signal: controller.signal })
      .catch((error: unknown) => error);
    await new Promise<void>((resolve) => setImmediate(resolve));

    controller.abort();

    expect(await result).toMatchObject({ code: "cleanup_failure" });
    await client.dispose();
  });

  it("enforces the handshake deadline independently of the session deadline", async () => {
    const process = new FakeProcess([]);
    process.stdout = {
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise<IteratorResult<Uint8Array>>(() => undefined),
      }),
    };
    const client = createClient(launcherFor(process), {
      cancelAckTimeoutMs: 5,
      cooperativeCleanupTimeoutMs: 5,
      handshakeTimeoutMs: 5,
      heartbeatTimeoutMs: 50,
    });

    await expect(client.runSession(request)).rejects.toMatchObject({
      code: "handshake_timeout",
    });
    expect(process.stops).toEqual(["handshake_timeout"]);
    await client.dispose();
  });

  it("enforces the heartbeat deadline after a valid handshake", async () => {
    const process = new FakeProcess([]);
    process.stdout = (async function* () {
      yield encodeSidecarFrame(successMessages()[0]);
      await new Promise(() => undefined);
    })();
    const client = createClient(launcherFor(process), {
      cancelAckTimeoutMs: 5,
      cooperativeCleanupTimeoutMs: 5,
      handshakeTimeoutMs: 50,
      heartbeatTimeoutMs: 5,
    });

    await expect(client.runSession(request)).rejects.toMatchObject({
      code: "heartbeat_timeout",
    });
    expect(process.stops).toEqual(["heartbeat_timeout"]);
    await client.dispose();
  });

  it("reports EOF before a terminal result", async () => {
    const process = new FakeProcess([successMessages()[0]]);
    const client = createClient(launcherFor(process), {
      cancelAckTimeoutMs: 5,
      cooperativeCleanupTimeoutMs: 5,
    });

    await expect(client.runSession(request)).rejects.toMatchObject({
      code: "unexpected_eof",
    });
    expect(process.stops).toEqual(["unexpected_eof"]);
    await client.dispose();
  });

  it("rejects an artifact path that escapes the job workspace", async () => {
    const process = new FakeProcess([
      successMessages()[0],
      { ...successMessages()[1], artifact: { ...successMessages()[1].artifact, path: "../x" } },
    ]);
    const client = createClient(launcherFor(process));

    await expect(client.runSession(request)).rejects.toMatchObject({
      code: "protocol_violation",
    });
    expect(process.stops).toEqual(["protocol_violation"]);
    await client.dispose();
  });

  it("maps a bounded sidecar terminal error to a typed failure", async () => {
    const process = new FakeProcess([
      successMessages()[0],
      {
        code: "analysis_failed",
        jobId: request.jobId,
        message: "Analyzer rejected the staged input",
        nonce: request.nonce,
        requestId: request.requestId,
        sequence: 1,
        type: "error",
      },
    ]);
    const client = createClient(launcherFor(process));

    await expect(client.runSession(request)).rejects.toMatchObject({
      code: "remote_failure",
      remoteCode: "analysis_failed",
    });
    expect(process.stops).toEqual(["remote_failure"]);
    await client.dispose();
  });

  it("interrupts an active session and awaits cleanup on dispose", async () => {
    const process = new FakeProcess([]);
    process.stdout = {
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise<IteratorResult<Uint8Array>>(() => undefined),
      }),
    };
    const client = createClient(launcherFor(process), {
      cancelAckTimeoutMs: 5,
      cooperativeCleanupTimeoutMs: 5,
    });
    const result = client.runSession(request).catch((error: unknown) => error);
    await new Promise<void>((resolve) => setImmediate(resolve));

    await client.dispose();

    expect(await result).toMatchObject({ code: "disposed" });
    expect(process.stops).toEqual(["disposed"]);
  });
});

it("rejects frames larger than one MiB before parsing JSON", () => {
  expect(() => encodeSidecarFrame({ payload: "x".repeat(1024 * 1024) })).toThrowError(
    expect.objectContaining({ code: "frame_too_large" }),
  );
});

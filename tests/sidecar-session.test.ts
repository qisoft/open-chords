import { describe, expect, it } from "vitest";

import {
  createEffectSidecarClient,
  createPromiseSidecarClient,
  encodeSidecarFrame,
  type SidecarProcess,
  type SidecarProcessLauncher,
} from "../apps/desktop/src/main/sidecar-session.ts";

const request = {
  jobId: "job-1",
  manifestHash: "a".repeat(64),
  nonce: "nonce-1",
  requestId: "request-1",
  timeoutMs: 100,
} as const;

class FakeProcess implements SidecarProcess {
  readonly commands: unknown[] = [];
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
    this.stops.push(reason);
  }

  async write(frame: Uint8Array): Promise<void> {
    this.commands.push(decodeSingleFrame(frame));
  }
}

function launcherFor(process: FakeProcess): SidecarProcessLauncher {
  return { launch: async () => process };
}

function decodeSingleFrame(frame: Uint8Array): unknown {
  const buffer = Buffer.from(frame);
  return JSON.parse(buffer.subarray(4, 4 + buffer.readUInt32BE(0)).toString("utf8"));
}

function successMessages() {
  return [
    {
      capabilities: ["analysis"],
      manifestHash: request.manifestHash,
      nonce: request.nonce,
      protocolVersion: 1,
      sequence: 0,
      type: "handshake",
    },
    {
      artifact: { byteSize: 42, path: "result.json", sha256: "b".repeat(64) },
      jobId: request.jobId,
      nonce: request.nonce,
      requestId: request.requestId,
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
    const client = createClient(launcherFor(process));

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
    const client = createClient(launcherFor(process));

    await expect(client.runSession(request)).rejects.toMatchObject({
      code: "protocol_violation",
    });
    expect(process.stops).toEqual(["protocol_violation"]);
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
      yield encodeSidecarFrame(successMessages()[1]);
    })();
    const client = createClient(launcherFor(process));
    const result = client.runSession({ ...request, signal: controller.signal });
    const rejection = result.catch((error: unknown) => error);
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort();
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
    await client.dispose();
  });

  it("times out a silent process and still releases it", async () => {
    const process = new FakeProcess([]);
    process.stdout = {
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise<IteratorResult<Uint8Array>>(() => undefined),
      }),
    };
    const client = createClient(launcherFor(process));

    await expect(client.runSession({ ...request, timeoutMs: 5 })).rejects.toMatchObject({
      code: "timeout",
    });
    expect(process.stops).toEqual(["timeout"]);
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
    const client = createClient(launcherFor(process));

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

    await expect(client.runSession(request)).rejects.toMatchObject({ code: "remote_failure" });
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
    const client = createClient(launcherFor(process));
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

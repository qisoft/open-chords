import { z } from "zod";

import {
  decodeSidecarFrames,
  encodeSidecarFrame,
  parseSidecarStartMessage,
} from "./sidecar-protocol.ts";

type UtilityParentPort = {
  once(event: "message", listener: (event: { data: unknown }) => void): void;
};

const parentPort = Reflect.get(process, "parentPort") as UtilityParentPort | undefined;
if (parentPort === undefined) {
  throw new Error("Packaged sidecar proof requires an Electron utility-process parent port");
}

parentPort.once("message", (event) => {
  void respondToStart(event.data).catch((error: unknown) => {
    process.stderr.write(error instanceof Error ? error.message : "Packaged sidecar failed");
    queueMicrotask(() => {
      throw error;
    });
  });
});

async function respondToStart(rawFrame: unknown): Promise<void> {
  const frame = z.instanceof(Uint8Array).parse(rawFrame);
  const messages: unknown[] = [];
  for await (const message of decodeSidecarFrames(
    (async function* () {
      yield frame;
    })(),
  )) {
    messages.push(message);
  }
  if (messages.length !== 1) throw new Error("Expected exactly one framed start message");
  const start = parseSidecarStartMessage(messages[0]);
  await writeFrame({
    capabilities: ["analysis"],
    manifestHash: start.manifestHash,
    nonce: start.nonce,
    protocolVersion: 1,
    sequence: 0,
    type: "handshake",
  });
  await writeFrame({
    artifact: { byteSize: 42, path: "result.json", sha256: "b".repeat(64) },
    jobId: start.jobId,
    nonce: start.nonce,
    requestId: start.requestId,
    sequence: 1,
    type: "result",
  });
}

async function writeFrame(message: unknown): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(encodeSidecarFrame(message), (error) => {
      if (error === null || error === undefined) resolve();
      else reject(error);
    });
  });
}

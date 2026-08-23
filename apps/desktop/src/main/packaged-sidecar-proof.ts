import type { Writable } from "node:stream";

import { z } from "zod";

import { decodeSidecarFrames, encodeSidecarFrame } from "./sidecar-protocol.ts";

export const PACKAGED_SIDECAR_PROOF_ARGUMENT = "--sidecar-lifecycle-proof";

const StartSchema = z.object({
  jobId: z.string().min(1).max(256),
  manifestHash: z.string().regex(/^[a-f0-9]{64}$/u),
  nonce: z.string().min(1).max(256),
  requestId: z.string().min(1).max(256),
  sequence: z.literal(0),
  type: z.literal("start"),
});

export async function runPackagedSidecarProof(
  input: AsyncIterable<Uint8Array> = process.stdin,
  output: Writable = process.stdout,
): Promise<void> {
  for await (const rawMessage of decodeSidecarFrames(input)) {
    const message = StartSchema.parse(rawMessage);
    await writeFrame(output, {
      capabilities: ["analysis"],
      manifestHash: message.manifestHash,
      nonce: message.nonce,
      protocolVersion: 1,
      sequence: 0,
      type: "handshake",
    });
    await writeFrame(output, {
      artifact: { byteSize: 42, path: "result.json", sha256: "b".repeat(64) },
      jobId: message.jobId,
      nonce: message.nonce,
      requestId: message.requestId,
      sequence: 1,
      type: "result",
    });
    await endOutput(output);
    return;
  }

  throw new Error("Packaged sidecar proof closed before receiving a start frame");
}

async function writeFrame(output: Writable, message: unknown): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    output.write(encodeSidecarFrame(message), (error) => {
      if (error === null || error === undefined) resolve();
      else reject(error);
    });
  });
}

async function endOutput(output: Writable): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    output.once("error", reject);
    output.end(() => {
      output.off("error", reject);
      resolve();
    });
  });
}

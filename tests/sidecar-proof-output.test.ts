import { PassThrough, Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import { runPackagedSidecarProof } from "../apps/desktop/src/main/packaged-sidecar-proof.ts";
import {
  decodeSidecarFrames,
  encodeSidecarFrame,
} from "../apps/desktop/src/main/sidecar-protocol.ts";

describe("packaged sidecar proof", () => {
  it("flushes both terminal frames before closing standard output", async () => {
    const output = new PassThrough();
    const chunks: Buffer[] = [];
    output.on("data", (chunk: Buffer) => chunks.push(chunk));

    await runPackagedSidecarProof(
      Readable.from([
        encodeSidecarFrame({
          jobId: "job-packaged-proof",
          manifestHash: "a".repeat(64),
          nonce: "nonce-packaged-proof",
          requestId: "request-packaged-proof",
          sequence: 0,
          type: "start",
        }),
      ]),
      output,
    );

    expect(output.writableEnded).toBe(true);
    const messages: unknown[] = [];
    for await (const message of decodeSidecarFrames(Readable.from(chunks))) {
      messages.push(message);
    }
    expect(messages).toMatchObject([
      { sequence: 0, type: "handshake" },
      { sequence: 1, type: "result" },
    ]);
  });
});

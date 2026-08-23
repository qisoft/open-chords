import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { z } from "zod";

import {
  createEffectSidecarClient,
  createUncontainedSpawnLauncherForProof,
  parseSidecarSessionRequest,
} from "./sidecar-session.ts";

export async function runPackagedSidecarProof(): Promise<void> {
  const runtimeRoot = join(process.resourcesPath, "open-chords-analysis");
  const executablePath = join(
    runtimeRoot,
    `open-chords-analysis${process.platform === "win32" ? ".exe" : ""}`,
  );
  const manifestHash = createHash("sha256")
    .update(readFileSync(join(runtimeRoot, "runtime-manifest.json")))
    .digest("hex");
  const workspace = mkdtempSync(join(tmpdir(), "open-chords-packaged-sidecar-"));
  const inputPath = join(workspace, "input", "source-media");
  mkdirSync(dirname(inputPath), { recursive: true });
  writeFileSync(inputPath, canonicalWavFixture());
  const client = createEffectSidecarClient(
    createUncontainedSpawnLauncherForProof({
      args: [],
      cwd: workspace,
      env: {},
      executablePath,
    }),
  );
  const request = parseSidecarSessionRequest({
    jobId: "job-packaged-proof",
    manifestHash,
    nonce: "nonce-packaged-proof",
    requestId: "request-packaged-proof",
    timeoutMs: 15_000,
  });
  try {
    const result = await client.runSession(request);
    if (
      result.artifact.path !== "artifacts/decode-manifest.json" ||
      result.jobId !== request.jobId ||
      result.requestId !== request.requestId
    ) {
      throw new Error("Packaged sidecar lifecycle proof returned an unexpected descriptor");
    }
    const decodeManifestBytes = readFileSync(join(workspace, result.artifact.path));
    if (
      decodeManifestBytes.byteLength !== result.artifact.byteSize ||
      createHash("sha256").update(decodeManifestBytes).digest("hex") !== result.artifact.sha256
    ) {
      throw new Error("Packaged sidecar lifecycle proof returned an invalid descriptor hash");
    }
    const decodeManifest = z
      .object({ canonicalAudio: z.object({ sampleCount: z.literal(4_800) }) })
      .parse(JSON.parse(decodeManifestBytes.toString("utf8")));
    if (decodeManifest.canonicalAudio.sampleCount !== 4_800) {
      throw new Error("Packaged sidecar lifecycle proof returned unexpected evidence");
    }
  } finally {
    await client.dispose();
    rmSync(workspace, { force: true, recursive: true });
  }
}

function canonicalWavFixture(): Buffer {
  const sampleCount = 4_800;
  const result = Buffer.alloc(44 + sampleCount * 2);
  result.write("RIFF", 0, "ascii");
  result.writeUInt32LE(result.byteLength - 8, 4);
  result.write("WAVEfmt ", 8, "ascii");
  result.writeUInt32LE(16, 16);
  result.writeUInt16LE(1, 20);
  result.writeUInt16LE(1, 22);
  result.writeUInt32LE(48_000, 24);
  result.writeUInt32LE(96_000, 28);
  result.writeUInt16LE(2, 32);
  result.writeUInt16LE(16, 34);
  result.write("data", 36, "ascii");
  result.writeUInt32LE(sampleCount * 2, 40);
  for (let index = 0; index < sampleCount; index += 1) {
    result.writeInt16LE(Math.round(Math.sin(index / 13) * 4_000), 44 + index * 2);
  }
  return result;
}

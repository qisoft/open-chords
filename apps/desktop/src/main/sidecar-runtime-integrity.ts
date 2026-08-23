import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

import { z } from "zod";

const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const RuntimeFileSchema = z.strictObject({
  byteSize: z.number().int().nonnegative(),
  path: z.string().min(1),
  sha256: Sha256Schema,
  type: z.literal("file"),
});
const RuntimeSymlinkSchema = z.strictObject({
  path: z.string().min(1),
  target: z.string().min(1),
  type: z.literal("symlink"),
});
const RuntimeManifestSchema = z.strictObject({
  buildId: z.string().min(1),
  files: z.array(z.union([RuntimeFileSchema, RuntimeSymlinkSchema])).min(1),
  platformProfile: z.string().min(1),
  schemaVersion: z.literal(1),
});

export type VerifiedSidecarRuntime = {
  executablePath: string;
  manifestHash: string;
};

export function verifyPackagedSidecarRuntime(
  runtimeRoot: string,
  expectedManifestHash: string,
): VerifiedSidecarRuntime {
  const expectedHash = Sha256Schema.parse(expectedManifestHash);
  const manifestBytes = readFileSync(resolve(runtimeRoot, "runtime-manifest.json"));
  if (manifestBytes.byteLength > MAX_MANIFEST_BYTES) {
    throw new Error("Packaged sidecar manifest exceeds four MiB");
  }
  const actualManifestHash = sha256(manifestBytes);
  if (actualManifestHash !== expectedHash) {
    throw new Error("Packaged sidecar manifest did not match protected build metadata");
  }
  const manifest = RuntimeManifestSchema.parse(JSON.parse(manifestBytes.toString("utf8")));
  const executableSuffix = process.platform === "win32" ? ".exe" : "";
  const requiredPaths = [
    `open-chords-analysis${executableSuffix}`,
    `tools/ffmpeg${executableSuffix}`,
    `tools/ffprobe${executableSuffix}`,
  ];
  const entries = new Map(manifest.files.map((entry) => [entry.path, entry]));
  for (const requiredPath of requiredPaths) {
    const entry = entries.get(requiredPath);
    if (entry?.type !== "file") {
      throw new Error(`Packaged sidecar manifest misses ${requiredPath}`);
    }
    const candidate = resolveRuntimeFile(runtimeRoot, requiredPath);
    const stat = lstatSync(candidate);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`Packaged sidecar runtime file is invalid: ${requiredPath}`);
    }
    const content = readFileSync(candidate);
    if (content.byteLength !== entry.byteSize || sha256(content) !== entry.sha256) {
      throw new Error(`Packaged sidecar runtime hash mismatch: ${requiredPath}`);
    }
  }
  return {
    executablePath: resolveRuntimeFile(runtimeRoot, requiredPaths[0]!),
    manifestHash: actualManifestHash,
  };
}

function resolveRuntimeFile(runtimeRoot: string, filePath: string): string {
  if (isAbsolute(filePath) || filePath.split(/[\\/]/u).includes("..")) {
    throw new Error("Packaged sidecar path escaped its runtime root");
  }
  const root = resolve(runtimeRoot);
  const candidate = resolve(root, filePath);
  const fromRoot = relative(root, candidate);
  if (fromRoot.startsWith("..") || isAbsolute(fromRoot)) {
    throw new Error("Packaged sidecar path escaped its runtime root");
  }
  return candidate;
}

function sha256(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

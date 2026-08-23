import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

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
  const expectedPaths = new Set<string>();
  for (const entry of manifest.files) {
    if (expectedPaths.has(entry.path)) {
      throw new Error("Packaged sidecar manifest contains a duplicate path");
    }
    const candidate = resolveRuntimeFile(runtimeRoot, entry.path);
    const stat = lstatSync(candidate);
    if (entry.type === "symlink") {
      if (!stat.isSymbolicLink() || readlinkSync(candidate) !== entry.target) {
        throw new Error(`Packaged sidecar symbolic link mismatch: ${entry.path}`);
      }
      ensureRealPathWithinRoot(runtimeRoot, candidate);
    } else {
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error(`Packaged sidecar runtime file is invalid: ${entry.path}`);
      }
      ensureRealPathWithinRoot(runtimeRoot, candidate);
      const content = readFileSync(candidate);
      if (content.byteLength !== entry.byteSize || sha256(content) !== entry.sha256) {
        throw new Error(`Packaged sidecar runtime hash mismatch: ${entry.path}`);
      }
    }
    expectedPaths.add(entry.path);
  }
  const actualPaths = collectRuntimeEntries(runtimeRoot);
  if (
    actualPaths.size !== expectedPaths.size ||
    [...actualPaths].some((path) => !expectedPaths.has(path))
  ) {
    throw new Error("Packaged sidecar runtime contains an unmanifested file");
  }
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
  }
  return {
    executablePath: resolveRuntimeFile(runtimeRoot, requiredPaths[0]!),
    manifestHash: actualManifestHash,
  };
}

function resolveRuntimeFile(runtimeRoot: string, filePath: string): string {
  if (isAbsolute(filePath) || filePath.includes("\\") || filePath.split("/").includes("..")) {
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

function ensureRealPathWithinRoot(runtimeRoot: string, candidate: string): void {
  const root = realpathSync(runtimeRoot);
  const realCandidate = realpathSync(candidate);
  const fromRoot = relative(root, realCandidate);
  if (fromRoot.startsWith("..") || isAbsolute(fromRoot)) {
    throw new Error("Packaged sidecar file escaped its runtime root");
  }
}

function collectRuntimeEntries(runtimeRoot: string): Set<string> {
  const root = resolve(runtimeRoot);
  const entries = new Set<string>();
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        const relativePath = relative(root, path).replaceAll("\\", "/");
        if (relativePath !== "runtime-manifest.json") entries.add(relativePath);
      } else {
        throw new Error("Packaged sidecar runtime contains an unsupported file type");
      }
    }
  };
  visit(root);
  return entries;
}

function sha256(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

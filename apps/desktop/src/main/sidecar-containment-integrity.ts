import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { z } from "zod";

import type { NativeContainmentPlatform } from "./sidecar-containment-launcher.ts";
import { SidecarSessionError } from "./sidecar-protocol.ts";

const ManifestSchema = z.object({
  backend: z.enum(["macos-xpc-app-sandbox", "windows-appcontainer-job", "linux-landlock-seccomp"]),
  files: z
    .array(
      z.object({
        path: z.string().min(1),
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
      }),
    )
    .min(1),
  version: z.literal(1),
});

const BACKEND_BY_PLATFORM = {
  darwin: "macos-xpc-app-sandbox",
  linux: "linux-landlock-seccomp",
  win32: "windows-appcontainer-job",
} as const;

const HELPER_BY_PLATFORM = {
  darwin: "open-chords-containment-bridge",
  linux: "open-chords-containment-launcher",
  win32: "open-chords-containment-launcher.exe",
} as const;

export type VerifiedContainmentRuntime = Readonly<{
  backend: (typeof BACKEND_BY_PLATFORM)[NativeContainmentPlatform];
  helperPath: string;
  root: string;
  [verifiedRuntime]: true;
}>;

const verifiedRuntime: unique symbol = Symbol("verified-containment-runtime");

export function verifyContainmentRuntime(
  runtimeRoot: string,
  expectedManifestHash: string,
  platform: NativeContainmentPlatform,
  helperPathOverride?: string,
): VerifiedContainmentRuntime {
  const root = realpathSync(resolve(runtimeRoot));
  const manifestPath = join(root, "containment-manifest.json");
  const manifestBytes = readFileSync(manifestPath);
  if (manifestBytes.byteLength > 1024 * 1024) fail("Containment manifest is oversized");
  const manifestHash = createHash("sha256").update(manifestBytes).digest("hex");
  if (manifestHash !== expectedManifestHash) fail("Containment manifest hash mismatch");
  const manifest = ManifestSchema.parse(JSON.parse(manifestBytes.toString("utf8")));
  if (manifest.backend !== BACKEND_BY_PLATFORM[platform]) {
    fail("Containment manifest targets another platform backend");
  }
  const declared = new Set<string>();
  for (const entry of manifest.files) {
    const path = safeManifestPath(root, entry.path);
    if (declared.has(entry.path)) fail("Containment manifest contains a duplicate path");
    declared.add(entry.path);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(path) !== path) {
      fail("Containment runtime file is not a direct regular file");
    }
    const digest = createHash("sha256").update(readFileSync(path)).digest("hex");
    if (digest !== entry.sha256) fail(`Containment runtime hash mismatch: ${entry.path}`);
  }
  const observed = listFiles(root).filter((path) => path !== "containment-manifest.json");
  if (observed.some((path) => !declared.has(path)) || declared.size !== observed.length) {
    fail("Containment runtime contains an unmanifested file");
  }
  const helperRelative = HELPER_BY_PLATFORM[platform];
  if (!declared.has(helperRelative)) fail("Containment manifest misses its native helper");
  const helperPath =
    helperPathOverride === undefined
      ? join(root, helperRelative)
      : verifyExternalHelper(helperPathOverride, join(root, helperRelative));
  return Object.freeze({
    backend: BACKEND_BY_PLATFORM[platform],
    helperPath,
    root,
    [verifiedRuntime]: true as const,
  });
}

function verifyExternalHelper(candidate: string, manifestedHelper: string): string {
  const path = realpathSync(resolve(candidate));
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail("External containment helper is not a direct regular file");
  }
  const expected = createHash("sha256").update(readFileSync(manifestedHelper)).digest("hex");
  const observed = createHash("sha256").update(readFileSync(path)).digest("hex");
  if (observed !== expected) fail("External containment helper hash mismatch");
  return path;
}

function safeManifestPath(root: string, manifestPath: string): string {
  if (isAbsolute(manifestPath) || manifestPath.includes("\\")) {
    fail("Containment manifest path is unsafe");
  }
  const path = resolve(root, manifestPath);
  const child = relative(root, path);
  if (child === "" || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    fail("Containment manifest path escaped its root");
  }
  return path;
}

function listFiles(root: string): string[] {
  const result: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) fail("Containment runtime contains a symbolic link");
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) result.push(relative(root, path).split(sep).join("/"));
      else fail("Containment runtime contains an unsupported file type");
    }
  };
  visit(root);
  return result.sort();
}

function fail(message: string): never {
  throw new SidecarSessionError("launch_failure", message);
}

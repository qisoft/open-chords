import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { verifyPackagedSidecarRuntime } from "../apps/desktop/src/main/sidecar-runtime-integrity.ts";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

it("anchors the exact packaged executable and native tools in protected build metadata", () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "open-chords-runtime-integrity-"));
  temporaryRoots.push(runtimeRoot);
  mkdirSync(join(runtimeRoot, "tools"));
  mkdirSync(join(runtimeRoot, "_internal"));
  const suffix = process.platform === "win32" ? ".exe" : "";
  const files = [
    [`open-chords-analysis${suffix}`, Buffer.from("sidecar")],
    [`tools/ffmpeg${suffix}`, Buffer.from("ffmpeg")],
    [`tools/ffprobe${suffix}`, Buffer.from("ffprobe")],
    ["_internal/runtime.bin", Buffer.from("python runtime")],
  ] as const;
  for (const [path, content] of files) writeFileSync(join(runtimeRoot, path), content);
  const manifest = Buffer.from(
    `${JSON.stringify({
      buildId: "test-build",
      files: files.map(([path, content]) => ({
        byteSize: content.byteLength,
        path,
        sha256: createHash("sha256").update(content).digest("hex"),
        type: "file",
      })),
      platformProfile: "test-profile",
      schemaVersion: 1,
    })}\n`,
  );
  writeFileSync(join(runtimeRoot, "runtime-manifest.json"), manifest);
  const protectedHash = createHash("sha256").update(manifest).digest("hex");

  expect(verifyPackagedSidecarRuntime(runtimeRoot, protectedHash)).toMatchObject({
    manifestHash: protectedHash,
  });

  writeFileSync(join(runtimeRoot, `open-chords-analysis${suffix}`), "replacement");
  expect(() => verifyPackagedSidecarRuntime(runtimeRoot, protectedHash)).toThrow(
    "runtime hash mismatch",
  );
  writeFileSync(join(runtimeRoot, `open-chords-analysis${suffix}`), "sidecar");

  writeFileSync(join(runtimeRoot, "_internal/runtime.bin"), "tampered python runtime");
  expect(() => verifyPackagedSidecarRuntime(runtimeRoot, protectedHash)).toThrow(
    "runtime hash mismatch",
  );
  writeFileSync(join(runtimeRoot, "_internal/runtime.bin"), "python runtime");

  writeFileSync(join(runtimeRoot, "_internal/extra.pyc"), "unmanifested");
  expect(() => verifyPackagedSidecarRuntime(runtimeRoot, protectedHash)).toThrow(
    "unmanifested file",
  );
});

it("rejects an oversized manifest before reading its content", () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "open-chords-runtime-large-manifest-"));
  temporaryRoots.push(runtimeRoot);
  writeFileSync(join(runtimeRoot, "runtime-manifest.json"), Buffer.alloc(4 * 1024 * 1024 + 1));

  expect(() => verifyPackagedSidecarRuntime(runtimeRoot, "0".repeat(64))).toThrow(
    "manifest exceeds four MiB",
  );
});

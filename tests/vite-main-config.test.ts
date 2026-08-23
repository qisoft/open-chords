import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { readSidecarManifestHash } from "../vite.main.config.ts";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

it("fails a packaged main build before embedding unavailable sidecar metadata", () => {
  const root = mkdtempSync(join(tmpdir(), "open-chords-main-config-"));
  temporaryRoots.push(root);
  const missingManifest = join(root, "runtime-manifest.json");

  expect(() => readSidecarManifestHash(missingManifest, true)).toThrow(
    "requires the frozen sidecar manifest",
  );
  expect(readSidecarManifestHash(missingManifest, false)).toBe("unavailable");

  const manifest = Buffer.from("reviewed runtime manifest\n");
  writeFileSync(missingManifest, manifest);
  expect(readSidecarManifestHash(missingManifest, true)).toBe(
    createHash("sha256").update(manifest).digest("hex"),
  );
});

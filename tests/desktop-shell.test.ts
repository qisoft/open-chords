import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadRendererAssetManifest } from "../apps/desktop/src/main/renderer-assets.ts";

describe("desktop shell renderer assets", () => {
  it("resolves only the packaged files declared by the renderer manifest", () => {
    const root = mkdtempSync(join(tmpdir(), "open-chords-renderer-"));
    mkdirSync(join(root, "assets"));
    writeFileSync(join(root, "index.html"), "<!doctype html>");
    writeFileSync(join(root, "assets/main.js"), "export {};");
    writeFileSync(join(root, "package.json"), "{}");
    writeFileSync(
      join(root, "asset-manifest.json"),
      JSON.stringify({
        "main.tsx": {
          file: "assets/main.js",
          isEntry: true,
          src: "main.tsx",
        },
      }),
    );

    const assets = loadRendererAssetManifest(root);

    expect(assets.resolve("open-chords://app/")).toBe(join(root, "index.html"));
    expect(assets.resolve("open-chords://app/assets/main.js")).toBe(join(root, "assets/main.js"));
    expect(assets.resolve("open-chords://app/package.json")).toBeNull();
    expect(assets.resolve("open-chords://app/../package.json")).toBeNull();
    expect(assets.resolve("open-chords://other/assets/main.js")).toBeNull();
  });
});

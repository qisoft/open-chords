import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { loadRendererAssetManifest } from "../apps/desktop/src/main/renderer-assets.ts";
import {
  denyPermissionRequest,
  denyWindowOpen,
  guardPrimaryRendererNavigation,
  PRIMARY_RENDERER_PARTITION,
  preventWebviewAttachment,
  rendererRequestPolicy,
} from "../apps/desktop/src/main/shell.ts";

describe("desktop shell denial policy", () => {
  it("keeps the primary renderer session ephemeral", () => {
    expect(PRIMARY_RENDERER_PARTITION.startsWith("persist:")).toBe(false);
  });

  it("denies permissions and non-application requests at the session seam", () => {
    const permissionCallback = vi.fn<(allowed: boolean) => void>();
    denyPermissionRequest(permissionCallback);
    expect(permissionCallback).toHaveBeenCalledWith(false);
    expect(rendererRequestPolicy("https://example.com/")).toEqual({ cancel: true });
    expect(rendererRequestPolicy("open-chords://app/index.html")).toEqual({ cancel: false });
    expect(rendererRequestPolicy("open-chords://other/index.html")).toEqual({ cancel: true });
  });

  it("denies popup, webview, navigation, and redirect escape at the WebContents seam", () => {
    expect(denyWindowOpen()).toEqual({ action: "deny" });
    const preventAttachment = vi.fn<() => void>();
    preventWebviewAttachment({ preventDefault: preventAttachment });
    expect(preventAttachment).toHaveBeenCalledOnce();

    const preventEscape = vi.fn<() => void>();
    guardPrimaryRendererNavigation({ preventDefault: preventEscape }, "https://example.com/");
    expect(preventEscape).toHaveBeenCalledOnce();

    const preventApplication = vi.fn<() => void>();
    guardPrimaryRendererNavigation(
      { preventDefault: preventApplication },
      "open-chords://app/index.html",
    );
    expect(preventApplication).not.toHaveBeenCalled();
  });
});

describe("desktop shell renderer assets", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
  });

  it("resolves only the packaged files declared by the renderer manifest", () => {
    const root = mkdtempSync(join(tmpdir(), "open-chords-renderer-"));
    roots.push(root);
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

  it("decodes manifest asset paths and rejects encoded traversal", () => {
    const root = mkdtempSync(join(tmpdir(), "open-chords-renderer-"));
    roots.push(root);
    mkdirSync(join(root, "assets"));
    writeFileSync(join(root, "index.html"), "<!doctype html>");
    writeFileSync(join(root, "assets/main file.js"), "export {};");
    writeFileSync(
      join(root, "asset-manifest.json"),
      JSON.stringify({ main: { file: "assets/main file.js", isEntry: true } }),
    );

    const assets = loadRendererAssetManifest(root);
    expect(assets.resolve("open-chords://app/assets/main%20file.js")).toBe(
      join(root, "assets/main file.js"),
    );
    expect(assets.resolve("open-chords://app/%2e%2e/package.json")).toBeNull();
    expect(assets.resolve("open-chords://app/%E0%A4%A")).toBeNull();
  });

  it("fails fast for unsafe, missing, and incomplete manifest assets", () => {
    const createRoot = (manifest: object, files: string[] = []) => {
      const root = mkdtempSync(join(tmpdir(), "open-chords-renderer-"));
      roots.push(root);
      for (const file of files) {
        mkdirSync(join(root, file, ".."), { recursive: true });
        writeFileSync(join(root, file), "fixture");
      }
      writeFileSync(join(root, "asset-manifest.json"), JSON.stringify(manifest));
      return root;
    };

    expect(() =>
      loadRendererAssetManifest(
        createRoot({ main: { file: "../outside.js", isEntry: true } }, ["index.html"]),
      ),
    ).toThrow(/Unsafe renderer asset path/);
    expect(() =>
      loadRendererAssetManifest(
        createRoot({ main: { file: "assets/missing.js", isEntry: true } }, ["index.html"]),
      ),
    ).toThrow(/Missing renderer asset/);
    expect(() =>
      loadRendererAssetManifest(createRoot({ main: { file: "assets/main.js", isEntry: true } })),
    ).toThrow(/Missing renderer asset: index\.html/);
  });
});

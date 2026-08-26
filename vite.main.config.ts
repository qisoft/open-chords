import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { resolve } from "node:path";

import { defineConfig } from "vite";

const sidecarManifestPath = resolve(
  "dist/analysis-sidecar/open-chords-analysis/runtime-manifest.json",
);
const containmentManifestPath = resolve("dist/containment/containment-manifest.json");

export function readSidecarManifestHash(manifestPath: string, required: boolean): string {
  if (!existsSync(manifestPath)) {
    if (required) throw new Error("Packaged main build requires the frozen sidecar manifest");
    return "unavailable";
  }
  return createHash("sha256").update(readFileSync(manifestPath)).digest("hex");
}

export default defineConfig(({ mode }) => {
  const sidecarManifestHash = readSidecarManifestHash(sidecarManifestPath, mode === "packaged");
  const containmentManifestHash = readSidecarManifestHash(
    containmentManifestPath,
    mode === "packaged",
  );
  return {
    define: {
      OPEN_CHORDS_EMBEDDED_CONTAINMENT_MANIFEST_SHA256: JSON.stringify(containmentManifestHash),
      OPEN_CHORDS_EMBEDDED_SIDECAR_MANIFEST_SHA256: JSON.stringify(sidecarManifestHash),
    },
    build: {
      outDir: "dist/main",
      emptyOutDir: true,
      sourcemap: true,
      lib: {
        entry: "apps/desktop/src/main/index.ts",
        formats: ["cjs"],
        fileName: () => "main.cjs",
      },
      rolldownOptions: {
        external: ["electron", ...builtinModules, ...builtinModules.map((name) => `node:${name}`)],
      },
    },
  };
});

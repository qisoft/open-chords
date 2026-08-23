import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { resolve } from "node:path";

import { defineConfig } from "vite";

const sidecarManifestPath = resolve(
  "dist/analysis-sidecar/open-chords-analysis/runtime-manifest.json",
);
const sidecarManifestHash = existsSync(sidecarManifestPath)
  ? createHash("sha256").update(readFileSync(sidecarManifestPath)).digest("hex")
  : "unavailable";

export default defineConfig({
  define: {
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
});

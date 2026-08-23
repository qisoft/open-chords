import { builtinModules } from "node:module";

import { defineConfig } from "vite";

export default defineConfig({
  build: {
    outDir: "dist/sidecar-proof",
    emptyOutDir: true,
    sourcemap: true,
    lib: {
      entry: "apps/desktop/src/main/packaged-sidecar-worker.ts",
      formats: ["cjs"],
      fileName: () => "packaged-sidecar-worker.cjs",
    },
    rolldownOptions: {
      external: [...builtinModules, ...builtinModules.map((name) => `node:${name}`)],
    },
  },
});

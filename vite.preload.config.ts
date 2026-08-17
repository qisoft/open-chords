import { builtinModules } from "node:module";

import { defineConfig } from "vite";

export default defineConfig({
  build: {
    outDir: "dist/preload",
    emptyOutDir: true,
    sourcemap: true,
    lib: {
      entry: "apps/desktop/src/preload/index.ts",
      formats: ["cjs"],
      fileName: () => "preload.cjs",
    },
    rolldownOptions: {
      external: ["electron", ...builtinModules, ...builtinModules.map((name) => `node:${name}`)],
    },
  },
});

import { builtinModules } from "node:module";

import { defineConfig } from "vite";

export default defineConfig({
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

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "apps/desktop/src/renderer",
  base: "./",
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "../../../../dist/renderer",
    emptyOutDir: true,
    assetsDir: "assets",
    sourcemap: false,
  },
});

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, posix } from "node:path";

import { z } from "zod";

const RendererManifestChunkSchema = z.strictObject({
  assets: z.array(z.string()).optional(),
  css: z.array(z.string()).optional(),
  dynamicImports: z.array(z.string()).optional(),
  file: z.string(),
  imports: z.array(z.string()).optional(),
  isDynamicEntry: z.boolean().optional(),
  isEntry: z.boolean().optional(),
  name: z.string().optional(),
  src: z.string().optional(),
});

const RendererManifestSchema = z.record(z.string(), RendererManifestChunkSchema);

function isSafeRelativeAsset(path: string): boolean {
  return (
    path.length > 0 &&
    !path.includes("\\") &&
    !isAbsolute(path) &&
    posix.normalize(path) === path &&
    !path.split("/").includes("..")
  );
}

export type RendererAssetManifest = {
  resolve(requestUrl: string): string | null;
};

export function loadRendererAssetManifest(rendererRoot: string): RendererAssetManifest {
  const manifest: unknown = JSON.parse(
    readFileSync(join(rendererRoot, "asset-manifest.json"), "utf8"),
  );
  const chunks = RendererManifestSchema.parse(manifest);
  const allowed = new Set(["index.html"]);

  for (const chunk of Object.values(chunks)) {
    for (const path of [chunk.file, ...(chunk.css ?? []), ...(chunk.assets ?? [])]) {
      if (!isSafeRelativeAsset(path)) throw new Error(`Unsafe renderer asset path: ${path}`);
      if (!existsSync(join(rendererRoot, path))) throw new Error(`Missing renderer asset: ${path}`);
      allowed.add(path);
    }
  }

  return {
    resolve(requestUrl) {
      let url: URL;
      try {
        url = new URL(requestUrl);
      } catch {
        return null;
      }
      if (
        url.protocol !== "open-chords:" ||
        url.host !== "app" ||
        url.username !== "" ||
        url.password !== "" ||
        url.port !== "" ||
        url.search !== ""
      ) {
        return null;
      }
      const path = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      return allowed.has(path) ? join(rendererRoot, path) : null;
    },
  };
}

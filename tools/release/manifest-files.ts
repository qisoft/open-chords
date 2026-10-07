import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { ReleaseManifestSchema, type ReleaseManifest } from "./release-manifest.ts";

export const MANIFEST_SUFFIX = ".release-manifest.json";

export async function readReleaseManifest(path: string): Promise<ReleaseManifest> {
  return ReleaseManifestSchema.parse(JSON.parse(await readFile(path, "utf8")));
}

export async function readReleaseManifests(directory: string): Promise<ReleaseManifest[]> {
  const names = (await readdir(directory)).filter((name) => name.endsWith(MANIFEST_SUFFIX));
  return Promise.all(names.toSorted().map((name) => readReleaseManifest(join(directory, name))));
}

export function serializeReleaseManifest(manifest: ReleaseManifest): string {
  return `${JSON.stringify(ReleaseManifestSchema.parse(manifest), null, 2)}\n`;
}

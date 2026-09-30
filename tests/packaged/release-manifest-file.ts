import { readFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { MANIFEST_SUFFIX, readReleaseManifest } from "../../tools/release/manifest-files.ts";
import {
  RELEASE_ASSETS_DIRECTORY,
  releaseAssetStem,
  releaseTargetFor,
} from "../../tools/release/release-target.ts";

export function releaseAssets() {
  const { version } = z
    .object({ version: z.string() })
    .parse(JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")));
  const target = releaseTargetFor(process.platform, process.arch);
  const directory = join(process.cwd(), RELEASE_ASSETS_DIRECTORY);
  const stem = releaseAssetStem(version, target);
  return {
    target,
    archivePath: join(directory, `${stem}.zip`),
    manifestPath: join(directory, `${stem}${MANIFEST_SUFFIX}`),
  };
}

export async function readStagedReleaseManifest() {
  return readReleaseManifest(releaseAssets().manifestPath);
}

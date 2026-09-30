import { execFileSync } from "node:child_process";
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { extractAll } from "@electron/asar";
import extractZip from "extract-zip";
import { z } from "zod";

import { measureDarwinSizes, measureWindowsSizes } from "./components.ts";
import { sha256File } from "./installed-tree.ts";
import { MANIFEST_SUFFIX, serializeReleaseManifest } from "./manifest-files.ts";
import { observeInstalledRelease } from "./observe-installed-release.ts";
import {
  DARWIN_CONTAINMENT,
  WINDOWS_CONTAINMENT,
  type ReleaseManifest,
} from "./release-manifest.ts";
import {
  forgeArchivePath,
  INSTALLED_LAYOUT,
  PRODUCT_NAME,
  RELEASE_ASSETS_DIRECTORY,
  releaseAssetStem,
  releaseTargetFor,
} from "./release-target.ts";

function buildProvenance(environment: NodeJS.ProcessEnv, root: string): ReleaseManifest["build"] {
  const commit =
    environment.GITHUB_SHA ??
    execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const { GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_SERVER_URL, ImageOS, ImageVersion } =
    environment;
  return {
    commit,
    workflowRunUrl:
      GITHUB_SERVER_URL && GITHUB_REPOSITORY && GITHUB_RUN_ID
        ? `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`
        : null,
    runnerImage: ImageOS && ImageVersion ? `${ImageOS}/${ImageVersion}` : null,
  };
}

export async function stageRelease(
  root: string,
  environment: NodeJS.ProcessEnv,
): Promise<{ manifest: ReleaseManifest; manifestPath: string }> {
  const target = releaseTargetFor(process.platform, process.arch);
  const { version } = z
    .object({ version: z.string() })
    .parse(JSON.parse(await readFile(join(root, "package.json"), "utf8")));
  const stem = releaseAssetStem(version, target);
  const assets = resolve(root, RELEASE_ASSETS_DIRECTORY);
  const scan = resolve(root, "out", "release", "scan", target.id);
  const installed = join(scan, "installed");
  const archiveName = `${stem}.zip`;
  const archive = join(assets, archiveName);

  await mkdir(assets, { recursive: true });
  const stale = (await readdir(assets)).filter((name) => name.startsWith(`${stem}.`));
  await Promise.all(stale.map((name) => rm(join(assets, name), { force: true })));
  await rm(scan, { force: true, recursive: true });
  await mkdir(installed, { recursive: true });

  await copyFile(forgeArchivePath(root, version, target), archive);
  await extractZip(archive, { dir: installed });
  extractAll(
    join(installed, INSTALLED_LAYOUT[target.platform].resources, "app.asar"),
    join(scan, "app-asar"),
  );

  const observation = await observeInstalledRelease(installed, target);
  const downloadBytes = (await stat(archive)).size;
  const common = {
    schemaVersion: 1,
    product: { name: PRODUCT_NAME, version },
    distribution: {
      channel: "unsigned-community",
      publisherSigning: "none",
      notarization: "none",
      automaticUpdates: "none",
      installation: "extract-zip",
    },
    build: buildProvenance(environment, root),
    archive: { fileName: archiveName, bytes: downloadBytes, sha256: await sha256File(archive) },
  } as const;
  const manifest: ReleaseManifest =
    target.platform === "darwin" && observation.platform === "darwin"
      ? {
          ...common,
          target,
          installed: observation,
          sizes: measureDarwinSizes(observation.entries, downloadBytes),
          containment: DARWIN_CONTAINMENT,
        }
      : target.platform === "win32" && observation.platform === "win32"
        ? {
            ...common,
            target,
            installed: observation,
            sizes: measureWindowsSizes(observation.entries, downloadBytes),
            containment: WINDOWS_CONTAINMENT,
          }
        : unreachablePlatform();
  const manifestPath = join(assets, `${stem}${MANIFEST_SUFFIX}`);
  await writeFile(manifestPath, serializeReleaseManifest(manifest));
  return { manifest, manifestPath };
}

function unreachablePlatform(): never {
  throw new Error("Installed observation platform differs from the release target");
}

import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { extractFile } from "@electron/asar";
import { expect, test } from "@playwright/test";
import extractZip from "extract-zip";

import { sha256File } from "../../tools/release/installed-tree.ts";
import { observeInstalledRelease } from "../../tools/release/observe-installed-release.ts";
import type { ReleaseManifest } from "../../tools/release/release-manifest.ts";
import { INSTALLED_LAYOUT } from "../../tools/release/release-target.ts";
import { readStagedReleaseManifest, releaseAssets } from "./release-manifest-file.ts";

test.skip(
  process.platform !== "darwin" && process.platform !== "win32",
  "Release artifacts target macOS and Windows only",
);

const EXPECTED_COMPONENTS = {
  darwin: [
    "analysis-sidecar",
    "alignment-runtime",
    "acquisition-runtime",
    "containment",
    "analysis-sidecar-resources-copy",
    "containment-resources-copy",
    "application",
    "notices",
    "electron-shell",
  ],
  win32: [
    "analysis-sidecar",
    "alignment-runtime",
    "acquisition-runtime",
    "containment",
    "application",
    "notices",
    "electron-shell",
  ],
} as const;
const UPDATE_MACHINERY = /(^|\/)(Update\.exe|app-update\.yml|dev-app-update\.yml)$/i;
const WINDOWS_SQUIRREL = /(^|\/)Squirrel[^/]*$/i;

let manifest: ReleaseManifest;
let freshRoot = "";

test.beforeAll(async () => {
  test.setTimeout(300_000);
  manifest = await readStagedReleaseManifest();
  freshRoot = realpathSync(mkdtempSync(join(tmpdir(), "open-chords-release-manifest-")));
  await extractZip(releaseAssets().archivePath, { dir: freshRoot });
});

test.afterAll(() => {
  if (freshRoot !== "") {
    rmSync(freshRoot, { force: true, maxRetries: 40, recursive: true, retryDelay: 250 });
  }
});

test("release asset is the archive the manifest describes", async () => {
  const { archivePath, target } = releaseAssets();

  expect(manifest.target).toEqual(target);
  expect({ bytes: statSync(archivePath).size, sha256: await sha256File(archivePath) }).toEqual({
    bytes: manifest.archive.bytes,
    sha256: manifest.archive.sha256,
  });
  expect(manifest.distribution).toEqual({
    channel: "unsigned-community",
    publisherSigning: "none",
    notarization: "none",
    automaticUpdates: "none",
    installation: "extract-zip",
  });
});

test("a fresh extraction matches every installed hash, fuse, anchor, and signature", async () => {
  test.setTimeout(900_000);

  expect(await observeInstalledRelease(freshRoot, releaseAssets().target)).toEqual(
    manifest.installed,
  );
  expect(manifest.installed.identity).toMatchObject({ productName: "Open Chords" });
  expect(manifest.installed.trustAnchors).toHaveLength(4);
});

test("published sizes add up and cover every declared component", () => {
  const { sizes } = manifest;
  const componentIds = sizes.components.map((component) => component.id);

  expect(componentIds).toEqual(EXPECTED_COMPONENTS[manifest.target.platform]);
  expect(sizes.components.filter((component) => component.bytes <= 0)).toEqual([]);
  expect({
    bytes: sizes.components.reduce((sum, component) => sum + component.bytes, 0),
    files: sizes.components.reduce((sum, component) => sum + component.files, 0),
    download: statSync(releaseAssets().archivePath).size,
  }).toEqual({
    bytes: sizes.installedBytes,
    files: sizes.installedFiles,
    download: sizes.downloadBytes,
  });
});

test("installed build carries no automatic update machinery", () => {
  const installed = manifest.installed;
  const mainBundle = extractFile(
    join(freshRoot, INSTALLED_LAYOUT[installed.platform].resources, "app.asar"),
    join("dist", "main", "main.cjs"),
  ).toString("utf8");
  const forbidden =
    installed.platform === "win32" ? [UPDATE_MACHINERY, WINDOWS_SQUIRREL] : [UPDATE_MACHINERY];

  expect(mainBundle).not.toContain("autoUpdater");
  expect(
    installed.entries.filter((entry) => forbidden.some((pattern) => pattern.test(entry.path))),
  ).toEqual([]);
});

test("macOS executables are ad hoc or unsigned with the declared entitlements", () => {
  const installed = manifest.installed;
  test.skip(installed.platform !== "darwin", "macOS bundle only");
  if (installed.platform !== "darwin") return;
  const layout = INSTALLED_LAYOUT.darwin;
  const entitlementsOf = (path: string) =>
    installed.executables.find((executable) => executable.path === path)?.entitlements;
  const service = `${layout.analysisService}/Contents/MacOS/open-chords-analysis-service`;

  expect(installed.bundleIdentifier).toBe("io.github.qisoft.open-chords");
  expect(entitlementsOf(layout.mainExecutable)).toEqual({
    "com.apple.security.cs.allow-jit": true,
    "com.apple.security.cs.disable-library-validation": true,
  });
  expect(entitlementsOf(service)).toMatchObject({ "com.apple.security.app-sandbox": true });
  expect(
    Object.keys(entitlementsOf(service) ?? {}).filter((key) =>
      key.startsWith("com.apple.security.network."),
    ),
  ).toEqual([]);
  expect(
    installed.executables.filter(
      (executable) => executable.signature !== "adhoc" && executable.signature !== "unsigned",
    ),
  ).toEqual([]);
  for (const bundle of [layout.applicationBundle, layout.analysisService]) {
    const verify = spawnSync("codesign", ["--verify", "--strict", join(freshRoot, bundle)], {
      encoding: "utf8",
    });
    expect(verify.status, `${bundle}: ${verify.stderr}`).toBe(0);
  }
  const stapler = spawnSync(
    "xcrun",
    ["stapler", "validate", join(freshRoot, layout.applicationBundle)],
    { encoding: "utf8" },
  );
  expect(stapler.status, `${stapler.stdout}${stapler.stderr}`).not.toBe(0);
});

test("Windows executables carry no Authenticode signature and runtimes keep AppContainer", () => {
  const installed = manifest.installed;
  test.skip(installed.platform !== "win32", "Windows layout only");
  if (installed.platform !== "win32") return;
  const facts = (path: string) =>
    installed.executables.find((executable) => executable.path === path);

  expect(facts("Open Chords.exe")).toEqual({
    path: "Open Chords.exe",
    authenticodeSigned: false,
    appContainerImage: false,
  });
  expect(
    facts("resources/containment/open-chords-containment-launcher.exe")?.authenticodeSigned,
  ).toBe(false);
  expect(
    [
      "resources/open-chords-acquisition/open-chords-extractor-worker.exe",
      "resources/open-chords-acquisition/deno.exe",
    ].map((path) => facts(path)?.appContainerImage),
  ).toEqual([true, true]);
});

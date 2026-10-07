import { join } from "node:path";

export const RELEASE_TARGETS = [
  { id: "macos-arm64", platform: "darwin", arch: "arm64" },
  { id: "windows-x64", platform: "win32", arch: "x64" },
] as const;

export type ReleaseTarget = (typeof RELEASE_TARGETS)[number];
export type ReleasePlatform = ReleaseTarget["platform"];

export const PRODUCT_NAME = "Open Chords";

export function releaseTargetFor(platform: string, arch: string): ReleaseTarget {
  const target = RELEASE_TARGETS.find(
    (candidate) => candidate.platform === platform && candidate.arch === arch,
  );
  if (target === undefined) {
    throw new Error(`No official release target for ${platform}-${arch}`);
  }
  return target;
}

export const RELEASE_ASSETS_DIRECTORY = join("out", "release", "assets");

export function releaseAssetStem(version: string, target: ReleaseTarget): string {
  return `open-chords-${version}-${target.id}`;
}

export function forgeArchivePath(root: string, version: string, target: ReleaseTarget): string {
  return join(
    root,
    "out",
    "make",
    "zip",
    target.platform,
    target.arch,
    `${PRODUCT_NAME}-${target.platform}-${target.arch}-${version}.zip`,
  );
}

const DARWIN_CONTENTS = `${PRODUCT_NAME}.app/Contents`;
const DARWIN_SERVICE = `${DARWIN_CONTENTS}/XPCServices/OpenChordsAnalysisService.xpc`;

export const INSTALLED_LAYOUT = {
  darwin: {
    applicationBundle: `${PRODUCT_NAME}.app`,
    analysisService: DARWIN_SERVICE,
    infoPlist: `${DARWIN_CONTENTS}/Info.plist`,
    mainExecutable: `${DARWIN_CONTENTS}/MacOS/${PRODUCT_NAME}`,
    resources: `${DARWIN_CONTENTS}/Resources`,
    trustAnchors: [
      `${DARWIN_SERVICE}/Contents/Resources/open-chords-analysis/runtime-manifest.json`,
      `${DARWIN_CONTENTS}/Resources/containment/containment-manifest.json`,
      `${DARWIN_SERVICE}/Contents/Resources/open-chords-alignment/runtime-info.json`,
      `${DARWIN_SERVICE}/Contents/Resources/open-chords-acquisition/runtime-info.json`,
    ],
  },
  win32: {
    mainExecutable: `${PRODUCT_NAME}.exe`,
    resources: "resources",
    trustAnchors: [
      "resources/open-chords-analysis/runtime-manifest.json",
      "resources/containment/containment-manifest.json",
      "resources/open-chords-alignment/runtime-info.json",
      "resources/open-chords-acquisition/runtime-info.json",
    ],
  },
} as const;

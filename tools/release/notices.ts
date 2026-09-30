import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  collectJavaScriptPackages,
  renderJavaScriptPackageNotices,
} from "./javascript-package-notices.ts";

const DARWIN_SERVICE_RESOURCES =
  "Open Chords.app/Contents/XPCServices/OpenChordsAnalysisService.xpc/Contents/Resources";

function runtimeNoticeFolders(platform: string) {
  const root = platform === "darwin" ? DARWIN_SERVICE_RESOURCES : "resources";
  return [
    ["Analysis sidecar", `${root}/open-chords-analysis/licenses/`],
    ["Alignment runtime", `${root}/open-chords-alignment/notices/`],
    ["Acquisition runtime", `${root}/open-chords-acquisition/notices/`],
  ] as const;
}

export function renderNoticesReadme(platform: string): string {
  const notices =
    platform === "darwin" ? "Open Chords.app/Contents/Resources/notices/" : "resources/notices/";
  return [
    "Open Chords third-party notices",
    "",
    "This is an unsigned community build of Open Chords. It is not notarized, it is not",
    "publisher-signed, and it never updates automatically.",
    "",
    `Files in ${notices}:`,
    "  OPEN-CHORDS-LICENSE.txt  The Open Chords license (AGPL-3.0-only).",
    "  ELECTRON-LICENSE.txt     The Electron license.",
    "  CHROMIUM-LICENSES.html   Licenses of Chromium and its components, shipped with Electron.",
    "  JAVASCRIPT-PACKAGES.txt  License texts of every JavaScript package inside app.asar.",
    "",
    "Notices of the bundled native runtimes, relative to the extracted download:",
    ...runtimeNoticeFolders(platform).map(([runtime, folder]) => `  ${runtime}: ${folder}`),
    "",
  ].join("\n");
}

export function writeReleaseNotices(options: {
  readonly buildPath: string;
  readonly platform: string;
  readonly repositoryRoot: string;
}): void {
  const notices = resolve(options.buildPath, "..", "notices");
  const electron = join(options.repositoryRoot, "node_modules", "electron", "dist");
  rmSync(notices, { force: true, recursive: true });
  mkdirSync(notices);
  copyFileSync(join(options.repositoryRoot, "LICENSE"), join(notices, "OPEN-CHORDS-LICENSE.txt"));
  copyFileSync(join(electron, "LICENSE"), join(notices, "ELECTRON-LICENSE.txt"));
  copyFileSync(join(electron, "LICENSES.chromium.html"), join(notices, "CHROMIUM-LICENSES.html"));
  writeFileSync(
    join(notices, "JAVASCRIPT-PACKAGES.txt"),
    renderJavaScriptPackageNotices(
      collectJavaScriptPackages(join(options.buildPath, "node_modules")),
    ),
  );
  writeFileSync(join(notices, "README.txt"), renderNoticesReadme(options.platform));
}

import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

const require = createRequire(import.meta.url);

it("installs macOS containment in the host executable domain", () => {
  const root = mkdtempSync(join(tmpdir(), "open-chords-forge-packaging-"));
  const application = join(root, "Open Chords.app");
  const buildPath = join(application, "Contents", "Resources", "app");
  const containment = join(root, "containment");
  const service = join(containment, "OpenChordsAnalysisService.xpc");
  const runtime = join(root, "open-chords-analysis");
  mkdirSync(join(service, "Contents"), { recursive: true });
  mkdirSync(buildPath, { recursive: true });
  writeFileSync(join(service, "Contents", "Info.plist"), "signed-service");
  writeFileSync(join(containment, "open-chords-containment-bridge"), "signed-bridge");
  mkdirSync(runtime);
  writeFileSync(join(runtime, "open-chords-analysis"), "signed-runtime");

  const packagingModule: unknown = require("../tools/forge-packaging.cjs");
  if (typeof packagingModule !== "object" || packagingModule === null) {
    throw new TypeError("Forge packaging module is unavailable");
  }
  const install = Reflect.get(packagingModule, "installStagedMacOSContainment");
  if (typeof install !== "function") throw new TypeError("macOS packaging hook is unavailable");
  let signedService = "";
  Reflect.apply(install, undefined, [
    {},
    buildPath,
    "43.4.0",
    "darwin",
    containment,
    runtime,
    "/fixtures/service-entitlements.plist",
    (path: string) => {
      signedService = path;
    },
  ]);

  expect(
    readFileSync(
      join(
        application,
        "Contents",
        "XPCServices",
        "OpenChordsAnalysisService.xpc",
        "Contents",
        "Info.plist",
      ),
      "utf8",
    ),
  ).toBe("signed-service");
  expect(
    readFileSync(
      join(
        application,
        "Contents",
        "XPCServices",
        "OpenChordsAnalysisService.xpc",
        "Contents",
        "Resources",
        "open-chords-analysis",
        "open-chords-analysis",
      ),
      "utf8",
    ),
  ).toBe("signed-runtime");
  expect(signedService).toBe(
    join(application, "Contents", "XPCServices", "OpenChordsAnalysisService.xpc"),
  );
  expect(
    readFileSync(
      join(application, "Contents", "MacOS", "containment", "open-chords-containment-bridge"),
      "utf8",
    ),
  ).toBe("signed-bridge");
  expect(
    readFileSync(join(application, "Contents", "MacOS", "open-chords-containment-bridge"), "utf8"),
  ).toBe("signed-bridge");
});

it("scopes unsigned library compatibility to Electron process bundles", () => {
  const packagingModule: unknown = require("../tools/forge-packaging.cjs");
  if (typeof packagingModule !== "object" || packagingModule === null) {
    throw new TypeError("Forge packaging module is unavailable");
  }
  const needsEntitlement = Reflect.get(
    packagingModule,
    "needsUnsignedLibraryValidationEntitlement",
  );
  if (typeof needsEntitlement !== "function") {
    throw new TypeError("macOS app filter is unavailable");
  }

  expect(Reflect.apply(needsEntitlement, undefined, ["/output/Open Chords.app"])).toBe(true);
  expect(
    Reflect.apply(needsEntitlement, undefined, [
      "/output/Open Chords.app/Contents/Frameworks/Open Chords Helper.app",
    ]),
  ).toBe(true);
  expect(
    Reflect.apply(needsEntitlement, undefined, [
      "/output/Open Chords.app/Contents/Frameworks/Open Chords Helper (Renderer).app",
    ]),
  ).toBe(true);
  expect(
    Reflect.apply(needsEntitlement, undefined, [
      "/output/Open Chords.app/Contents/Frameworks/Open Chords Helper (Plugin).app",
    ]),
  ).toBe(false);
  expect(
    Reflect.apply(needsEntitlement, undefined, [
      "/output/Open Chords.app/Contents/XPCServices/OpenChordsAnalysisService.xpc",
    ]),
  ).toBe(false);
});

it("preserves separately signed and hashed containment payloads", () => {
  const packagingModule: unknown = require("../tools/forge-packaging.cjs");
  if (typeof packagingModule !== "object" || packagingModule === null) {
    throw new TypeError("Forge packaging module is unavailable");
  }
  const ignores = Reflect.get(packagingModule, "isPreverifiedContainmentPath");
  if (typeof ignores !== "function") throw new TypeError("macOS signing filter is unavailable");

  expect(
    Reflect.apply(ignores, undefined, [
      "/Open Chords.app/Contents/Resources/open-chords-analysis/open-chords-analysis",
    ]),
  ).toBe(true);
  expect(
    Reflect.apply(ignores, undefined, [
      "/Open Chords.app/Contents/MacOS/containment/open-chords-containment-bridge",
    ]),
  ).toBe(true);
  expect(
    Reflect.apply(ignores, undefined, [
      "/Open Chords.app/Contents/MacOS/open-chords-containment-bridge",
    ]),
  ).toBe(true);
  expect(
    Reflect.apply(ignores, undefined, [
      "/Open Chords.app/Contents/XPCServices/OpenChordsAnalysisService.xpc/Contents/MacOS/service",
    ]),
  ).toBe(true);
  expect(
    Reflect.apply(ignores, undefined, [
      "/Open Chords.app/Contents/Frameworks/Open Chords Helper.app",
    ]),
  ).toBe(false);
});

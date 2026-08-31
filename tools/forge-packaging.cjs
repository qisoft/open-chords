const { execFileSync } = require("node:child_process");
const { cpSync, mkdirSync } = require("node:fs");
const { join, resolve } = require("node:path");

function installStagedMacOSContainment(
  _forgeConfig,
  buildPath,
  _electronVersion,
  platform,
  containmentSource,
  runtimeSource,
  serviceEntitlements,
  signService = signMacOSService,
) {
  if (platform !== "darwin") return;
  const contents = resolve(buildPath, "..", "..");
  const services = join(contents, "XPCServices");
  mkdirSync(services, { recursive: true });
  cpSync(
    join(containmentSource, "OpenChordsAnalysisService.xpc"),
    join(services, "OpenChordsAnalysisService.xpc"),
    { recursive: true },
  );
  const service = join(services, "OpenChordsAnalysisService.xpc");
  cpSync(runtimeSource, join(service, "Contents", "Resources", "open-chords-analysis"), {
    recursive: true,
  });
  signService(service, serviceEntitlements);
  cpSync(containmentSource, join(contents, "MacOS", "containment"), {
    recursive: true,
  });
  cpSync(
    join(containmentSource, "open-chords-containment-bridge"),
    join(contents, "MacOS", "open-chords-containment-bridge"),
  );
}

function signMacOSService(service, entitlements) {
  execFileSync("codesign", ["--force", "--sign", "-", "--entitlements", entitlements, service]);
  execFileSync("codesign", ["--verify", "--strict", service]);
}

function isTopLevelApplicationBundle(path) {
  return path.endsWith(".app") && !path.includes(".app/");
}

function needsUnsignedLibraryValidationEntitlement(path) {
  return (
    isTopLevelApplicationBundle(path) ||
    (path.endsWith(".app") &&
      path.includes("/Contents/Frameworks/Open Chords Helper") &&
      !path.endsWith("Helper (Plugin).app"))
  );
}

function isPreverifiedContainmentPath(path) {
  return (
    path.includes("/Contents/Resources/open-chords-analysis/") ||
    path.includes("/Contents/Resources/containment/") ||
    path.includes("/Contents/MacOS/containment/") ||
    path.endsWith("/Contents/MacOS/open-chords-containment-bridge") ||
    path.includes("/Contents/XPCServices/OpenChordsAnalysisService.xpc/")
  );
}

module.exports = {
  installStagedMacOSContainment,
  isPreverifiedContainmentPath,
  needsUnsignedLibraryValidationEntitlement,
};

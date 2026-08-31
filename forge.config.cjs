const { spawn } = require("node:child_process");
const { join } = require("node:path");

const { MakerZIP } = require("@electron-forge/maker-zip");
const { FusesPlugin } = require("@electron-forge/plugin-fuses");
const { FuseV1Options, FuseVersion } = require("@electron/fuses");

const {
  installStagedMacOSContainment,
  isPreverifiedContainmentPath,
  needsUnsignedLibraryValidationEntitlement,
} = require("./tools/forge-packaging.cjs");

function buildApplication() {
  return new Promise((resolve, reject) => {
    const command = process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "pnpm";
    const commandArguments =
      process.platform === "win32" ? ["/d", "/s", "/c", "pnpm", "run", "build"] : ["run", "build"];
    const child = spawn(command, commandArguments, {
      stdio: "inherit",
      shell: false,
    });

    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Application build exited with code ${String(code)}`));
      }
    });
  });
}

module.exports = {
  packagerConfig: {
    appBundleId: "io.github.qisoft.open-chords",
    asar: true,
    extraResource: ["dist/analysis-sidecar/open-chords-analysis", "dist/containment"],
    osxSign: {
      identity: "-",
      identityValidation: false,
      ignore: isPreverifiedContainmentPath,
      optionsForFile: (filePath) =>
        needsUnsignedLibraryValidationEntitlement(filePath)
          ? {
              entitlements: join(
                __dirname,
                "native",
                "macos",
                "unsigned-application.entitlements.plist",
              ),
            }
          : {},
      preAutoEntitlements: false,
    },
  },
  rebuildConfig: {},
  makers: [new MakerZIP({}, ["darwin", "win32"])],
  hooks: {
    generateAssets: buildApplication,
    packageAfterCopy: async (forgeConfig, buildPath, electronVersion, platform) => {
      installStagedMacOSContainment(
        forgeConfig,
        buildPath,
        electronVersion,
        platform,
        join(__dirname, "dist", "containment"),
        join(__dirname, "dist", "analysis-sidecar", "open-chords-analysis"),
        join(__dirname, "native", "macos", "analysis-service.entitlements.plist"),
      );
    },
  },
  plugins: [
    new FusesPlugin({
      version: FuseVersion.V1,
      resetAdHocDarwinSignature: true,
      strictlyRequireAllFuses: true,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
      [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
      [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
      [FuseV1Options.WasmTrapHandlers]: true,
    }),
  ],
};

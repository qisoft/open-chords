import type {
  DarwinReleaseManifest,
  WindowsReleaseManifest,
} from "../../tools/release/release-manifest.ts";

const DIGEST = "a".repeat(64);

const fuses = {
  version: "1",
  options: {
    RunAsNode: "disable",
    EnableCookieEncryption: "enable",
    EnableNodeOptionsEnvironmentVariable: "disable",
    EnableNodeCliInspectArguments: "disable",
    EnableEmbeddedAsarIntegrityValidation: "enable",
    OnlyLoadAppFromAsar: "enable",
    LoadBrowserProcessSpecificV8Snapshot: "disable",
    GrantFileProtocolExtraPrivileges: "disable",
    WasmTrapHandlers: "enable",
  },
} as const;

const common = {
  schemaVersion: 1,
  product: { name: "Open Chords", version: "0.0.0" },
  distribution: {
    channel: "unsigned-community",
    publisherSigning: "none",
    notarization: "none",
    automaticUpdates: "none",
    installation: "extract-zip",
  },
  build: { commit: "f".repeat(40), workflowRunUrl: null, runnerImage: null },
} as const;

export function darwinManifestFixture(archive: DarwinReleaseManifest["archive"]) {
  const executable = "Open Chords.app/Contents/MacOS/Open Chords";
  return {
    ...common,
    target: { id: "macos-arm64", platform: "darwin", arch: "arm64" },
    archive,
    installed: {
      platform: "darwin",
      entries: [
        { path: executable, kind: "file", bytes: 3, sha256: DIGEST, executable: true },
        {
          path: "Open Chords.app/Contents/Frameworks/Squirrel.framework/Squirrel",
          kind: "symlink",
          target: "Versions/Current/Squirrel",
        },
      ],
      identity: { packageName: "open-chords", productName: "Open Chords", version: "0.0.0" },
      fuses,
      trustAnchors: [],
      bundleIdentifier: "io.github.qisoft.open-chords",
      executables: [
        {
          path: executable,
          signature: "adhoc",
          teamIdentifier: null,
          entitlements: { "com.apple.security.cs.allow-jit": true },
        },
      ],
    },
    sizes: {
      downloadBytes: archive.bytes,
      installedBytes: 3,
      installedFiles: 2,
      longestPathCharacters: 62,
      components: [
        { id: "analysis-sidecar", bytes: 0, files: 0 },
        { id: "electron-shell", bytes: 3, files: 2 },
      ],
    },
    containment: {
      backend: "macos-xpc-app-sandbox",
      evidence: {
        appSandbox: true,
        backend: "macos-xpc-app-sandbox",
        helperInheritance: true,
        networkClient: false,
        networkServer: false,
      },
    },
  } satisfies DarwinReleaseManifest;
}

export function windowsManifestFixture(archive: WindowsReleaseManifest["archive"]) {
  return {
    ...common,
    target: { id: "windows-x64", platform: "win32", arch: "x64" },
    archive,
    installed: {
      platform: "win32",
      entries: [
        { path: "Open Chords.exe", kind: "file", bytes: 5, sha256: DIGEST, executable: false },
      ],
      identity: { packageName: "open-chords", productName: "Open Chords", version: "0.0.0" },
      fuses,
      trustAnchors: [],
      executables: [
        { path: "Open Chords.exe", authenticodeSigned: false, appContainerImage: false },
      ],
    },
    sizes: {
      downloadBytes: archive.bytes,
      installedBytes: 5,
      installedFiles: 1,
      longestPathCharacters: 15,
      components: [{ id: "electron-shell", bytes: 5, files: 1 }],
    },
    containment: {
      backend: "windows-appcontainer-job",
      evidence: {
        appContainer: true,
        backend: "windows-appcontainer-job",
        breakawayDisabled: true,
        jobObject: true,
        networkCapabilityCount: 0,
      },
    },
  } satisfies WindowsReleaseManifest;
}

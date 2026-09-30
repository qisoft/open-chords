import { z } from "zod";

import { PRODUCT_NAME } from "./release-target.ts";

export const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const ByteCountSchema = z.number().int().nonnegative();
export const InstalledPathSchema = z
  .string()
  .min(1)
  .refine(
    (path) =>
      !path.startsWith("/") &&
      !path.includes("\\") &&
      path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."),
    "Installed paths are relative POSIX paths inside the extraction root",
  );

export const FUSE_OPTION_NAMES = [
  "RunAsNode",
  "EnableCookieEncryption",
  "EnableNodeOptionsEnvironmentVariable",
  "EnableNodeCliInspectArguments",
  "EnableEmbeddedAsarIntegrityValidation",
  "OnlyLoadAppFromAsar",
  "LoadBrowserProcessSpecificV8Snapshot",
  "GrantFileProtocolExtraPrivileges",
  "WasmTrapHandlers",
] as const;
export const FuseStateNameSchema = z.enum(["enable", "disable", "removed", "inherit"]);

export const DARWIN_COMPONENT_IDS = [
  "analysis-sidecar",
  "alignment-runtime",
  "acquisition-runtime",
  "containment",
  "analysis-sidecar-resources-copy",
  "containment-resources-copy",
  "application",
  "notices",
  "electron-shell",
] as const;
export const WINDOWS_COMPONENT_IDS = [
  "analysis-sidecar",
  "alignment-runtime",
  "acquisition-runtime",
  "containment",
  "application",
  "notices",
  "electron-shell",
] as const;

const InstalledEntrySchema = z.discriminatedUnion("kind", [
  z.strictObject({
    path: InstalledPathSchema,
    kind: z.literal("file"),
    bytes: ByteCountSchema,
    sha256: Sha256Schema,
    executable: z.boolean(),
  }),
  z.strictObject({ path: InstalledPathSchema, kind: z.literal("symlink"), target: z.string() }),
]);
export type InstalledEntry = z.infer<typeof InstalledEntrySchema>;

const commonInstalled = {
  entries: z.array(InstalledEntrySchema),
  identity: z.strictObject({
    packageName: z.string(),
    productName: z.string(),
    version: z.string(),
  }),
  fuses: z.strictObject({
    version: z.literal("1"),
    options: z.record(z.enum(FUSE_OPTION_NAMES), FuseStateNameSchema),
  }),
  trustAnchors: z.array(z.strictObject({ path: InstalledPathSchema, sha256: Sha256Schema })),
};

const DarwinExecutableSchema = z.strictObject({
  path: InstalledPathSchema,
  signature: z.enum(["adhoc", "unsigned"]),
  teamIdentifier: z.null(),
  entitlements: z.record(z.string(), z.json()),
});
export type DarwinExecutable = z.infer<typeof DarwinExecutableSchema>;

const WindowsExecutableSchema = z.strictObject({
  path: InstalledPathSchema,
  authenticodeSigned: z.boolean(),
  appContainerImage: z.boolean(),
});
export type WindowsExecutable = z.infer<typeof WindowsExecutableSchema>;

const DarwinInstalledSchema = z.strictObject({
  platform: z.literal("darwin"),
  ...commonInstalled,
  bundleIdentifier: z.string(),
  executables: z.array(DarwinExecutableSchema),
});
const WindowsInstalledSchema = z.strictObject({
  platform: z.literal("win32"),
  ...commonInstalled,
  executables: z.array(WindowsExecutableSchema),
});
export const InstalledObservationSchema = z.discriminatedUnion("platform", [
  DarwinInstalledSchema,
  WindowsInstalledSchema,
]);
export type InstalledObservation = z.infer<typeof InstalledObservationSchema>;

function sizesSchema<const Ids extends readonly [string, ...string[]]>(ids: Ids) {
  return z.strictObject({
    downloadBytes: ByteCountSchema,
    installedBytes: ByteCountSchema,
    installedFiles: ByteCountSchema,
    longestPathCharacters: ByteCountSchema,
    components: z.array(
      z.strictObject({ id: z.enum(ids), bytes: ByteCountSchema, files: ByteCountSchema }),
    ),
  });
}

const common = {
  schemaVersion: z.literal(1),
  product: z.strictObject({ name: z.literal(PRODUCT_NAME), version: z.string().min(1) }),
  distribution: z.strictObject({
    channel: z.literal("unsigned-community"),
    publisherSigning: z.literal("none"),
    notarization: z.literal("none"),
    automaticUpdates: z.literal("none"),
    installation: z.literal("extract-zip"),
  }),
  build: z.strictObject({
    commit: z.string().regex(/^[0-9a-f]{40}$/),
    workflowRunUrl: z.string().nullable(),
    runnerImage: z.string().nullable(),
  }),
  archive: z.strictObject({
    fileName: z.string().regex(/^[A-Za-z0-9._-]+\.zip$/),
    bytes: ByteCountSchema,
    sha256: Sha256Schema,
  }),
};

const DarwinContainmentSchema = z.strictObject({
  backend: z.literal("macos-xpc-app-sandbox"),
  evidence: z.strictObject({
    appSandbox: z.literal(true),
    backend: z.literal("macos-xpc-app-sandbox"),
    helperInheritance: z.literal(true),
    networkClient: z.literal(false),
    networkServer: z.literal(false),
  }),
});
const WindowsContainmentSchema = z.strictObject({
  backend: z.literal("windows-appcontainer-job"),
  evidence: z.strictObject({
    appContainer: z.literal(true),
    backend: z.literal("windows-appcontainer-job"),
    breakawayDisabled: z.literal(true),
    jobObject: z.literal(true),
    networkCapabilityCount: z.literal(0),
  }),
});

export const DARWIN_CONTAINMENT = {
  backend: "macos-xpc-app-sandbox",
  evidence: {
    appSandbox: true,
    backend: "macos-xpc-app-sandbox",
    helperInheritance: true,
    networkClient: false,
    networkServer: false,
  },
} as const satisfies z.infer<typeof DarwinContainmentSchema>;
export const WINDOWS_CONTAINMENT = {
  backend: "windows-appcontainer-job",
  evidence: {
    appContainer: true,
    backend: "windows-appcontainer-job",
    breakawayDisabled: true,
    jobObject: true,
    networkCapabilityCount: 0,
  },
} as const satisfies z.infer<typeof WindowsContainmentSchema>;

export const ReleaseManifestSchema = z.union([
  z.strictObject({
    ...common,
    target: z.strictObject({
      id: z.literal("macos-arm64"),
      platform: z.literal("darwin"),
      arch: z.literal("arm64"),
    }),
    installed: DarwinInstalledSchema,
    sizes: sizesSchema(DARWIN_COMPONENT_IDS),
    containment: DarwinContainmentSchema,
  }),
  z.strictObject({
    ...common,
    target: z.strictObject({
      id: z.literal("windows-x64"),
      platform: z.literal("win32"),
      arch: z.literal("x64"),
    }),
    installed: WindowsInstalledSchema,
    sizes: sizesSchema(WINDOWS_COMPONENT_IDS),
    containment: WindowsContainmentSchema,
  }),
]);
export type ReleaseManifest = z.infer<typeof ReleaseManifestSchema>;
export type DarwinReleaseManifest = Extract<ReleaseManifest, { target: { platform: "darwin" } }>;
export type WindowsReleaseManifest = Extract<ReleaseManifest, { target: { platform: "win32" } }>;

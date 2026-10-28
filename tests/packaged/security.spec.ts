import { execFile as runNativeFile, spawn } from "node:child_process";
import { createHash as createNativeSelectionHash } from "node:crypto";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { extractFile, listPackage } from "@electron/asar";
import { FuseState, FuseV1Options, getCurrentFuseWire } from "@electron/fuses";
import { ProjectEnvelopeSchema } from "@open-chords/contracts";
import {
  canonicalSerialize,
  captureJsonExport,
  serializeJsonExport,
  projectLrc,
  projectLeadSheet,
  serializeChordPro,
} from "@open-chords/domain";
import { monoPcmWav } from "@open-chords/testkit/media";
import { expect, test } from "@playwright/test";
import extractZip from "extract-zip";
import { z } from "zod";

import { LocalMediaService } from "../../apps/desktop/src/main/local-media.ts";
import { openNetworkMode } from "../../apps/desktop/src/main/network-mode.ts";
import { openOfflineMediaCache } from "../../apps/desktop/src/main/offline-media-cache.ts";
import { proofTreeHashes } from "../../apps/desktop/src/main/packaged-proof-tree.ts";
import { PACKAGED_SIDECAR_PROOF_ARGUMENT } from "../../apps/desktop/src/main/packaged-sidecar-proof-constants.ts";
import { CONTAINMENT_EVIDENCE_LINE_PREFIX } from "../../apps/desktop/src/main/packaged-sidecar-proof-evidence.ts";
import { throwCombinedFailures } from "../../apps/desktop/src/main/packaged-sidecar-proof-failures.ts";
import {
  archivedProjectFor,
  writePortableProjectArchive,
} from "../../apps/desktop/src/main/project-archive-format.ts";
import { inspectPortableProjectArchive } from "../../apps/desktop/src/main/project-archive-inspection.ts";
import { openProjectLibrary } from "../../apps/desktop/src/main/project-library.ts";
import { goldenRecords } from "../support/editor-fixture.ts";
import { leadSheetProject } from "../support/export-fixture.ts";
import { installedCdpExceptionDiagnostic } from "../support/installed-cdp-diagnostics.ts";
import { installedCspFrameTreeDiagnostic } from "../support/installed-csp-frame-diagnostic.ts";
import {
  installedEffectiveCspDiagnostic,
  installedCspInterruptionDiagnostic,
} from "../support/installed-effective-csp-diagnostics.ts";
import { installedMacPickerDriver } from "../support/installed-macos-picker-driver.ts";
import { installedRendererExpression } from "../support/installed-renderer-expression.ts";
import {
  installedSaveDriverDiagnostic,
  installedSaveDriverTiming,
} from "../support/installed-save-diagnostics.ts";
import {
  WorkspacePlaybackProbeSchema,
  workspacePlaybackDiagnostic,
} from "../support/installed-workspace-playback-diagnostics.ts";
import { PDF_GOLDEN_SHA256, PDF_GOLDEN_LOSSES } from "../support/pdf-golden.ts";
import { readStagedReleaseManifest } from "./release-manifest-file.ts";

test.skip(
  process.platform !== "darwin" && process.platform !== "win32",
  "Installed native profiles support macOS and Windows only",
);

const PRODUCT_NAME = "Open Chords";
const INSTALLED_STARTUP_TIMEOUT_MS = process.platform === "win32" ? 120_000 : 30_000;
const EXPECTED_RENDERER_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'self'",
  "media-src 'self'",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");
const archivePath = join(
  process.cwd(),
  "out",
  "make",
  "zip",
  process.platform,
  process.arch,
  `${PRODUCT_NAME}-${process.platform}-${process.arch}-0.0.0.zip`,
);
const packageRoot = realpathSync(mkdtempSync(join(tmpdir(), "open-chords-installed-")));
const userDataDirectory = join(packageRoot, "user-data");
const executablePath =
  process.platform === "darwin"
    ? join(packageRoot, `${PRODUCT_NAME}.app`, "Contents", "MacOS", PRODUCT_NAME)
    : join(packageRoot, `${PRODUCT_NAME}${process.platform === "win32" ? ".exe" : ""}`);
const resourcesPath =
  process.platform === "darwin"
    ? join(packageRoot, `${PRODUCT_NAME}.app`, "Contents", "Resources")
    : join(packageRoot, "resources");
let packagedProjectId = "";

test.beforeAll(async () => {
  test.setTimeout(120000);
  await extractZip(archivePath, { dir: packageRoot });
  const mediaPath = join(packageRoot, "offline-playback.wav");
  const samples = Array.from({ length: 48_000 }, (_value, index) =>
    Math.round(Math.sin(index / 12) * 1_000),
  );
  writeFileSync(mediaPath, monoPcmWav(samples));
  const library = await openProjectLibrary({ stateRoot: userDataDirectory });
  const media = new LocalMediaService({
    library,
    pickFile: async () => mediaPath,
  });
  media.activateGeneration("generation_packaged_seed");
  const selected = await media.pickLocalFile("generation_packaged_seed");
  if (selected.kind !== "selected") throw new Error("Packaged media fixture was not selected");
  const created = await media.createProject({
    capabilityId: selected.capabilityId,
    endSourceSample: samples.length,
    generationId: "generation_packaged_seed",
    startSourceSample: 0,
  });
  packagedProjectId = created.projectId;
  await media.revokeGeneration("generation_packaged_seed");
});

test.afterAll(() => {
  rmSync(packageRoot, {
    force: true,
    maxRetries: 40,
    recursive: true,
    retryDelay: 250,
  });
});

test("packaged shell flips every security fuse explicitly", async () => {
  const files = listPackage(join(resourcesPath, "app.asar"), { isPack: false }).map((file) =>
    file.replaceAll("\\", "/"),
  );
  expect(new Set(files.map((file) => file.split("/")[1]))).toEqual(
    new Set(["LICENSE", "dist", "node_modules", "package.json"]),
  );
  expect(
    new Set(files.filter((file) => file.startsWith("/dist/")).map((file) => file.split("/")[2])),
  ).toEqual(new Set(["main", "preload", "renderer"]));
  const wire = await getCurrentFuseWire(executablePath);

  expect(wire).toMatchObject({
    [FuseV1Options.EnableCookieEncryption]: FuseState.ENABLE,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: FuseState.ENABLE,
    [FuseV1Options.EnableNodeCliInspectArguments]: FuseState.DISABLE,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: FuseState.DISABLE,
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: FuseState.DISABLE,
    [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: FuseState.DISABLE,
    [FuseV1Options.OnlyLoadAppFromAsar]: FuseState.ENABLE,
    [FuseV1Options.RunAsNode]: FuseState.DISABLE,
    [FuseV1Options.WasmTrapHandlers]: FuseState.ENABLE,
    version: "1",
  });
});

test("installed artifact runs contained analysis, publishes Revisions, and reaps", async () => {
  test.setTimeout(300_000);
  const proof = spawn(executablePath, [PACKAGED_SIDECAR_PROOF_ARGUMENT], {
    cwd: packageRoot,
    env: {},
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let output = "";
  let evidenceTranscript = "";
  const capture = (chunk: Buffer) => {
    output = `${output}${chunk.toString("utf8")}`.slice(-64 * 1024);
  };
  proof.stdout.on("data", capture);
  proof.stderr.on("data", capture);
  proof.stderr.on("data", (chunk: Buffer) => {
    evidenceTranscript = `${evidenceTranscript}${chunk.toString("utf8")}`;
  });

  const exit = await waitForApplicationExit(proof, 290_000).finally(() => {
    process.stdout.write(output);
  });
  expect(exit, output).toEqual({ code: 0, signal: null });
  expect(output).toContain("Packaged sidecar proof stage: publication_completed");
  const evidenceLine = evidenceTranscript
    .split(/\r?\n/)
    .find((line) => line.startsWith(CONTAINMENT_EVIDENCE_LINE_PREFIX));
  expect(evidenceLine, "containment evidence was reported").toBeDefined();
  expect(JSON.parse(evidenceLine!.slice(CONTAINMENT_EVIDENCE_LINE_PREFIX.length))).toEqual(
    (await readStagedReleaseManifest()).containment.evidence,
  );
});

test("installed editor and practice save through named IPC with a durable reopened result", async () => {
  test.setTimeout(60_000);
  const stateRoot = join(packageRoot, "editor-user-data");
  const envelope = ProjectEnvelopeSchema.parse(
    JSON.parse(
      readFileSync(
        join(process.cwd(), "packages/testkit/contracts/v1/valid/project-envelope.json"),
        "utf8",
      ),
    ),
  );
  const library = await openProjectLibrary({ stateRoot });
  await library.createProject({ envelope, records: goldenRecords() });
  const port = await reservePort();
  const application = spawn(
    executablePath,
    [`--remote-debugging-port=${port}`, `--user-data-dir=${stateRoot}`],
    { stdio: "ignore" },
  );
  try {
    const endpoint = `http://127.0.0.1:${port}`;
    let target: z.infer<typeof CdpTargetsSchema>[number] | undefined;
    await expect
      .poll(
        async () => {
          try {
            const response = await fetch(`${endpoint}/json/list`);
            target = CdpTargetsSchema.parse(await response.json()).find(
              (candidate) =>
                candidate.type === "page" && candidate.url.startsWith("open-chords://"),
            );
            return target !== undefined;
          } catch {
            return false;
          }
        },
        // Startup verifies the bundled runtime before exposing desktop capabilities.
        { timeout: 30_000 },
      )
      .toBe(true);
    if (target === undefined) throw new Error("Packaged editor target is unavailable");
    expect(await evaluatePackagedEditor(target.webSocketDebuggerUrl)).toEqual({
      saved: true,
      undone: true,
      practiceSaved: true,
      lyricsSaved: true,
    });
    process.stdout.write("Packaged editor stage: save_and_undo_verified\n");
  } finally {
    process.stdout.write("Packaged editor stage: stopping\n");
    // Reopen after abrupt termination to verify that Save/Undo already reached durable storage.
    if (process.platform !== "win32") application.kill("SIGKILL");
    await stopApplication(application);
    process.stdout.write("Packaged editor stage: stopped\n");
  }
  const reopened = await openProjectLibrary({ stateRoot });
  const saved = (await reopened.getSnapshot("project_golden"))!.project;
  expect(
    saved.lyricsDocuments.find((document) => document.id === saved.activeView!.lyricsDocumentId)!
      .text,
  ).toBe("Installed local words");
  expect(saved.activeView!.editHistoryPosition).toBe(0);
  expect(saved.editLayers[0]!.transactions).toHaveLength(2);
  expect(saved.analysisRevisions).toEqual(envelope.payload.analysisRevisions);
  expect(saved.practice).toMatchObject({
    speed: 0.75,
    instrument: "piano",
    loop: { firstBarId: "bar_pickup", lastBarId: "bar_pickup", status: "ready" },
  });
});

test("installed shell exposes only named capabilities and manifest assets", async () => {
  if (process.platform === "win32") test.setTimeout(180_000);
  const playbackState = join(packageRoot, "offline-playback-user-data");
  cpSync(userDataDirectory, playbackState, { recursive: true });
  await (await openNetworkMode(playbackState)).setOffline(true);
  const library = await openProjectLibrary({ stateRoot: playbackState });
  const libraryBaseline = canonicalSerialize(await proofTreeHashes(library.activeRoot));
  const projectBaseline = canonicalSerialize(await library.readProject(packagedProjectId));
  const rawManifest: unknown = JSON.parse(
    extractFile(
      join(resourcesPath, "app.asar"),
      join("dist", "renderer", "asset-manifest.json"),
    ).toString("utf8"),
  );
  const manifest = z
    .record(
      z.string(),
      z.object({
        assets: z.array(z.string()).optional(),
        css: z.array(z.string()).optional(),
        file: z.string(),
      }),
    )
    .parse(rawManifest);
  const allowedAssets = new Set(["index.html"]);
  for (const chunk of Object.values(manifest)) {
    allowedAssets.add(chunk.file);
    for (const asset of [...(chunk.assets ?? []), ...(chunk.css ?? [])]) allowedAssets.add(asset);
  }

  const env = installedSystemEnvironment();
  const debuggingPort = await reservePort();
  const application = spawn(
    executablePath,
    [
      `--remote-debugging-port=${String(debuggingPort)}`,
      `--user-data-dir=${playbackState}`,
      "--open-chords-startup-diagnostics",
    ],
    { env, stdio: ["ignore", "pipe", "pipe"] },
  );
  const startupProbe = recordInstalledStartup(application, "shell");
  let applicationOutput = "";
  const captureOutput = (chunk: Buffer) => {
    applicationOutput = `${applicationOutput}${chunk.toString("utf8")}`.slice(-64 * 1024);
  };
  application.stdout.on("data", captureOutput);
  application.stderr.on("data", captureOutput);
  const startupFailure = new Promise<never>((_resolve, reject) => {
    application.once("error", reject);
    application.once("exit", (code, signal) => {
      reject(
        new Error(
          `Packaged application exited before inspection (code=${String(code)}, signal=${String(signal)})\n${applicationOutput}`,
        ),
      );
    });
  });
  try {
    let renderer: z.infer<typeof RendererSnapshotSchema>;
    try {
      renderer = await Promise.race([
        inspectPackagedRenderer(debuggingPort, packagedProjectId),
        startupFailure,
      ]);
    } catch (error) {
      throw new Error(`Packaged renderer inspection failed\n${applicationOutput}`, {
        cause: error,
      });
    }
    if (renderer.offlinePlayback.workspaceProbe !== null)
      console.log(workspacePlaybackDiagnostic(renderer.offlinePlayback.workspaceProbe));
    expect(renderer).toMatchObject({
      apiKeys: [
        "alignment",
        "archives",
        "exports",
        "lyrics",
        "media",
        "models",
        "project",
        "recovery",
        "shell",
        "updates",
        "youtube",
      ],
      modelsKeys: ["perform"],
      contentSecurityPolicy: EXPECTED_RENDERER_CSP,
      effectiveCsp: { evalBlocked: true, inlineScriptBlocked: true },
      externalFetch: "rejected",
      heading: "Local Project",
      mediaKeys: ["createProject", "openPlayback", "pickLocalFile", "relinkSource"],
      missingProject: { code: "project_not_found", type: "desktop.error" },
      nodeGlobals: {
        Buffer: "undefined",
        ipcRenderer: "undefined",
        process: "undefined",
        require: "undefined",
      },
      navigationDenied: true,
      offlinePlayback: {
        offline: true,
        body: expect.stringMatching(/^RIFF....WAVE$/s),
        error: null,
        pathKeyExposed: false,
        played: true,
        playAligned: true,
        seeked: true,
        status: 206,
        type: "media.playback_ready",
        urlProtocol: "open-chords:",
        workspacePlayed: true,
        timelineMoved: true,
      },
      permissionDenied: true,
      popupDenied: true,
      projectKeys: [
        "addLyrics",
        "changeEditHistory",
        "changePractice",
        "commitEditTransaction",
        "getSnapshot",
        "list",
        "subscribe",
      ],
      projectList: {
        projects: [expect.objectContaining({ projectId: packagedProjectId })],
        type: "project.list",
      },
      security: {
        security: {
          contextIsolation: true,
          nodeIntegration: false,
          persistentSession: false,
          sandbox: true,
          webSecurity: true,
        },
        type: "shell.security_snapshot",
      },
      shellKeys: ["getSecuritySnapshot"],
      url: "open-chords://app/index.html",
      webSecurityEnforced: true,
    });
    expect(renderer.resourceUrls.length).toBeGreaterThan(0);
    for (const resourceUrl of renderer.resourceUrls) {
      expect(allowedAssets.has(new URL(resourceUrl).pathname.slice(1))).toBe(true);
    }
    expect(renderer.undeclaredAssetStatus).toBe(404);

    const secondInstanceExitCode = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(executablePath, [`--user-data-dir=${playbackState}`], {
        env,
        stdio: "ignore",
      });
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error("Second packaged instance did not exit"));
      }, 5_000);
      child.once("error", reject);
      child.once("exit", (code) => {
        clearTimeout(timeout);
        resolve(code);
      });
    });
    expect(secondInstanceExitCode).toBe(0);
  } finally {
    startupProbe();
    await stopApplication(application);
  }
  const reopened = await openProjectLibrary({ stateRoot: playbackState });
  expect(canonicalSerialize(await reopened.readProject(packagedProjectId))).toBe(projectBaseline);
  expect(canonicalSerialize(await proofTreeHashes(reopened.activeRoot))).toBe(libraryBaseline);
  expect(reopened.listExportReceipts(packagedProjectId)).toEqual([]);
  expect((await openNetworkMode(playbackState)).offline).toBe(true);
});

test("installed macOS native Open Cancel preserves an empty Offline Library", async () => {
  test.skip(process.platform !== "darwin", "macOS native picker cancellation proof");
  test.setTimeout(180_000);
  const state = join(packageRoot, "macos-native-picker-cancel");
  const path = join(packageRoot, "macos-native-picker-cancel.wav");
  const original = monoPcmWav([0, 1, 2, 3]);
  writeFileSync(path, original);
  const library = await openProjectLibrary({ stateRoot: state });
  await (await openNetworkMode(state)).setOffline(true);
  const baseline = canonicalSerialize(await proofTreeHashes(library.activeRoot));
  const result = await inspectInstalled(
    state,
    `(async () => {
    const cancelled = await window.openChords.media.pickLocalFile();
    const projects = await window.openChords.project.list();
    const offline = (await window.openChords.youtube.perform({ type: "status" })).offline;
    return { cancelled, projects, offline };
  })()`,
    installedSystemEnvironment(),
    installedMacPickerDriver("cancel", undefined, installedSystemEnvironment),
  );
  z.object({
    cancelled: z.object({
      type: z.literal("media.selection_cancelled"),
      operation: z.literal("pick"),
    }),
    projects: z.object({
      type: z.literal("project.list"),
      projects: z.array(z.unknown()).length(0),
    }),
    offline: z.literal(true),
  }).parse(result);
  expect(JSON.stringify(result).includes("playbackUrl")).toBe(false);
  for (const privatePath of [state, path, realpathSync(path)]) {
    const escaped = JSON.stringify(privatePath).slice(1, -1);
    for (const representation of [privatePath, escaped, JSON.stringify(escaped).slice(1, -1)]) {
      expect(JSON.stringify(result).includes(representation)).toBe(false);
    }
  }
  const reopened = await openProjectLibrary({ stateRoot: state });
  expect(reopened.listProjects()).toEqual([]);
  expect(canonicalSerialize(await proofTreeHashes(reopened.activeRoot))).toBe(baseline);
  expect((await openNetworkMode(state)).offline).toBe(true);
  expect(readFileSync(path)).toEqual(original);
});

for (const mode of [
  "cancel_save",
  "cancel_save_edited",
  "cancel_save_directory",
  "cancel_save_directory_expanded",
  "cancel_save_existing_target",
] as const) {
  const scenario = mode === "cancel_save_existing_target" ? "cancel_save_directory_expanded" : mode;
  test(`installed macOS native Save ${mode} verifies filenames and preserves Project and external files`, async () => {
    test.skip(process.platform !== "darwin", "macOS native Save cancellation proof");
    test.setTimeout(360_000);
    const state = join(packageRoot, `macos-native-save-${mode}`);
    const external = join(packageRoot, `macos-native-save-preserved-${mode}.json`);
    const original = Buffer.from("preserved external Save cancellation fixture");
    writeFileSync(external, original);
    const directory = mkdtempSync(join(packageRoot, "macos-save-directory-"));
    writeFileSync(join(directory, "preserved.txt"), original);
    const existingTargetBytes = Buffer.from("private existing native export target fixture");
    if (mode === "cancel_save_existing_target") {
      for (const extension of ["json", "lrc", "cho", "pdf", "ocarchive"]) {
        writeFileSync(join(directory, `Open Chords.${extension}`), existingTargetBytes);
      }
    }
    const directoryBaseline = canonicalSerialize(await proofTreeHashes(directory));
    const library = await openProjectLibrary({ stateRoot: state });
    const envelope = ProjectEnvelopeSchema.parse(
      JSON.parse(readFileSync("packages/testkit/contracts/v1/valid/project-envelope.json", "utf8")),
    );
    envelope.payload = leadSheetProject();
    await library.createProject({ envelope, records: goldenRecords() });
    await (await openNetworkMode(state)).setOffline(true);
    const before = await library.readProject("project_golden");
    const baseline = canonicalSerialize(await proofTreeHashes(library.activeRoot));
    for (const type of [
      "save_json",
      "save_lrc",
      "save_chordpro",
      "save_pdf",
      "save_archive",
    ] as const) {
      await test.step(`Native Save Cancel for ${type}`, async () => {
        const action = {
          type,
          projectId: "project_golden",
          expectedProjectRevisionId: before.projectRevisionId,
          ...(type === "save_archive"
            ? { includeMedia: false }
            : type === "save_lrc"
              ? {}
              : { presentation: "current" }),
        };
        const result = await inspectInstalled(
          state,
          `(async () => {
          const response = await window.openChords.exports.perform(${JSON.stringify(action)});
          const offline = (await window.openChords.youtube.perform({ type: "status" })).offline;
          return { response, offline };
        })()`,
          installedSystemEnvironment(),
          installedMacPickerDriver(
            scenario,
            scenario === "cancel_save_directory" || scenario === "cancel_save_directory_expanded"
              ? realpathSync(directory)
              : undefined,
            installedSystemEnvironment,
            (
              {
                save_json: "json",
                save_lrc: "lrc",
                save_chordpro: "chordpro",
                save_pdf: "pdf",
                save_archive: "archive",
              } as const
            )[type],
          ),
        );
        z.object({
          response: z.object({
            type: z.literal("exports.result"),
            projectId: z.literal("project_golden"),
            state: z.literal("cancelled"),
            busy: z.literal(false),
            pendingRecovery: z.literal(0),
            receipts: z.array(z.unknown()).length(0),
          }),
          offline: z.literal(true),
        }).parse(result);
        for (const privatePath of [
          state,
          external,
          realpathSync(external),
          directory,
          realpathSync(directory),
        ]) {
          const escaped = JSON.stringify(privatePath).slice(1, -1);
          for (const representation of [privatePath, escaped, JSON.stringify(escaped).slice(1, -1)])
            expect(JSON.stringify(result).includes(representation)).toBe(false);
        }
        expect(JSON.stringify(result).includes(original.toString())).toBe(false);
        expect(JSON.stringify(result).includes(existingTargetBytes.toString())).toBe(false);
        const reopened = await openProjectLibrary({ stateRoot: state });
        expect(reopened.listProjects().map(({ projectId }) => projectId)).toEqual([
          "project_golden",
        ]);
        expect(await reopened.readProject("project_golden")).toEqual(before);
        expect(canonicalSerialize(await proofTreeHashes(reopened.activeRoot))).toBe(baseline);
        expect(reopened.listExportReceipts("project_golden")).toEqual([]);
        expect((await openNetworkMode(state)).offline).toBe(true);
        expect(readFileSync(external)).toEqual(original);
        expect(canonicalSerialize(await proofTreeHashes(directory))).toBe(directoryBaseline);
      });
    }
  });
}

test("installed macOS observes replacement context without confirming or changing an existing JSON target", async () => {
  test.skip(process.platform !== "darwin", "macOS native replacement context observation");
  test.setTimeout(360_000);
  const state = join(packageRoot, "macos-replace-json-observation");
  const directory = realpathSync(mkdtempSync(join(packageRoot, "macos-replace-json-")));
  const original = Buffer.from("private existing native export target fixture");
  writeFileSync(join(directory, "Open Chords.json"), original);
  writeFileSync(join(directory, "preserved.txt"), original);
  const outputBefore = canonicalSerialize(await proofTreeHashes(directory));
  const library = await openProjectLibrary({ stateRoot: state });
  const envelope = ProjectEnvelopeSchema.parse(
    JSON.parse(readFileSync("packages/testkit/contracts/v1/valid/project-envelope.json", "utf8")),
  );
  envelope.payload = leadSheetProject();
  await library.createProject({ envelope, records: goldenRecords() });
  await (await openNetworkMode(state)).setOffline(true);
  const before = await library.readProject("project_golden");
  const libraryBefore = canonicalSerialize(await proofTreeHashes(library.activeRoot));
  const action = {
    type: "save_json",
    projectId: "project_golden",
    expectedProjectRevisionId: before.projectRevisionId,
    presentation: "current",
  };
  // Observe the native prompt, then use the existing clean shutdown path. This is not an export-result proof.
  const result = await inspectInstalled(
    state,
    `(() => { void window.openChords.exports.perform(${JSON.stringify(action)}).then(() => undefined, () => undefined); return { started: true }; })()`,
    installedSystemEnvironment(),
    installedMacPickerDriver("observe_replace_json", directory, installedSystemEnvironment, "json"),
  );
  expect(result).toEqual({ started: true });
  const reopened = await openProjectLibrary({ stateRoot: state });
  expect(await reopened.readProject("project_golden")).toEqual(before);
  expect(canonicalSerialize(await proofTreeHashes(reopened.activeRoot))).toBe(libraryBefore);
  expect(reopened.listExportReceipts("project_golden")).toEqual([]);
  expect((await openNetworkMode(state)).offline).toBe(true);
  expect(canonicalSerialize(await proofTreeHashes(directory))).toBe(outputBefore);
  expect(readFileSync(join(directory, "Open Chords.json"))).toEqual(original);
  // A second cold open must not materialize a pending export or Receipt.
  const second = await openProjectLibrary({ stateRoot: state });
  expect(await second.readProject("project_golden")).toEqual(before);
  expect(second.listExportReceipts("project_golden")).toEqual([]);
  expect(canonicalSerialize(await proofTreeHashes(second.activeRoot))).toBe(libraryBefore);
});

test("installed macOS cancels replacement confirmation without changing an existing JSON target", async () => {
  test.skip(process.platform !== "darwin", "macOS native replacement confirmation Cancel");
  test.setTimeout(360_000);
  const state = join(packageRoot, "macos-replace-json-cancel");
  const directory = realpathSync(mkdtempSync(join(packageRoot, "macos-replace-cancel-output-")));
  const original = Buffer.from("private existing native export target fixture");
  writeFileSync(join(directory, "Open Chords.json"), original);
  writeFileSync(join(directory, "preserved.txt"), original);
  const outputBefore = canonicalSerialize(await proofTreeHashes(directory));
  const library = await openProjectLibrary({ stateRoot: state });
  const envelope = ProjectEnvelopeSchema.parse(
    JSON.parse(readFileSync("packages/testkit/contracts/v1/valid/project-envelope.json", "utf8")),
  );
  envelope.payload = leadSheetProject();
  await library.createProject({ envelope, records: goldenRecords() });
  await (await openNetworkMode(state)).setOffline(true);
  const before = await library.readProject("project_golden");
  const libraryBefore = canonicalSerialize(await proofTreeHashes(library.activeRoot));
  const action = {
    type: "save_json",
    projectId: "project_golden",
    expectedProjectRevisionId: before.projectRevisionId,
    presentation: "current",
  };
  // Cancel only the confirmation; the retained Save sheet closes through the existing shutdown path.
  const result = await inspectInstalled(
    state,
    `(() => { void window.openChords.exports.perform(${JSON.stringify(action)}).then(() => undefined, () => undefined); return { started: true }; })()`,
    installedSystemEnvironment(),
    installedMacPickerDriver("cancel_replace_json", directory, installedSystemEnvironment, "json"),
  );
  expect(result).toEqual({ started: true });
  const reopened = await openProjectLibrary({ stateRoot: state });
  expect(await reopened.readProject("project_golden")).toEqual(before);
  expect(canonicalSerialize(await proofTreeHashes(reopened.activeRoot))).toBe(libraryBefore);
  expect(reopened.listExportReceipts("project_golden")).toEqual([]);
  expect((await openNetworkMode(state)).offline).toBe(true);
  expect(canonicalSerialize(await proofTreeHashes(directory))).toBe(outputBefore);
  expect(readFileSync(join(directory, "Open Chords.json"))).toEqual(original);
  // A second cold open must not materialize a pending export or Receipt.
  const second = await openProjectLibrary({ stateRoot: state });
  expect(await second.readProject("project_golden")).toEqual(before);
  expect(second.listExportReceipts("project_golden")).toEqual([]);
  expect(canonicalSerialize(await proofTreeHashes(second.activeRoot))).toBe(libraryBefore);
  expect((await openNetworkMode(state)).offline).toBe(true);
  expect(canonicalSerialize(await proofTreeHashes(directory))).toBe(outputBefore);
});

for (const format of ["json", "lrc", "chordpro", "pdf", "archive"] as const) {
  test(`installed macOS native ${format} Save publishes exact bytes and one cold durable Receipt`, async () => {
    test.skip(process.platform !== "darwin", "macOS native Save proof");
    test.setTimeout(360_000);
    const state = join(packageRoot, `macos-native-${format}-save`);
    const directory = realpathSync(mkdtempSync(join(packageRoot, `macos-${format}-output-`)));
    const filename = `Open Chords.${format === "chordpro" ? "cho" : format === "archive" ? "ocarchive" : format}`;
    const target = join(directory, filename);
    const external = join(packageRoot, `macos-${format}-preserved.bin`);
    const original = Buffer.from("private native Save preservation fixture");
    writeFileSync(external, original);
    writeFileSync(join(directory, "preserved.txt"), original);
    const directoryBefore = await proofTreeHashes(directory);
    const library = await openProjectLibrary({ stateRoot: state });
    const envelope = ProjectEnvelopeSchema.parse(
      JSON.parse(readFileSync("packages/testkit/contracts/v1/valid/project-envelope.json", "utf8")),
    );
    envelope.payload = leadSheetProject();
    await library.createProject({ envelope, records: goldenRecords() });
    await (await openNetworkMode(state)).setOffline(true);
    const before = await library.readProject("project_golden");
    const archiveProjection = format === "archive" ? archivedProjectFor(before) : undefined;
    const expectedArchive =
      archiveProjection === undefined
        ? undefined
        : writePortableProjectArchive({ document: archiveProjection.document });
    const action = {
      type: `save_${format}`,
      projectId: "project_golden",
      expectedProjectRevisionId: before.projectRevisionId,
      ...(format === "archive"
        ? { includeMedia: false }
        : format === "lrc"
          ? {}
          : { presentation: "current" }),
    };
    const result = await inspectInstalled(
      state,
      `(async () => {
    const response = await window.openChords.exports.perform(${JSON.stringify(action)});
    const offline = (await window.openChords.youtube.perform({ type: "status" })).offline;
    return { response, offline };
  })()`,
      installedSystemEnvironment(),
      installedMacPickerDriver(`save_${format}`, directory, installedSystemEnvironment, format),
    );
    z.object({
      response: z.object({
        type: z.literal("exports.result"),
        projectId: z.literal("project_golden"),
        state: z.literal("saved"),
        busy: z.literal(false),
        pendingRecovery: z.literal(0),
        receipts: z.array(z.unknown()).length(1),
      }),
      offline: z.literal(true),
    }).parse(result);
    const snapshot = captureJsonExport(envelope.payload, { presentation: "current" });
    const lrc = projectLrc(snapshot, { title: snapshot.project.id });
    const chordpro = serializeChordPro(projectLeadSheet(snapshot, { title: snapshot.project.id }));
    if (format === "lrc") expect(lrc.kind).toBe("lrc");
    const expected =
      format === "json"
        ? serializeJsonExport(snapshot)
        : format === "lrc"
          ? "[ti:project_golden]\n[00:00.41]home go\n"
          : format === "chordpro"
            ? readFileSync("tests/fixtures/chordpro-golden.cho", "utf8")
            : undefined;
    const losses =
      format === "json"
        ? []
        : format === "chordpro"
          ? chordpro.losses
          : format === "pdf"
            ? PDF_GOLDEN_LOSSES
            : lrc.kind === "lrc"
              ? lrc.losses
              : [];
    const profileVersion =
      format === "json"
        ? "open_chords_json/1.0/current"
        : format === "lrc"
          ? "lrc/1.0"
          : format === "chordpro"
            ? "chordpro/1.0/current"
            : format === "pdf"
              ? "pdf/1.0/a4/current"
              : "project_archive/1.0/no_media";
    const output = readFileSync(target);
    if (expected !== undefined) expect(output).toEqual(Buffer.from(expected));
    const digest = createNativeSelectionHash("sha256").update(output).digest("hex");
    if (format === "pdf") expect(digest).toBe(PDF_GOLDEN_SHA256);
    let archiveDocument: string | undefined;
    if (expectedArchive !== undefined && archiveProjection !== undefined) {
      expect(output).toEqual(expectedArchive.archive);
      const inspected = inspectPortableProjectArchive(output);
      archiveDocument = canonicalSerialize(inspected.document);
      expect(archiveDocument).toBe(canonicalSerialize(archiveProjection.document));
      expect(inspected.media).toBeUndefined();
    }
    expect(await proofTreeHashes(directory)).toEqual({
      ...directoryBefore,
      [filename]: digest,
    });
    expect(readFileSync(external)).toEqual(original);
    const reopened = await openProjectLibrary({ stateRoot: state });
    expect(reopened.listProjects().map(({ projectId }) => projectId)).toEqual(["project_golden"]);
    const after = await reopened.readProject("project_golden");
    const receipts = reopened.listExportReceipts("project_golden");
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      format:
        format === "json" ? "open_chords_json" : format === "archive" ? "project_archive" : format,
      ...(expectedArchive === undefined ? {} : { activeViewHash: expectedArchive.projectHash }),
      outputLocation: target,
      outputHash: `sha256:${digest}`,
      profileVersion,
      omissions:
        archiveProjection === undefined
          ? [...new Set([...snapshot.omissions, ...losses])].sort((a, b) => a.localeCompare(b))
          : archiveProjection.omissions,
    });
    expect(after.envelope).toEqual(before.envelope);
    expect(after.compatibility).toBe(before.compatibility);
    expect(after.records).toEqual({ ...before.records, exportReceipts: receipts });
    expect(after.revisions).toHaveLength(before.revisions.length + 1);
    expect(after.revisions.slice(0, before.revisions.length)).toEqual(before.revisions);
    expect(after.revisions.at(-1)).toMatchObject({
      reason: "edit_transaction",
      projectRevisionId: after.projectRevisionId,
    });
    expect(after.projectRevisionId).not.toBe(before.projectRevisionId);
    expect((await openNetworkMode(state)).offline).toBe(true);
    const tree = await proofTreeHashes(reopened.activeRoot);
    const second = await openProjectLibrary({ stateRoot: state });
    expect(await second.readProject("project_golden")).toEqual(after);
    expect(await proofTreeHashes(second.activeRoot)).toEqual(tree);
    expect(await proofTreeHashes(directory)).toEqual({
      ...directoryBefore,
      [filename]: digest,
    });
    let freshImport: unknown;
    const freshState = join(packageRoot, "macos-native-saved-archive-import");
    if (archiveProjection !== undefined) {
      const empty = await openProjectLibrary({ stateRoot: freshState });
      expect(empty.listProjects()).toEqual([]);
      await (await openNetworkMode(freshState)).setOffline(true);
      freshImport = await inspectInstalled(
        freshState,
        `(async () => {
          const response = await window.openChords.archives.import({ adoptOfflineMedia: false });
          const offline = (await window.openChords.youtube.perform({ type: "status" })).offline;
          return { response, offline };
        })()`,
        installedSystemEnvironment(),
        installedMacPickerDriver("open", target, installedSystemEnvironment),
      );
      z.object({
        response: z.object({
          type: z.literal("archives.import_result"),
          result: z.object({
            state: z.literal("imported"),
            projectId: z.literal("project_golden"),
            importedCopy: z.literal(false),
            offlineMedia: z.object({ state: z.literal("not_included") }),
          }),
        }),
        offline: z.literal(true),
      }).parse(freshImport);
      const imported = await openProjectLibrary({ stateRoot: freshState });
      expect(imported.listProjects().map(({ projectId }) => projectId)).toEqual(["project_golden"]);
      const importedProject = await imported.readProject("project_golden");
      expect(importedProject.envelope).toEqual(archiveProjection.document.envelope);
      expect(importedProject.records).toEqual(archiveProjection.document.records);
      expect(imported.listExportReceipts("project_golden")).toEqual([]);
      expect(canonicalSerialize(archivedProjectFor(importedProject).document)).toBe(
        archiveDocument,
      );
      expect((await openNetworkMode(freshState)).offline).toBe(true);
      const importedTree = await proofTreeHashes(imported.activeRoot);
      const secondImport = await openProjectLibrary({ stateRoot: freshState });
      expect(await secondImport.readProject("project_golden")).toEqual(importedProject);
      expect(await proofTreeHashes(secondImport.activeRoot)).toEqual(importedTree);
      expect(await proofTreeHashes(second.activeRoot)).toEqual(tree);
      expect(await second.readProject("project_golden")).toEqual(after);
      expect(await proofTreeHashes(directory)).toEqual({ ...directoryBefore, [filename]: digest });
      expect(readFileSync(target)).toEqual(output);
      expect(readFileSync(external)).toEqual(original);
    }
    for (const privateValue of [
      state,
      freshState,
      directory,
      target,
      external,
      original.toString(),
      "/unavailable/golden-fixture.wav",
    ]) {
      const escaped = JSON.stringify(privateValue).slice(1, -1);
      for (const representation of [privateValue, escaped, JSON.stringify(escaped).slice(1, -1)]) {
        expect(JSON.stringify(result).includes(representation)).toBe(false);
        if (freshImport !== undefined)
          expect(JSON.stringify(freshImport).includes(representation)).toBe(false);
        expect(output.includes(Buffer.from(representation))).toBe(false);
        if (archiveDocument !== undefined)
          expect(archiveDocument.includes(representation)).toBe(false);
      }
    }
  });
}

for (const { adoptOfflineMedia, wholeSource } of [
  { adoptOfflineMedia: false, wholeSource: false },
  { adoptOfflineMedia: true, wholeSource: false },
  { adoptOfflineMedia: false, wholeSource: true },
  { adoptOfflineMedia: true, wholeSource: true },
]) {
  test(`installed macOS archive ${wholeSource ? "full Source" : "partial range"} media import honors explicit adoption ${String(adoptOfflineMedia)}`, async () => {
    test.skip(process.platform !== "darwin", "macOS native archive media import proof");
    test.setTimeout(360_000);
    const root = realpathSync(mkdtempSync(join(packageRoot, "macos-archive-media-")));
    const originState = join(root, "origin");
    const state = join(root, "destination");
    const sourcePath = join(root, "private-recording.wav");
    const sourceSamples = [10, 20, 30, 40, 50, 60];
    const startSourceSample = wholeSource ? 0 : 2;
    const endSourceSample = wholeSource ? sourceSamples.length : 5;
    const sourceBytes = monoPcmWav(sourceSamples);
    writeFileSync(sourcePath, sourceBytes);
    const origin = await openProjectLibrary({ stateRoot: originState });
    const media = new LocalMediaService({ library: origin, pickFile: async () => sourcePath });
    media.activateGeneration("generation_fixture");
    const selected = await media.pickLocalFile("generation_fixture");
    if (selected.kind !== "selected") throw new Error("Archive media fixture selection failed");
    const created = await media.createProject({
      capabilityId: selected.capabilityId,
      generationId: "generation_fixture",
      startSourceSample,
      endSourceSample,
    });
    await media.dispose();
    const before = await origin.readProject(created.projectId);
    const projection = archivedProjectFor(before);
    const rangeSamples = sourceSamples.slice(startSourceSample, endSourceSample);
    const rangeBytes = Buffer.alloc(rangeSamples.length * 2);
    rangeSamples.forEach((sample, index) => rangeBytes.writeInt16LE(sample, index * 2));
    const source = projection.document.records.sources[0]!;
    const snapshot = source.snapshots[0]!;
    if (wholeSource) {
      expect(snapshot.durationSamples).toBe(sourceSamples.length);
      expect(`sha256:${createNativeSelectionHash("sha256").update(rangeBytes).digest("hex")}`).toBe(
        snapshot.canonicalAudioFingerprint,
      );
    }
    const archive = writePortableProjectArchive({
      document: projection.document,
      media: {
        bytes: rangeBytes,
        channels: 1,
        encoding: "pcm_s16le",
        sampleRate: selected.sampleRate,
        sourceId: source.id,
        sourceSnapshotId: snapshot.id,
        startSourceSample,
        endSourceSample,
      },
    });
    const target = join(root, "media.ocarchive");
    writeFileSync(target, archive.archive);
    const inspected = inspectPortableProjectArchive(archive.archive);
    expect(inspected.media?.bytes).toEqual(rangeBytes);
    const externalBefore = await proofTreeHashes(root);
    const originTree = await proofTreeHashes(origin.activeRoot);
    const destination = await openProjectLibrary({ stateRoot: state });
    expect(destination.listProjects()).toEqual([]);
    await (await openNetworkMode(state)).setOffline(true);
    const result = await inspectInstalled(
      state,
      `(async () => {
        const response = await window.openChords.archives.import({ adoptOfflineMedia: ${String(adoptOfflineMedia)} });
        const offline = (await window.openChords.youtube.perform({ type: "status" })).offline;
        return { response, offline };
      })()`,
      installedSystemEnvironment(),
      installedMacPickerDriver("open", target, installedSystemEnvironment),
    );
    expect(result).toMatchObject({
      response: {
        type: "archives.import_result",
        result: {
          state: "imported",
          projectId: created.projectId,
          importedCopy: false,
          offlineMedia: adoptOfflineMedia
            ? { state: "cached", verification: "archive_attested" }
            : { state: "declined" },
        },
      },
      offline: true,
    });
    const reopened = await openProjectLibrary({ stateRoot: state });
    expect(reopened.listProjects().map(({ projectId }) => projectId)).toEqual([created.projectId]);
    const imported = await reopened.readProject(created.projectId);
    expect(imported.envelope).toEqual(projection.document.envelope);
    expect(imported.records).toEqual(projection.document.records);
    expect(reopened.listExportReceipts(created.projectId)).toEqual([]);
    expect(imported.records.sources[0]?.locators).toEqual([]);
    const cache = await openOfflineMediaCache({ stateRoot: state });
    const entries = await cache.list();
    expect(entries).toHaveLength(adoptOfflineMedia ? 1 : 0);
    const hash = `sha256:${createNativeSelectionHash("sha256").update(rangeBytes).digest("hex")}`;
    if (adoptOfflineMedia) {
      expect(entries[0]).toMatchObject({
        byteSize: rangeBytes.length,
        sha256: hash,
        verification: "archive_attested",
        origin: { kind: "portable_project_archive", archiveManifestHash: archive.manifestHash },
        range: {
          sourceId: source.id,
          sourceSnapshotId: snapshot.id,
          canonicalAudioFingerprint: snapshot.canonicalAudioFingerprint,
          sampleRate: selected.sampleRate,
          startSourceSample,
          endSourceSample,
        },
      });
      expect(await cache.read(entries[0]!.id)).toEqual(rangeBytes);
    }
    const tree = await proofTreeHashes(reopened.activeRoot);
    const cacheTree = await proofTreeHashes(join(state, "offline-media-cache"));
    const cold = await openProjectLibrary({ stateRoot: state });
    expect(await cold.readProject(created.projectId)).toEqual(imported);
    expect(await proofTreeHashes(cold.activeRoot)).toEqual(tree);
    const coldCache = await openOfflineMediaCache({ stateRoot: state });
    expect(await coldCache.list()).toEqual(entries);
    expect(await proofTreeHashes(join(state, "offline-media-cache"))).toEqual(cacheTree);
    if (adoptOfflineMedia) expect(await coldCache.read(entries[0]!.id)).toEqual(rangeBytes);
    const repeated = await inspectInstalled(
      state,
      `(async () => {
        const response = await window.openChords.archives.import({ adoptOfflineMedia: true });
        const offline = (await window.openChords.youtube.perform({ type: "status" })).offline;
        return { response, offline };
      })()`,
      installedSystemEnvironment(),
      installedMacPickerDriver("open", target, installedSystemEnvironment),
    );
    expect(repeated).toMatchObject({
      response: {
        type: "archives.import_result",
        result: {
          state: "already_present",
          projectId: created.projectId,
          importedCopy: false,
          offlineMedia: wholeSource
            ? { state: "cached", verification: "snapshot_fingerprint" }
            : { state: "blocked", reason: "unverifiable_for_known_source" },
        },
      },
      offline: true,
    });
    const afterRepeat = await openProjectLibrary({ stateRoot: state });
    expect(afterRepeat.listProjects().map(({ projectId }) => projectId)).toEqual([
      created.projectId,
    ]);
    expect(await afterRepeat.readProject(created.projectId)).toEqual(imported);
    expect(afterRepeat.listExportReceipts(created.projectId)).toEqual([]);
    expect(await proofTreeHashes(afterRepeat.activeRoot)).toEqual(tree);
    const afterRepeatCache = await openOfflineMediaCache({ stateRoot: state });
    const repeatedEntries = await afterRepeatCache.list();
    if (wholeSource) {
      expect(repeatedEntries).toHaveLength(1);
      const entry = repeatedEntries[0]!;
      expect(entry).toMatchObject({
        byteSize: rangeBytes.length,
        sha256: hash,
        verification: "snapshot_fingerprint",
        origin: { kind: "portable_project_archive", archiveManifestHash: archive.manifestHash },
        range: {
          sourceId: source.id,
          sourceSnapshotId: snapshot.id,
          canonicalAudioFingerprint: snapshot.canonicalAudioFingerprint,
          sampleRate: selected.sampleRate,
          startSourceSample,
          endSourceSample,
        },
      });
      if (adoptOfflineMedia)
        expect(entry).toEqual({
          ...entries[0],
          createdAt: entry.createdAt,
          verification: "snapshot_fingerprint",
        });
      expect(await afterRepeatCache.read(entry.id)).toEqual(rangeBytes);
      expect(await proofTreeHashes(join(state, "offline-media-cache"))).toEqual({
        [`${entry.id}.pcm`]: hash.slice("sha256:".length),
        [`${entry.id}.json`]: createNativeSelectionHash("sha256")
          .update(canonicalSerialize(entry))
          .digest("hex"),
      });
    } else {
      expect(repeatedEntries).toEqual(entries);
      expect(await proofTreeHashes(join(state, "offline-media-cache"))).toEqual(cacheTree);
      if (adoptOfflineMedia)
        expect(await afterRepeatCache.read(entries[0]!.id)).toEqual(rangeBytes);
    }
    const repeatedCacheTree = await proofTreeHashes(join(state, "offline-media-cache"));
    const finalCache = await openOfflineMediaCache({ stateRoot: state });
    expect(await finalCache.list()).toEqual(repeatedEntries);
    expect(await proofTreeHashes(join(state, "offline-media-cache"))).toEqual(repeatedCacheTree);
    const finalLibrary = await openProjectLibrary({ stateRoot: state });
    expect(await finalLibrary.readProject(created.projectId)).toEqual(imported);
    expect(await proofTreeHashes(finalLibrary.activeRoot)).toEqual(tree);
    const verifiedCacheReplays: unknown[] = [];
    if (wholeSource) {
      for (const adoptVerifiedMedia of [true, false]) {
        const replay = await inspectInstalled(
          state,
          `(async () => {
            const response = await window.openChords.archives.import({ adoptOfflineMedia: ${String(adoptVerifiedMedia)} });
            const offline = (await window.openChords.youtube.perform({ type: "status" })).offline;
            return { response, offline };
          })()`,
          installedSystemEnvironment(),
          installedMacPickerDriver("open", target, installedSystemEnvironment),
        );
        verifiedCacheReplays.push(replay);
        expect(replay).toMatchObject({
          response: {
            type: "archives.import_result",
            result: {
              state: "already_present",
              projectId: created.projectId,
              importedCopy: false,
              offlineMedia: adoptVerifiedMedia
                ? { state: "already_cached", verification: "snapshot_fingerprint" }
                : { state: "declined" },
            },
          },
          offline: true,
        });
        const replayLibrary = await openProjectLibrary({ stateRoot: state });
        expect(replayLibrary.listProjects().map(({ projectId }) => projectId)).toEqual([
          created.projectId,
        ]);
        expect(await replayLibrary.readProject(created.projectId)).toEqual(imported);
        expect(replayLibrary.listExportReceipts(created.projectId)).toEqual([]);
        expect(await proofTreeHashes(replayLibrary.activeRoot)).toEqual(tree);
        const replayCache = await openOfflineMediaCache({ stateRoot: state });
        expect(await replayCache.list()).toEqual(repeatedEntries);
        expect(await replayCache.read(repeatedEntries[0]!.id)).toEqual(rangeBytes);
        expect(await proofTreeHashes(join(state, "offline-media-cache"))).toEqual(
          repeatedCacheTree,
        );
      }
    }
    expect((await openNetworkMode(state)).offline).toBe(true);
    expect(await origin.readProject(created.projectId)).toEqual(before);
    expect(await proofTreeHashes(origin.activeRoot)).toEqual(originTree);
    expect(readFileSync(sourcePath)).toEqual(sourceBytes);
    expect(readFileSync(target)).toEqual(archive.archive);
    // Every pre-existing file outside the destination remains byte-identical.
    const externalAfter = await proofTreeHashes(root);
    expect(
      Object.fromEntries(
        Object.entries(externalAfter).filter(([path]) => !path.startsWith("destination/")),
      ),
    ).toEqual(externalBefore);
    const document = canonicalSerialize(inspected.document);
    for (const privateValue of [originState, state, sourcePath, root, target]) {
      const escaped = JSON.stringify(privateValue).slice(1, -1);
      for (const value of [privateValue, escaped, JSON.stringify(escaped).slice(1, -1)]) {
        expect(JSON.stringify(result).includes(value)).toBe(false);
        expect(JSON.stringify(repeated).includes(value)).toBe(false);
        expect(JSON.stringify(verifiedCacheReplays).includes(value)).toBe(false);
        expect(document.includes(value)).toBe(false);
        expect(archive.archive.includes(Buffer.from(value))).toBe(false);
      }
    }
  });
}

for (const firstOutcome of ["cancel", "refusal"] as const) {
  test(`installed Choose recording ${firstOutcome} preserves state before same-process recovery`, async () => {
    test.skip(!["win32", "darwin"].includes(process.platform), "Native renderer file picker proof");
    test.setTimeout(360_000);
    const state = join(packageRoot, `renderer-native-source-${firstOutcome}`);
    const path = join(packageRoot, `renderer-native-source-${firstOutcome}.wav`);
    const original = monoPcmWav([0, 1, 2, 3]);
    writeFileSync(path, original);
    const firstPath =
      firstOutcome === "cancel" ? path : join(packageRoot, "renderer-native-invalid.wav");
    const firstBytes =
      firstOutcome === "cancel"
        ? original
        : Buffer.from("private renderer refusal fixture, not WAV");
    if (firstOutcome === "refusal") writeFileSync(firstPath, firstBytes);
    const library = await openProjectLibrary({ stateRoot: state });
    await (await openNetworkMode(state)).setOffline(true);
    const baseline = canonicalSerialize(await proofTreeHashes(library.activeRoot));
    const result = await inspectInstalled(
      state,
      `(async () => {
      const deadline = Date.now() + 55000;
      document.documentElement.dataset.installedChooseStage = "waiting_choose";
      const visible = element => element?.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) === true;
      let choose;
      while (Date.now() < deadline) {
        choose = [...document.querySelectorAll('.empty-workspace button')].find(button => button.textContent.trim() === "Choose local recording" && !button.disabled && visible(button));
        if (choose) break;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      if (!choose) throw new Error("Installed Choose recording button was unavailable");
      document.documentElement.dataset.installedChooseStage = "choose_clicked";
      choose.click();
      let busyObserved = false;
      while (Date.now() < deadline) {
        const busy = [...document.querySelectorAll('.empty-workspace button')].find(button => button.disabled && button.textContent.trim() === "Creating Project…" && visible(button));
        if (busy) {
          busyObserved = true;
          document.documentElement.dataset.installedChooseStage = "pending_observed";
          document.documentElement.dataset.installedChoosePending = "observed";
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      if (!busyObserved) throw new Error("Installed Choose recording did not enter its pending state");
      let cancellation;
      while (Date.now() < deadline) {
        const ready = [...document.querySelectorAll('.empty-workspace button')].find(button => button.textContent.trim() === "Choose local recording" && !button.disabled && visible(button));
        if (ready && visible(document.querySelector('main.empty-workspace'))) {
          document.documentElement.dataset.installedChooseStage = "cancel_restored";
          const projects = await window.openChords.project.list();
          const visibleAlerts = [...document.querySelectorAll('[role="alert"]')].filter(visible);
          cancellation = {
            type: projects.type,
            projectCount: projects.type === "project.list" ? projects.projects.length : -1,
            emptyVisible: true,
            workspaceAbsent: document.querySelector('main.workspace') === null,
            alertAbsent: document.querySelector('.empty-workspace [role="alert"]') === null,
            refusalVisible: visibleAlerts.length === 1 && visibleAlerts[0]?.textContent === "Local media operation failed",
            chooseEnabled: !ready.disabled,
            offline: (await window.openChords.youtube.perform({type: "status"})).offline,
          };
          document.documentElement.dataset.installedChooseStage = "retry_clicked";
          ready.click();
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      if (!cancellation) throw new Error("Native Cancel did not restore the empty workspace");
      while (Date.now() < deadline) {
        const workspace = document.querySelector('main.workspace');
        const identity = document.querySelector('.project-identity');
        const audio = document.querySelector('audio');
        if (visible(workspace) && visible(identity) && audio?.src.startsWith('open-chords:')) {
          document.documentElement.dataset.installedChooseStage = "workspace_visible";
          const projectId = identity.textContent.trim();
          const response = await window.openChords.project.getSnapshot(projectId);
          if (response.type !== "project.snapshot") return { type: response.type };
          document.documentElement.dataset.installedChooseStage = "snapshot_read";
          return {
            type: response.type,
            cancellation,
            projectId,
            projectRevisionId: response.projectRevisionId,
            durationSamples: response.project.durationSamples,
            sampleRate: response.project.sampleRate,
            workspaceVisible: visible(workspace),
            playbackReady: audio.src.startsWith('open-chords:'),
            errorAbsent: ![...document.querySelectorAll('[role="alert"]')].some(visible),
            offline: (await window.openChords.youtube.perform({type: "status"})).offline,
          };
        }
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      throw new Error("Native-selected recording did not open its committed workspace");
    })()`,
      installedSystemEnvironment(),
      async (applicationPid) => {
        const started = performance.now();
        const report = (
          stage:
            | "first_started"
            | "first_completed"
            | "baseline_verified"
            | "open_started"
            | "open_completed",
        ) =>
          process.stdout.write(
            `Installed Choose driver: scenario=${firstOutcome} stage=${stage} elapsed_ms=${Math.round(performance.now() - started)}\n`,
          );
        report("first_started");
        await installedMediaPickerDriver(
          firstOutcome === "cancel" ? "cancel_open_existing" : "open",
          firstPath,
        )(applicationPid);
        report("first_completed");
        expect(canonicalSerialize(await proofTreeHashes(library.activeRoot))).toBe(baseline);
        expect(readFileSync(path)).toEqual(original);
        expect(readFileSync(firstPath)).toEqual(firstBytes);
        report("baseline_verified");
        report("open_started");
        await installedMediaPickerDriver("open", path)(applicationPid);
        report("open_completed");
      },
      `(async () => {
      const deadline = Date.now() + 55000;
      while (Date.now() < deadline) {
        if (document.documentElement.dataset.installedChoosePending === "observed") return true;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      throw new Error("Installed Choose pending acknowledgment was unavailable");
    })()`,
    );
    const opened = z
      .object({
        type: z.literal("project.snapshot"),
        cancellation: z.object({
          type: z.literal("project.list"),
          projectCount: z.literal(0),
          emptyVisible: z.literal(true),
          workspaceAbsent: z.literal(true),
          alertAbsent: z.literal(firstOutcome === "cancel"),
          refusalVisible: z.literal(firstOutcome === "refusal"),
          chooseEnabled: z.literal(true),
          offline: z.literal(true),
        }),
        projectId: z.string(),
        projectRevisionId: z.string(),
        durationSamples: z.literal(4),
        sampleRate: z.literal(48000),
        workspaceVisible: z.literal(true),
        playbackReady: z.literal(true),
        errorAbsent: z.literal(true),
        offline: z.literal(true),
      })
      .parse(result);
    for (const privatePath of [
      state,
      path,
      firstPath,
      realpathSync(path),
      realpathSync(firstPath),
    ]) {
      const escaped = JSON.stringify(privatePath).slice(1, -1);
      for (const representation of [privatePath, escaped, JSON.stringify(escaped).slice(1, -1)]) {
        expect(JSON.stringify(result).includes(representation)).toBe(false);
      }
    }
    expect(JSON.stringify(result).includes("playbackUrl")).toBe(false);
    expect(JSON.stringify(result).includes("private renderer refusal fixture")).toBe(false);
    const reopened = await openProjectLibrary({ stateRoot: state });
    expect(reopened.listProjects().map(({ projectId }) => projectId)).toEqual([opened.projectId]);
    const project = await reopened.readProject(opened.projectId);
    expect(project.projectRevisionId).toBe(opened.projectRevisionId);
    expect(project.envelope.payload).toMatchObject({
      id: opened.projectId,
      durationSamples: 4,
      sampleRate: 48000,
      analysisRevisions: [],
      editLayers: [],
      activeView: null,
    });
    expect(project.records.projectRange).toMatchObject({
      startSourceSample: 0,
      endSourceSample: 4,
    });
    expect(project.records.sources).toHaveLength(1);
    const source = project.records.sources[0]!;
    expect(source.id).toBe(project.records.projectRange?.sourceId);
    expect(source.identity.kind).toBe("local_file");
    expect(source.snapshots).toMatchObject([
      {
        byteFingerprint: `sha256:${createNativeSelectionHash("sha256").update(original).digest("hex")}`,
        byteSize: original.length,
        durationSamples: 4,
      },
    ]);
    expect(source.locators).toHaveLength(1);
    let sameFile = false;
    const locator = source.locators[0];
    if (locator?.kind === "local_file" && locator.status === "available") {
      try {
        const actual = statSync(locator.path, { bigint: true });
        const expected = statSync(path, { bigint: true });
        sameFile = actual.ino !== 0n && actual.ino === expected.ino && actual.dev === expected.dev;
      } catch {
        // Keep private paths from stat failures out of the test report.
      }
    }
    expect(sameFile).toBe(true);
    expect(reopened.listExportReceipts(opened.projectId)).toEqual([]);
    expect((await openNetworkMode(state)).offline).toBe(true);
    expect(readFileSync(path)).toEqual(original);
    expect(readFileSync(firstPath)).toEqual(firstBytes);
  });
}

test("installed native local file refusals precede a durable offline Project", async () => {
  test.skip(!["win32", "darwin"].includes(process.platform), "Native file picker proof");
  test.setTimeout(540_000);
  const state = join(packageRoot, "native-source-create");
  const path = join(packageRoot, "native-source-create.wav");
  const original = monoPcmWav([0, 1, 2, 3]);
  writeFileSync(path, original);
  const library = await openProjectLibrary({ stateRoot: state });
  await (await openNetworkMode(state)).setOffline(true);
  const baseline = canonicalSerialize(await proofTreeHashes(library.activeRoot));
  const cancelled = await inspectInstalled(
    state,
    "window.openChords.media.pickLocalFile()",
    installedSystemEnvironment(),
    installedMediaPickerDriver("cancel_open_existing", path),
  );
  expect(cancelled).toMatchObject({ type: "media.selection_cancelled", operation: "pick" });
  expect(canonicalSerialize(await proofTreeHashes(library.activeRoot))).toBe(baseline);
  expect((await openProjectLibrary({ stateRoot: state })).listProjects()).toEqual([]);
  expect(readFileSync(path)).toEqual(original);

  const invalidPath = join(packageRoot, "native-source-invalid.wav");
  const invalidBytes = Buffer.from("private-invalid-media-fixture-not-a-WAV");
  writeFileSync(invalidPath, invalidBytes);
  const refused = await inspectInstalled(
    state,
    "window.openChords.media.pickLocalFile()",
    installedSystemEnvironment(),
    installedMediaPickerDriver("open", invalidPath),
  );
  expect(refused).toMatchObject({
    type: "desktop.error",
    code: "invalid_media",
    message: "Local media operation failed",
    retryable: false,
  });
  const refusedFields = z.record(z.string(), z.unknown()).parse(refused);
  for (const key of ["capabilityId", "projectId", "sourceId"]) {
    expect(Object.hasOwn(refusedFields, key)).toBe(false);
  }
  expect(canonicalSerialize(await proofTreeHashes(library.activeRoot))).toBe(baseline);
  expect((await openProjectLibrary({ stateRoot: state })).listProjects()).toEqual([]);
  expect((await openNetworkMode(state)).offline).toBe(true);
  expect(readFileSync(invalidPath)).toEqual(invalidBytes);
  expect(readFileSync(path)).toEqual(original);

  const result = await inspectInstalled(
    state,
    `(async () => {
      const recoveryRefusal = await window.openChords.media.pickLocalFile();
      const projectsAfterRefusal = await window.openChords.project.list();
      const selected = await window.openChords.media.pickLocalFile();
      if (selected.type !== "media.selected") return { recoveryRefusal, projectsAfterRefusal, selected };
      const created = await window.openChords.media.createProject({
        capabilityId: selected.capabilityId,
        startSourceSample: 0,
        endSourceSample: selected.durationSamples,
      });
      return { recoveryRefusal, projectsAfterRefusal, selected, created, offline: (await window.openChords.youtube.perform({type: "status"})).offline };
    })()`,
    installedSystemEnvironment(),
    async (applicationPid) => {
      await installedMediaPickerDriver("open", invalidPath)(applicationPid);
      expect(canonicalSerialize(await proofTreeHashes(library.activeRoot))).toBe(baseline);
      expect(readFileSync(invalidPath)).toEqual(invalidBytes);
      expect(readFileSync(path)).toEqual(original);
      await installedMediaPickerDriver("open", path)(applicationPid);
    },
  );
  const created = z
    .object({
      recoveryRefusal: z.object({
        type: z.literal("desktop.error"),
        code: z.literal("invalid_media"),
        message: z.literal("Local media operation failed"),
        retryable: z.literal(false),
      }),
      projectsAfterRefusal: z.object({
        type: z.literal("project.list"),
        projects: z.array(z.unknown()).length(0),
      }),
      selected: z.object({
        type: z.literal("media.selected"),
        durationSamples: z.literal(4),
        sampleRate: z.literal(48000),
      }),
      created: z.object({
        type: z.literal("media.project_created"),
        projectId: z.string(),
        projectRevisionId: z.string(),
        sourceId: z.string(),
      }),
      offline: z.literal(true),
    })
    .parse(result).created;
  for (const response of [cancelled, refused, result]) {
    expect(JSON.stringify(response).includes(invalidBytes.toString("utf8"))).toBe(false);
    for (const privatePath of [
      state,
      path,
      invalidPath,
      realpathSync(path),
      realpathSync(invalidPath),
    ]) {
      const escaped = JSON.stringify(privatePath).slice(1, -1);
      for (const representation of [privatePath, escaped, JSON.stringify(escaped).slice(1, -1)]) {
        expect(JSON.stringify(response).includes(representation)).toBe(false);
      }
    }
    expect(JSON.stringify(response).includes("playbackUrl")).toBe(false);
  }
  const reopened = await openProjectLibrary({ stateRoot: state });
  expect(reopened.listProjects().map(({ projectId }) => projectId)).toEqual([created.projectId]);
  const project = await reopened.readProject(created.projectId);
  expect(project.projectRevisionId).toBe(created.projectRevisionId);
  expect(project.records.projectRange).toEqual({
    sourceId: created.sourceId,
    startSourceSample: 0,
    endSourceSample: 4,
  });
  expect(project.envelope.payload).toMatchObject({
    id: created.projectId,
    durationSamples: 4,
    sampleRate: 48000,
    activeView: null,
    analysisRevisions: [],
    editLayers: [],
  });
  expect(project.records.sources).toHaveLength(1);
  const source = project.records.sources[0]!;
  expect(source.id).toBe(created.sourceId);
  expect(source.identity.kind).toBe("local_file");
  expect(source.snapshots).toMatchObject([
    {
      byteSize: original.length,
      durationSamples: 4,
      byteFingerprint: `sha256:${createNativeSelectionHash("sha256").update(original).digest("hex")}`,
    },
  ]);
  expect(source.locators).toHaveLength(1);
  const locator = source.locators[0]!;
  expect(locator.kind).toBe("local_file");
  if (locator.kind !== "local_file")
    throw new Error("Native selection did not create a local Locator");
  expect(locator.status).toBe("available");
  let sameFile = false;
  try {
    const actual = statSync(locator.path, { bigint: true });
    const expected = statSync(path, { bigint: true });
    sameFile = actual.ino !== 0n && actual.ino === expected.ino && actual.dev === expected.dev;
  } catch {
    // Report only the failed identity check, without private paths from stat errors.
  }
  expect(sameFile).toBe(true);
  expect(readFileSync(invalidPath)).toEqual(invalidBytes);
  expect(reopened.listExportReceipts(created.projectId)).toEqual([]);
  expect((await openNetworkMode(state)).offline).toBe(true);
  expect(readFileSync(path)).toEqual(original);

  const playbackBaseline = canonicalSerialize(await proofTreeHashes(reopened.activeRoot));
  const playback = await inspectInstalled(
    state,
    `(async () => {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        const audio = document.querySelector("audio");
        if (audio?.src.startsWith("open-chords:")) break;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      if (!document.querySelector("audio")?.src.startsWith("open-chords:")) {
        throw new Error("Native-selected Source playback was not ready");
      }
      const offlineBefore = (await window.openChords.youtube.perform({type: "status"})).offline;
      const response = await window.openChords.media.openPlayback(${JSON.stringify(created.projectId)});
      if (response.type !== "media.playback_ready") return { type: response.type };
      const head = await fetch(response.playbackUrl, { method: "HEAD" });
      const headBytes = (await head.arrayBuffer()).byteLength;
      const ranged = await fetch(response.playbackUrl, { headers: { Range: "bytes=44-${original.length - 1}" } });
      return {
        type: response.type,
        offlineBefore,
        offlineAfter: (await window.openChords.youtube.perform({type: "status"})).offline,
        head: { status: head.status, allow: head.headers.get("Allow"), bytes: headBytes },
        range: { status: ranged.status, contentRange: ranged.headers.get("Content-Range"), bytes: [...new Uint8Array(await ranged.arrayBuffer())] },
      };
    })()`,
    installedSystemEnvironment(),
  );
  expect(playback).toEqual({
    type: "media.playback_ready",
    offlineBefore: true,
    offlineAfter: true,
    head: { status: 405, allow: "GET, OPTIONS", bytes: 0 },
    range: {
      status: 206,
      contentRange: `bytes 44-${original.length - 1}/${original.length}`,
      bytes: [...original.subarray(44)],
    },
  });
  for (const privatePath of [
    state,
    path,
    invalidPath,
    realpathSync(path),
    realpathSync(invalidPath),
  ]) {
    const escaped = JSON.stringify(privatePath).slice(1, -1);
    for (const representation of [privatePath, escaped, JSON.stringify(escaped).slice(1, -1)]) {
      expect(JSON.stringify(playback).includes(representation)).toBe(false);
    }
  }
  expect(JSON.stringify(playback).includes("playbackUrl")).toBe(false);
  const playbackReopened = await openProjectLibrary({ stateRoot: state });
  expect(canonicalSerialize(await playbackReopened.readProject(created.projectId))).toBe(
    canonicalSerialize(project),
  );
  expect(canonicalSerialize(await proofTreeHashes(playbackReopened.activeRoot))).toBe(
    playbackBaseline,
  );
  expect(playbackReopened.listExportReceipts(created.projectId)).toEqual([]);
  expect((await openNetworkMode(state)).offline).toBe(true);
  expect(readFileSync(path)).toEqual(original);
  expect(readFileSync(invalidPath)).toEqual(invalidBytes);
});

test("installed local Source refusals and matching relink preserve Project revisions", async () => {
  test.setTimeout(process.platform === "win32" ? 900_000 : 480_000);
  for (const failure of ["missing", "changed"] as const) {
    const state = join(packageRoot, `source-refusal-${failure}`);
    const path = join(packageRoot, `source-refusal-${failure}.wav`);
    const original = monoPcmWav([0, 1, 2, 3]);
    writeFileSync(path, original);
    const library = await openProjectLibrary({ stateRoot: state });
    const media = new LocalMediaService({ library, pickFile: async () => path });
    const generationId = `generation_refusal_${failure}`;
    media.activateGeneration(generationId);
    const selected = await media.pickLocalFile(generationId);
    if (selected.kind !== "selected") throw new Error("Source refusal fixture was not selected");
    const created = await media.createProject({
      capabilityId: selected.capabilityId,
      endSourceSample: 4,
      generationId,
      startSourceSample: 0,
    });
    await media.revokeGeneration(generationId);
    await (await openNetworkMode(state)).setOffline(true);
    const baseline = await library.readProject(created.projectId);
    const immutableTree = async (root: string) =>
      canonicalSerialize(
        Object.fromEntries(
          Object.entries(await proofTreeHashes(root)).filter(
            ([name]) => name !== "source-catalog.json" && name !== "source-catalog.backup.json",
          ),
        ),
      );
    const treeBaseline = await immutableTree(library.activeRoot);
    if (failure === "missing") rmSync(path);
    else writeFileSync(path, monoPcmWav([4, 5, 6, 7]));
    const result = await inspectInstalled(
      state,
      `(async () => {
        const deadline = Date.now() + 10000;
        let alert;
        while (Date.now() < deadline) {
          const candidate = document.querySelector('.source-status[role="alert"]');
          if (candidate?.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) {
            alert = candidate;
            break;
          }
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        if (!alert) throw new Error("Source relink alert was not visible");
        const response = await window.openChords.media.openPlayback(${JSON.stringify(created.projectId)});
        return { response, message: alert.textContent };
      })()`,
      installedSystemEnvironment(),
    );
    const probe = z
      .object({
        response: z.object({
          type: z.string(),
          code: z.string().optional(),
        }),
      })
      .parse(result);
    const code = [
      "busy",
      "capability_unavailable",
      "internal_error",
      "invalid_media",
      "invalid_command",
      "invalid_generation",
      "project_not_found",
      "project_read_only",
      "source_unavailable",
      "stale_revision",
      "unauthorized_sender",
    ].includes(probe.response.code ?? "")
      ? probe.response.code
      : "none";
    const type = ["desktop.error", "media.source_unavailable", "media.playback_ready"].includes(
      probe.response.type,
    )
      ? probe.response.type
      : "unknown";
    process.stdout.write(
      `Installed Source refusal probe: scenario=${failure} type=${type} code=${code}\n`,
    );
    expect(result).toMatchObject({
      response: {
        type: "media.source_unavailable",
        projectId: created.projectId,
        sourceId: created.sourceId,
      },
      message: "The verified Source is unavailable. Relink it to enable playback.",
    });
    expect(JSON.stringify(result)).not.toContain(path);
    const escapedPath = JSON.stringify(path).slice(1, -1);
    expect(JSON.stringify(result)).not.toContain(escapedPath);
    expect(JSON.stringify(result)).not.toContain(JSON.stringify(escapedPath).slice(1, -1));
    expect(JSON.stringify(result)).not.toContain("playbackUrl");
    const reopened = await openProjectLibrary({ stateRoot: state });
    const after = await reopened.readProject(created.projectId);
    expect(after.projectRevisionId).toBe(baseline.projectRevisionId);
    expect(after.envelope).toEqual(baseline.envelope);
    const withoutLocators = (records: typeof after.records) => ({
      ...records,
      sources: records.sources.map((source) => ({ ...source, locators: [] })),
    });
    expect(withoutLocators(after.records)).toEqual(withoutLocators(baseline.records));
    expect(after.records.sources[0]?.locators).toEqual([
      expect.objectContaining({ path, status: "unavailable" }),
    ]);
    expect(await immutableTree(reopened.activeRoot)).toBe(treeBaseline);
    expect(reopened.listExportReceipts(created.projectId)).toEqual([]);
    if (failure === "missing") expect(() => readFileSync(path)).toThrow();
    else expect(readFileSync(path)).toEqual(monoPcmWav([4, 5, 6, 7]));

    const relocatedPath = join(packageRoot, `source-relinked-${failure}.wav`);
    writeFileSync(relocatedPath, original);
    if (["win32", "darwin"].includes(process.platform)) {
      const env = installedSystemEnvironment();
      const relink = (scenario: "open" | "cancel_open_existing", selectedPath: string) =>
        inspectInstalled(
          state,
          `(async () => {
          const deadline = Date.now() + 10000;
          while (Date.now() < deadline) {
            const alert = document.querySelector('.source-status[role="alert"]');
            if (alert?.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) break;
            await new Promise(resolve => setTimeout(resolve, 25));
          }
          return await window.openChords.media.relinkSource(${JSON.stringify(created.sourceId)});
        })()`,
          env,
          installedMediaPickerDriver(scenario, selectedPath),
        );
      const differentPath = join(packageRoot, `source-different-${failure}.wav`);
      const differentBytes = monoPcmWav([12, 13, 14, 15]);
      writeFileSync(differentPath, differentBytes);
      for (const [scenario, selectedPath, expectedType] of [
        ["cancel_open_existing", relocatedPath, "media.selection_cancelled"],
        ["open", differentPath, "media.different_source"],
      ] as const) {
        const refusalBaseline = canonicalSerialize(await proofTreeHashes(reopened.activeRoot));
        const response = await relink(scenario, selectedPath);
        expect(response).toMatchObject({ type: expectedType });
        for (const privatePath of [
          state,
          path,
          relocatedPath,
          differentPath,
          realpathSync(relocatedPath),
          realpathSync(differentPath),
        ]) {
          expect(JSON.stringify(response).includes(privatePath)).toBe(false);
          expect(JSON.stringify(response).includes(JSON.stringify(privatePath).slice(1, -1))).toBe(
            false,
          );
        }
        expect(canonicalSerialize(await proofTreeHashes(reopened.activeRoot))).toBe(
          refusalBaseline,
        );
        expect(readFileSync(relocatedPath)).toEqual(original);
        expect(readFileSync(differentPath)).toEqual(differentBytes);
        if (failure === "missing") expect(() => readFileSync(path)).toThrow();
        else expect(readFileSync(path)).toEqual(monoPcmWav([4, 5, 6, 7]));
      }
      const relinkResult = await relink("open", relocatedPath);
      expect(relinkResult).toMatchObject({ type: "media.relinked", sourceId: created.sourceId });
      for (const privatePath of [state, path, relocatedPath, realpathSync(relocatedPath)]) {
        expect(JSON.stringify(relinkResult).includes(privatePath)).toBe(false);
        expect(
          JSON.stringify(relinkResult).includes(JSON.stringify(privatePath).slice(1, -1)),
        ).toBe(false);
      }
    } else {
      const relinkMedia = new LocalMediaService({
        library: reopened,
        pickFile: async () => relocatedPath,
      });
      const relinkGeneration = `generation_relinked_${failure}`;
      relinkMedia.activateGeneration(relinkGeneration);
      try {
        expect(
          await relinkMedia.relinkSource({
            generationId: relinkGeneration,
            sourceId: created.sourceId,
          }),
        ).toEqual({ kind: "relinked", sourceId: created.sourceId });
      } finally {
        await relinkMedia.revokeGeneration(relinkGeneration);
      }
    }
    const relinkedLibrary = await openProjectLibrary({ stateRoot: state });
    const relinked = await relinkedLibrary.readProject(created.projectId);
    expect(relinked.projectRevisionId).toBe(baseline.projectRevisionId);
    expect(relinked.envelope).toEqual(baseline.envelope);
    expect(withoutLocators(relinked.records)).toEqual(withoutLocators(baseline.records));
    const relinkedLocators = relinked.records.sources[0]?.locators ?? [];
    expect(
      relinkedLocators.some(
        (locator) =>
          locator.kind === "local_file" &&
          locator.path === path &&
          locator.status === "unavailable",
      ),
      "Original Locator must remain unavailable",
    ).toBe(true);
    const canonicalRelocated = realpathSync(relocatedPath);
    expect(
      relinkedLocators.some((locator) => {
        if (locator.kind !== "local_file" || locator.status !== "available") return false;
        try {
          const resolved = realpathSync(locator.path);
          const exact = resolved === canonicalRelocated;
          let matches = exact;
          if (process.platform === "win32") {
            const native = realpathSync.native(locator.path) === realpathSync.native(relocatedPath);
            const casefold = resolved.toLowerCase() === canonicalRelocated.toLowerCase();
            const actual = statSync(locator.path, { bigint: true });
            const expected = statSync(relocatedPath, { bigint: true });
            const identity =
              actual.ino !== 0n && actual.ino === expected.ino && actual.dev === expected.dev;
            matches = identity;
            process.stdout.write(
              `Native Relink locator probe: scenario=${failure} resolved=true exact=${exact} native=${native} casefold=${casefold} identity=${identity}\n`,
            );
          }
          return matches;
        } catch {
          if (process.platform === "win32")
            process.stdout.write(
              `Native Relink locator probe: scenario=${failure} resolved=false\n`,
            );
          return false;
        }
      }),
      "Available Locator must resolve to the exact selected WAV",
    ).toBe(true);
    expect(await immutableTree(reopened.activeRoot)).toBe(treeBaseline);
    const relinkedTree = canonicalSerialize(await proofTreeHashes(relinkedLibrary.activeRoot));
    const playback = await inspectInstalled(
      state,
      `(async () => {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        const audio = document.querySelector("audio");
        if (audio?.src.startsWith("open-chords:")) break;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      const audio = document.querySelector("audio");
      if (!audio?.src.startsWith("open-chords:")) throw new Error("Relinked Source was not ready");
      const response = await window.openChords.media.openPlayback(${JSON.stringify(created.projectId)});
      if (response.type !== "media.playback_ready") return { type: response.type };
      const media = await fetch(response.playbackUrl, { headers: { Range: "bytes=0-${original.length - 1}" } });
      return { type: response.type, bytes: [...new Uint8Array(await media.arrayBuffer())], status: media.status, offline: (await window.openChords.youtube.perform({type: "status"})).offline };
    })()`,
      installedSystemEnvironment(),
    );
    expect(playback).toEqual({
      type: "media.playback_ready",
      bytes: [...original],
      status: 206,
      offline: true,
    });
    for (const privatePath of [path, relocatedPath]) {
      const escaped = JSON.stringify(privatePath).slice(1, -1);
      for (const representation of [privatePath, escaped, JSON.stringify(escaped).slice(1, -1)])
        expect(JSON.stringify(playback)).not.toContain(representation);
    }
    expect(JSON.stringify(playback)).not.toContain("playbackUrl");
    const relinkReopened = await openProjectLibrary({ stateRoot: state });
    expect(await relinkReopened.readProject(created.projectId)).toEqual(relinked);
    expect(canonicalSerialize(await proofTreeHashes(relinkReopened.activeRoot))).toBe(relinkedTree);
    expect(relinkReopened.listExportReceipts(created.projectId)).toEqual([]);
    expect((await openNetworkMode(state)).offline).toBe(true);
    expect(readFileSync(relocatedPath)).toEqual(original);
    if (failure === "missing") expect(() => readFileSync(path)).toThrow();
    else expect(readFileSync(path)).toEqual(monoPcmWav([4, 5, 6, 7]));
  }
});

function installedMediaPickerDriver(
  scenario: "open" | "cancel_open_existing",
  selectedPath: string,
) {
  if (process.platform === "darwin")
    return installedMacPickerDriver(scenario, selectedPath, installedSystemEnvironment);
  const env = installedSystemEnvironment();
  const windows = process.env.SystemRoot ?? process.env.WINDIR;
  if (!windows) throw new Error("Windows OS directory unavailable");
  return async (applicationPid: number) => {
    const evidence = await new Promise<unknown>((resolve, reject) => {
      const started = performance.now();
      runNativeFile(
        join(windows, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
        [
          "-NoProfile",
          "-NonInteractive",
          "-File",
          join(process.cwd(), "tests/support/installed-save-windows.ps1"),
          "-ApplicationPid",
          String(applicationPid),
          "-Scenario",
          scenario,
          "-Format",
          "media",
          "-TargetPath",
          selectedPath,
        ],
        { env, timeout: 100000, maxBuffer: 65536 },
        (error, stdout, stderr) => {
          if (error) {
            reject(
              new Error(installedSaveDriverDiagnostic(error, stderr, performance.now() - started)),
            );
            return;
          }
          try {
            console.log(installedSaveDriverTiming(stderr, performance.now() - started));
            resolve(JSON.parse(stdout.trim()));
          } catch {
            reject(new Error("Installed native media picker driver returned invalid evidence"));
          }
        },
      );
    });
    expect(evidence).toEqual({
      action: scenario,
      filenameSet: true,
      nativeClick: true,
      dialogDismissed: true,
      defaultNameValid: false,
    });
  };
}

function installedSystemEnvironment() {
  const env: Record<string, string> = {};
  for (const key of [
    "SystemRoot",
    "WINDIR",
    "TEMP",
    "TMP",
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
  ]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  if (process.platform === "win32") {
    const windowsRoot = env.SystemRoot ?? env.WINDIR;
    if (!windowsRoot) throw new Error("Windows system directory is unavailable");
    env.PATH = [
      join(windowsRoot, "System32", "WindowsPowerShell", "v1.0"),
      join(windowsRoot, "System32"),
      windowsRoot,
    ].join(";");
  }
  return env;
}

async function stopApplication(application: ReturnType<typeof spawn>): Promise<void> {
  if (application.exitCode !== null || application.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Packaged application did not exit after termination"));
    }, 5_000);
    application.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    application.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    if (process.platform === "win32" && application.pid !== undefined) {
      const terminator = spawn("taskkill", ["/pid", String(application.pid), "/t", "/f"], {
        stdio: "ignore",
      });
      terminator.once("error", () => application.kill());
      terminator.once("exit", (code) => {
        if (code !== 0) application.kill();
      });
      return;
    }
    if (!application.kill()) {
      clearTimeout(timeout);
      resolve();
    }
  });
}

async function waitForApplicationExit(
  application: ReturnType<typeof spawn>,
  timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      clearTimeout(timeout);
      application.off("exit", onExit);
      reject(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timeout);
      application.off("error", onError);
      resolve({ code, signal });
    };
    const timeout = setTimeout(() => {
      application.off("error", onError);
      application.off("exit", onExit);
      reject(new Error("Packaged lifecycle proof did not exit"));
      void stopApplication(application).catch(() => undefined);
    }, timeoutMs);
    application.once("error", onError);
    application.once("exit", onExit);
  });
}

async function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("Could not reserve a renderer debugging port"));
        return;
      }
      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

const CdpTargetsSchema = z.array(
  z.object({
    type: z.string(),
    url: z.string(),
    webSocketDebuggerUrl: z.url(),
  }),
);

const CdpEvaluationResponseSchema = z.object({
  id: z.number().int(),
  result: z.object({
    exceptionDetails: z.unknown().optional(),
    result: z.object({ value: z.unknown().optional() }),
  }),
});

const EffectiveCspProbeSchema = z.object({
  evalBlocked: z.literal(true),
  inlineScriptBlocked: z.literal(true),
});

const OfflinePlaybackSchema = z.object({
  workspaceProbe: WorkspacePlaybackProbeSchema.nullable(),
  offline: z.boolean(),
  body: z.string(),
  error: z.string().nullable(),
  pathKeyExposed: z.boolean(),
  played: z.boolean(),
  playAligned: z.boolean(),
  seeked: z.boolean(),
  status: z.number().int(),
  type: z.string(),
  urlProtocol: z.string(),
  workspacePlayed: z.boolean(),
  timelineMoved: z.boolean(),
});

const RendererSnapshotSchema = z.object({
  apiKeys: z.array(z.string()),
  modelsKeys: z.array(z.string()),
  contentSecurityPolicy: z.literal(EXPECTED_RENDERER_CSP),
  effectiveCsp: EffectiveCspProbeSchema,
  externalFetch: z.literal("rejected"),
  heading: z.string().nullable(),
  mediaKeys: z.array(z.string()),
  missingProject: z.object({
    code: z.literal("project_not_found"),
    type: z.literal("desktop.error"),
  }),
  nodeGlobals: z.object({
    Buffer: z.string(),
    ipcRenderer: z.string(),
    process: z.string(),
    require: z.string(),
  }),
  navigationDenied: z.literal(true),
  offlinePlayback: OfflinePlaybackSchema,
  permissionDenied: z.literal(true),
  popupDenied: z.literal(true),
  projectKeys: z.array(z.string()),
  projectList: z.object({
    projects: z.array(z.object({ projectId: z.string() })),
    type: z.literal("project.list"),
  }),
  resourceUrls: z.array(z.string()),
  security: z.object({
    security: z.object({
      contextIsolation: z.literal(true),
      nodeIntegration: z.literal(false),
      persistentSession: z.literal(false),
      sandbox: z.literal(true),
      webSecurity: z.literal(true),
    }),
    type: z.literal("shell.security_snapshot"),
  }),
  shellKeys: z.array(z.string()),
  undeclaredAssetStatus: z.number().int(),
  url: z.string(),
  webSecurityEnforced: z.literal(true),
});
const RendererSecuritySnapshotSchema = RendererSnapshotSchema.omit({
  offlinePlayback: true,
});

async function inspectPackagedRenderer(
  port: number,
  projectId: string,
): Promise<z.infer<typeof RendererSnapshotSchema>> {
  const endpoint = `http://127.0.0.1:${String(port)}`;
  const deadline = Date.now() + INSTALLED_STARTUP_TIMEOUT_MS;
  let lastError: unknown;
  while (Date.now() < deadline) {
    let target: z.infer<typeof CdpTargetsSchema>[number] | undefined;
    try {
      const response = await fetch(`${endpoint}/json/list`);
      const rawTargets: unknown = await response.json();
      target = CdpTargetsSchema.parse(rawTargets).find(
        (candidate) => candidate.type === "page" && candidate.url.startsWith("open-chords://"),
      );
    } catch (error) {
      lastError = error;
    }
    if (target !== undefined) {
      const offlinePlayback = await evaluatePackagedMedia(target.webSocketDebuggerUrl, projectId);
      const security = await evaluateRendererTarget(target.webSocketDebuggerUrl);
      return RendererSnapshotSchema.parse({ ...security, offlinePlayback });
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Could not inspect packaged renderer", { cause: lastError });
}

async function evaluatePackagedEditor(webSocketUrl: string): Promise<unknown> {
  // Use the same page-level CDP boundary as the installed security/playback probes.
  // Browser-level target discovery stalled this installed Electron probe in native CI.
  const expression = `(async () => {
    const deadline = Date.now() + 10000;
    const waitFor = async (read, stage) => {
      while (Date.now() < deadline) {
        const value = read();
        if (value) return value;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      throw new Error("Packaged editor stage timed out: " + stage);
    };
    const button = (label, parent = document) => [...parent.querySelectorAll("button")].find(element => element.textContent.trim() === label && !element.disabled);
    await waitFor(() => window.openChords && button("Edit chords"), "ready");
    const pickup = await waitFor(() => document.querySelector('[data-region-id="bar_pickup"]'), "timeline");
    const originalLabel = pickup.getAttribute("aria-label");
    button("Edit chords").click();
    const editor = await waitFor(() => document.querySelector('[aria-label="Chord Editor"]'), "opened");
    button("Choose chord", editor).click();
    const picker = await waitFor(() => editor.querySelector('[aria-label="Chord picker"]'), "picker");
    const root = picker.querySelector("select");
    root.value = "N";
    root.dispatchEvent(new Event("change", { bubbles: true }));
    await waitFor(() => picker.querySelectorAll("select").length === 1, "no_chord");
    button("Done", picker).click();
    (await waitFor(() => button("Save", editor), "valid_draft")).click();
    await waitFor(() => !document.querySelector('[aria-label="Chord Editor"]') && pickup.getAttribute("aria-label").includes("Chords: N"), "saved");
    const saved = await window.openChords.project.getSnapshot("project_golden");
    button("Undo edit").click();
    await waitFor(() => pickup.getAttribute("aria-label") === originalLabel, "undo");
    const undone = await window.openChords.project.getSnapshot("project_golden");
    (await waitFor(() => button("Set loop from selection"), "practice_loop_ready")).click();
    await waitFor(() => document.querySelector('.loop-status').textContent.includes("Pickup"), "practice_loop_saved");
    const choose = async (label, value) => {
      const select = await waitFor(() => { const element = document.querySelector('select[aria-label="' + label + '"]'); return element && !element.disabled && !element.closest('fieldset:disabled') ? element : null; }, "practice_setting_ready");
      select.value = value;
      select.dispatchEvent(new Event("change", {bubbles: true}));
      await new Promise(resolve => setTimeout(resolve, 0));
      await waitFor(() => select.value === value && document.querySelector('[aria-label="Practice settings status"]').textContent === "Practice saved" && !select.disabled && !select.closest('fieldset:disabled'), "practice_setting_saved");
    };
    await choose("Playback speed", "0.75");
    await choose("Instrument", "piano");
    const practiced = await window.openChords.project.getSnapshot("project_golden");
    button("Choose lyrics").click();
    const lyrics = await waitFor(() => document.querySelector('.lyrics-selection textarea'), "lyrics_open");
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(lyrics, "Installed local words");
    lyrics.dispatchEvent(new Event("input", { bubbles: true }));
    (await waitFor(() => button("Save new Lyrics Document"), "lyrics_valid")).click();
    await waitFor(() => document.querySelector('[aria-label="Lyrics selection status"]').textContent === "Lyrics saved", "lyrics_saved");
    const withLyrics = await window.openChords.project.getSnapshot("project_golden");
    return { lyricsSaved: withLyrics.type === "project.snapshot" && withLyrics.project.lyricsDocuments.some(document => document.id === withLyrics.project.activeView.lyricsDocumentId && document.text === "Installed local words"), saved: saved.type === "project.snapshot" && saved.project.activeView.editHistoryPosition === 2, undone: undone.type === "project.snapshot" && undone.project.activeView.editHistoryPosition === 0, practiceSaved: practiced.type === "project.snapshot" && practiced.project.practice.speed === 0.75 && practiced.project.practice.instrument === "piano" && practiced.project.practice.loop.firstBarId === "bar_pickup" };
  })()`;
  return evaluatePackagedExpression(webSocketUrl, expression);
}

async function evaluatePackagedExpression(
  webSocketUrl: string,
  expression: string,
  timeoutMs = 15_000,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketUrl);
    let requestId = 0;
    let settled = false;
    const finish = (error: Error | null, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.close();
      if (error !== null) reject(error);
      else resolve(value);
    };
    const timeout = setTimeout(
      () => finish(new Error("Packaged editor CDP evaluation timed out")),
      timeoutMs,
    );
    const evaluate = () => {
      if (settled) return;
      requestId += 1;
      socket.send(
        JSON.stringify({
          id: requestId,
          method: "Runtime.evaluate",
          params: { awaitPromise: true, expression, returnByValue: true, userGesture: true },
        }),
      );
    };
    socket.addEventListener("open", evaluate);
    socket.addEventListener("error", () =>
      finish(new Error("Packaged editor CDP connection failed")),
    );
    socket.addEventListener("close", () =>
      finish(new Error("Packaged editor CDP connection closed before completion")),
    );
    socket.addEventListener("message", (message) => {
      void handle(message.data);
    });
    async function handle(data: unknown) {
      try {
        const text = await decodeWebSocketMessage(data);
        if (text === null) return;
        const raw: unknown = JSON.parse(text);
        if (!z.object({ id: z.literal(requestId) }).safeParse(raw).success) return;
        const protocolError = z
          .object({ error: z.object({ code: z.number(), message: z.string() }) })
          .safeParse(raw);
        if (protocolError.success) {
          if (
            protocolError.data.error.code === -32000 &&
            protocolError.data.error.message === "Cannot find default execution context"
          ) {
            setTimeout(evaluate, 50);
            return;
          }
          finish(new Error("Packaged editor CDP protocol failed"));
          return;
        }
        const response = CdpEvaluationResponseSchema.parse(raw);
        if (response.result.exceptionDetails !== undefined) {
          finish(
            new Error(
              `Packaged editor journey failed: ${installedCdpExceptionDiagnostic(response.result.exceptionDetails)}`,
            ),
          );
          return;
        }
        finish(null, response.result.result.value);
      } catch {
        finish(new Error("Packaged editor response was invalid"));
      }
    }
  });
}

async function evaluateRendererTarget(webSocketUrl: string) {
  const expression = `new Promise((resolve, reject) => {
    const inspect = async () => {
      await new Promise((probeComplete) => {
        const image = new Image();
        const timeout = setTimeout(probeComplete, 500);
        const finish = () => {
          clearTimeout(timeout);
          probeComplete();
        };
        image.addEventListener("load", finish, { once: true });
        image.addEventListener("error", finish, { once: true });
        image.src = "open-chords://app/index.html?csp-probe";
        document.body.append(image);
      });
      await new Promise((probeComplete) => {
        const image = new Image();
        const timeout = setTimeout(probeComplete, 500);
        const finish = () => {
          clearTimeout(timeout);
          probeComplete();
        };
        image.addEventListener("load", finish, { once: true });
        image.addEventListener("error", finish, { once: true });
        image.src = "open-chords://app/asset-manifest.json";
        document.body.append(image);
      });
      const webSecurityEnforced = await new Promise((probeComplete) => {
        const frame = document.createElement("iframe");
        const timeout = setTimeout(() => {
          frame.remove();
          probeComplete(true);
        }, 500);
        frame.addEventListener("load", () => {
          clearTimeout(timeout);
          try {
            void frame.contentWindow.document.body;
            probeComplete(false);
          } catch {
            probeComplete(true);
          } finally {
            frame.remove();
          }
        }, { once: true });
        frame.src = "data:text/html,<p>cross-origin probe</p>";
        document.body.append(frame);
      });
      const permissionDenied = await Promise.race([
        Notification.requestPermission().then(
          (permission) => permission === "denied",
          () => true,
        ),
        new Promise((resolvePermission) => setTimeout(() => resolvePermission(true), 500)),
      ]);
      const popupDenied = window.open("https://example.com/", "_blank") === null;
      const originalUrl = window.location.href;
      const navigation = document.createElement("a");
      navigation.href = "https://example.com/";
      document.body.append(navigation);
      navigation.click();
      await new Promise((navigationSettled) => setTimeout(navigationSettled, 100));
      navigation.remove();
      const externalFetch = await Promise.race([
        fetch("https://www.youtube.com/iframe_api").then(
          () => "resolved",
          () => "rejected",
        ),
        new Promise((resolveFetch) => setTimeout(() => resolveFetch("rejected"), 500)),
      ]);
      const missingProject = await Promise.race([
        window.openChords.project.getSnapshot("project_missing"),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Project IPC timed out")), 1000)),
      ]);
      const projectList = await Promise.race([
        window.openChords.project.list(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Project list IPC timed out")), 1000)),
      ]);
      const security = await Promise.race([
        window.openChords.shell.getSecuritySnapshot(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Shell IPC timed out")), 1000)),
      ]);
      resolve({
      apiKeys: Object.keys(window.openChords).sort(),
      modelsKeys: Object.keys(window.openChords.models).sort(),
      externalFetch,
      heading: document.querySelector("h1")?.textContent ?? null,
      mediaKeys: Object.keys(window.openChords.media).sort(),
      missingProject,
      nodeGlobals: {
        Buffer: typeof globalThis.Buffer,
        ipcRenderer: typeof Reflect.get(globalThis, "ipcRenderer"),
        process: typeof globalThis.process,
        require: typeof globalThis.require,
      },
      navigationDenied: window.location.href === originalUrl,
      permissionDenied,
      popupDenied,
      projectKeys: Object.keys(window.openChords.project).sort(),
      projectList,
      resourceUrls: Array.from(document.querySelectorAll("script[src], link[rel=stylesheet][href]"))
        .map((element) => element instanceof HTMLScriptElement ? element.src : element.href)
        .filter((url) => url.startsWith("open-chords://")),
      security,
      shellKeys: Object.keys(window.openChords.shell).sort(),
      url: window.location.href,
      webSecurityEnforced,
      });
    };
    const runInspection = () => void inspect().catch(reject);
    if (document.readyState === "complete") runInspection();
    else window.addEventListener("load", runInspection, { once: true });
  })`;

  return new Promise<z.infer<typeof RendererSecuritySnapshotSchema>>((resolve, reject) => {
    const socket = new WebSocket(webSocketUrl);
    let contentSecurityPolicy: string | undefined;
    let effectiveCsp: z.infer<typeof EffectiveCspProbeSchema> | undefined;
    let refusedCsp: { observation: unknown } | undefined;
    let undeclaredAssetStatus: number | undefined;
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error(installedCspInterruptionDiagnostic("timeout", refusedCsp)));
    }, 5_000);
    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error(installedCspInterruptionDiagnostic("error", refusedCsp)));
    });
    socket.addEventListener("close", () => {
      clearTimeout(timeout);
      reject(new Error(installedCspInterruptionDiagnostic("close", refusedCsp)));
    });
    socket.addEventListener("open", () => {
      socket.send(
        JSON.stringify({
          id: 1,
          method: "Network.enable",
        }),
      );
    });
    socket.addEventListener("message", (message) => {
      void handleMessage(message.data);
    });

    async function handleMessage(rawData: unknown): Promise<void> {
      try {
        const text = await decodeWebSocketMessage(rawData);
        if (text === null) return;
        const rawResponse: unknown = JSON.parse(text);
        const networkResponse = z
          .object({
            method: z.literal("Network.responseReceived"),
            params: z.object({
              response: z.object({
                headers: z.record(z.string(), z.unknown()),
                status: z.number(),
                url: z.string(),
              }),
            }),
          })
          .safeParse(rawResponse);
        if (networkResponse.success) {
          if (
            networkResponse.data.params.response.url === "open-chords://app/index.html?csp-probe"
          ) {
            const header = Object.entries(networkResponse.data.params.response.headers).find(
              ([name]) => name.toLowerCase() === "content-security-policy",
            )?.[1];
            if (typeof header === "string") contentSecurityPolicy = header;
          }
          if (
            networkResponse.data.params.response.url === "open-chords://app/asset-manifest.json"
          ) {
            undeclaredAssetStatus = networkResponse.data.params.response.status;
          }
          return;
        }
        if (z.object({ id: z.literal(1) }).safeParse(rawResponse).success) {
          socket.send(
            JSON.stringify({
              id: 2,
              method: "Runtime.evaluate",
              params: {
                allowUnsafeEvalBlockedByCSP: false,
                awaitPromise: true,
                expression: `new Promise((resolve) => {
                  const probe = () => {
                    delete globalThis.__openChordsInlineCspProbe;
                    delete globalThis.__openChordsEvalCspProbe;
                    const script = document.createElement("script");
                    script.textContent = "globalThis.__openChordsInlineCspProbe = true";
                    document.head.append(script);
                    script.remove();
                    let evalBlocked = false;
                    try {
                      globalThis.eval("globalThis.__openChordsEvalCspProbe = true");
                    } catch {
                      evalBlocked = true;
                    }
                    const result = {
                      evalBlocked: evalBlocked && globalThis.__openChordsEvalCspProbe !== true,
                      inlineScriptBlocked: globalThis.__openChordsInlineCspProbe !== true,
                      documentUrl: location.href === "about:blank" ? "about_blank" : location.protocol === "open-chords:" && location.hostname === "app" ? location.pathname === "/index.html" ? "app_index" : "app_other" : "other",
                      isTopFrame: window.top === window,
                      topDocumentUrl: (() => {
                        try {
                          const topLocation = window.top.location;
                          return topLocation.href === "about:blank" ? "about_blank" : topLocation.protocol === "open-chords:" && topLocation.hostname === "app" ? topLocation.pathname === "/index.html" ? "app_index" : "app_other" : "other";
                        } catch { return "unavailable"; }
                      })(),
                      readyState: document.readyState,
                      preloadPresent: typeof window.openChords === "object" && window.openChords !== null,
                      metaCount: Math.min(17, document.querySelectorAll('meta[http-equiv="Content-Security-Policy"]').length),
                      metaMatches: document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content") === ${JSON.stringify(EXPECTED_RENDERER_CSP)},
                    };
                    delete globalThis.__openChordsInlineCspProbe;
                    delete globalThis.__openChordsEvalCspProbe;
                    resolve(result);
                  };
                  if (document.head === null) {
                    window.addEventListener("DOMContentLoaded", probe, { once: true });
                  } else {
                    probe();
                  }
                })`,
                returnByValue: true,
              },
            }),
          );
          return;
        }
        if (z.object({ id: z.literal(2) }).safeParse(rawResponse).success) {
          const response = CdpEvaluationResponseSchema.parse(rawResponse);
          if (response.result.exceptionDetails !== undefined) {
            throw new Error(
              `Effective packaged CSP probe threw: ${JSON.stringify(response.result.exceptionDetails)}`,
            );
          }
          const observed = response.result.result.value;
          const verifiedCsp = EffectiveCspProbeSchema.safeParse(observed);
          if (!verifiedCsp.success) {
            refusedCsp = { observation: observed };
            socket.send(JSON.stringify({ id: 5, method: "Page.getFrameTree" }));
            return;
          }
          effectiveCsp = verifiedCsp.data;
          socket.send(
            JSON.stringify({
              id: 3,
              method: "Page.setBypassCSP",
              params: { enabled: true },
            }),
          );
          return;
        }
        if (
          z.object({ id: z.literal(5) }).safeParse(rawResponse).success &&
          refusedCsp !== undefined
        ) {
          const tree = z
            .object({ result: z.object({ frameTree: z.unknown() }) })
            .safeParse(rawResponse);
          clearTimeout(timeout);
          socket.close();
          reject(
            new Error(
              `${installedEffectiveCspDiagnostic(refusedCsp.observation)}\n${installedCspFrameTreeDiagnostic(tree.success ? tree.data.result.frameTree : undefined)}`,
            ),
          );
          return;
        }
        const bypassResponse = z
          .object({ id: z.literal(3), error: z.unknown().optional() })
          .safeParse(rawResponse);
        if (bypassResponse.success) {
          if (bypassResponse.data.error !== undefined) {
            throw new Error("Could not isolate webSecurity from packaged CSP");
          }
          socket.send(
            JSON.stringify({
              id: 4,
              method: "Runtime.evaluate",
              params: { awaitPromise: true, expression, returnByValue: true },
            }),
          );
          return;
        }
        if (!z.object({ id: z.literal(4) }).safeParse(rawResponse).success) return;
        const response = CdpEvaluationResponseSchema.parse(rawResponse);
        if (response.result.exceptionDetails !== undefined) {
          throw new Error(
            `Renderer CDP evaluation threw: ${JSON.stringify(response.result.exceptionDetails)}`,
          );
        }
        const snapshotValue = z.record(z.string(), z.unknown()).parse(response.result.result.value);
        const snapshot = RendererSecuritySnapshotSchema.parse({
          ...snapshotValue,
          contentSecurityPolicy,
          effectiveCsp,
          undeclaredAssetStatus,
        });
        clearTimeout(timeout);
        socket.close();
        resolve(snapshot);
      } catch (error) {
        clearTimeout(timeout);
        socket.close();
        reject(error);
      }
    }
  });
}

async function evaluatePackagedMedia(
  webSocketUrl: string,
  projectId: string,
): Promise<z.infer<typeof OfflinePlaybackSchema>> {
  const projectIdLiteral = JSON.stringify(projectId);
  const expression = `(async () => {
    let playback = { type: "media.probe_failed" };
    let response = null;
    let body = "";
    let error = null;
    let played = false;
    let playAligned = false;
    let seeked = false;
    let workspacePlayed = false;
    let workspaceProbe = null;
    let timelineMoved = false;
    let offline = false;
    try {
      const network = await window.openChords.youtube.perform({ type: "set_offline", offline: true });
      offline = network.offline === true;
      if (!offline) throw new Error("Offline Mode was not enabled for local playback");
      const waitFor = async (read, message) => {
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline) {
          const value = read();
          if (value) return value;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        throw new Error(message);
      };
      const playButton = await waitFor(
        () => {
          const candidate = document.querySelector('button[aria-label="Play"]');
          return candidate instanceof HTMLButtonElement && !candidate.disabled ? candidate : null;
        },
        "workspace Play control timed out",
      );
      const track = document.querySelector(".timeline-track");
      const playhead = document.querySelector(".fixed-playhead");
      if (!(playButton instanceof HTMLElement) || !(track instanceof HTMLElement) || !(playhead instanceof HTMLElement)) {
        throw new Error("workspace playback geometry is unavailable");
      }
      const playBounds = playButton.getBoundingClientRect();
      const playheadBounds = playhead.getBoundingClientRect();
      playAligned = Math.abs(
        playBounds.left + playBounds.width / 2 - (playheadBounds.left + playheadBounds.width / 2),
      ) < 1;
      const transformBeforePlay = track.style.transform;
      // Preserve transient playback evidence even if the short fixture ends between timer ticks.
      await new Promise((resolve, reject) => {
        let mutations = 0;
        let oldPauseSeen = false;
        const fail = (message) => {
          observer.disconnect();
          try {
            const audio = document.querySelector("audio");
            const knownAudio = audio instanceof HTMLMediaElement;
            workspaceProbe = {
              stage: message === "workspace timeline did not move" ? "timeline" : "start",
              visibility: ["visible", "hidden"].includes(document.visibilityState) ? document.visibilityState : "other",
              ready: ["loading", "interactive", "complete"].includes(document.readyState) ? document.readyState : "other",
              buttonConnected: playButton.isConnected,
              buttonEnabled: !playButton.disabled,
              label: playButton.getAttribute("aria-label") === "Play" ? "play" : playButton.getAttribute("aria-label") === "Pause" ? "pause" : "other",
              trackConnected: track.isConnected,
              timelineChanged: track.style.transform !== transformBeforePlay,
              audioCount: Math.min(2, document.querySelectorAll("audio").length),
              audioReady: knownAudio ? audio.readyState : -1,
              audioNetwork: knownAudio ? audio.networkState : -1,
              audioError: knownAudio ? audio.error?.code ?? 0 : 0,
              audioPaused: knownAudio && audio.paused,
              audioEnded: knownAudio && audio.ended,
              audioPositionPositive: knownAudio && audio.currentTime > 0,
              audioSourcePresent: knownAudio && audio.currentSrc.length > 0,
              alertPresent: document.querySelector('[role="alert"]') !== null,
              mutations,
              oldPauseSeen,
            };
          } catch { /* A diagnostic read must not replace the original playback refusal. */ }
          reject(new Error(message));
        };
        let timeout;
        const observer = new MutationObserver((records) => {
          mutations = Math.min(256, mutations + records.length);
          oldPauseSeen ||= records.some((record) => record.target === playButton && record.attributeName === "aria-label" && record.oldValue === "Pause");
          const previouslyPlaying = workspacePlayed;
          workspacePlayed ||= playButton.getAttribute("aria-label") === "Pause";
          timelineMoved ||= track.style.transform !== transformBeforePlay;
          if (workspacePlayed && timelineMoved) {
            clearTimeout(timeout);
            observer.disconnect();
            resolve();
          } else if (!previouslyPlaying && workspacePlayed) {
            clearTimeout(timeout);
            timeout = setTimeout(() => fail("workspace timeline did not move"), 3000);
          }
        });
        timeout = setTimeout(() => fail("workspace playback did not start"), 3000);
        observer.observe(playButton, { attributes: true, attributeOldValue: true, attributeFilter: ["aria-label"] });
        observer.observe(track, { attributes: true, attributeFilter: ["style"] });
        playButton.click();
      });
      document.querySelector('button[aria-label="Pause"]')?.click();

      playback = await Promise.race([
        window.openChords.media.openPlayback(${projectIdLiteral}),
        new Promise((_, reject) => setTimeout(() => reject(new Error("openPlayback timed out")), 3000)),
      ]);
      if (playback.type === "media.playback_ready") {
        response = await Promise.race([
          fetch(playback.playbackUrl, { headers: { Range: "bytes=0-11" } }),
          new Promise((_, reject) => setTimeout(() => reject(new Error("media fetch timed out")), 3000)),
        ]);
        const bytes = await Promise.race([
          response.arrayBuffer(),
          new Promise((_, reject) => setTimeout(() => reject(new Error("media body timed out")), 2000)),
        ]);
        body = Array.from(new Uint8Array(bytes)).map((byte) => String.fromCharCode(byte)).join("");
        const audio = document.createElement("audio");
        audio.preload = "auto";
        audio.src = playback.playbackUrl;
        document.body.append(audio);
        await Promise.race([
          new Promise((resolve, reject) => {
            audio.addEventListener("loadedmetadata", resolve, { once: true });
            audio.addEventListener("error", () => reject(new Error("media element failed to load")), { once: true });
          }),
          new Promise((_, reject) => setTimeout(() => reject(new Error("media metadata timed out")), 3000)),
        ]);
        audio.currentTime = 0.25;
        await Promise.race([
          new Promise((resolve) => audio.addEventListener("seeked", resolve, { once: true })),
          new Promise((_, reject) => setTimeout(() => reject(new Error("media seek timed out")), 3000)),
        ]);
        seeked = Math.abs(audio.currentTime - 0.25) < 0.1;
        await Promise.race([
          audio.play(),
          new Promise((_, reject) => setTimeout(() => reject(new Error("media play timed out")), 3000)),
        ]);
        played = !audio.paused;
        audio.pause();
        audio.remove();
      }
    } catch (cause) {
      error = String(cause);
    }
    return {
      body,
      error,
      offline,
      pathKeyExposed: Object.keys(playback).some((key) => /path|directory/i.test(key)),
      played,
      playAligned,
      seeked,
      status: response?.status ?? 0,
      type: playback.type,
      urlProtocol: playback.type === "media.playback_ready"
        ? new URL(playback.playbackUrl).protocol
        : "",
      workspacePlayed,
      timelineMoved,
      workspaceProbe,
    };
  })()`;

  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketUrl);
    let requestId = 0;
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("Packaged media CDP evaluation timed out"));
    }, 10_000);
    const fail = (error: Error) => {
      clearTimeout(timeout);
      socket.close();
      reject(error);
    };
    socket.addEventListener("error", () => fail(new Error("Packaged media CDP connection failed")));
    const evaluate = () => {
      requestId += 1;
      socket.send(
        JSON.stringify({
          id: requestId,
          method: "Runtime.evaluate",
          params: {
            awaitPromise: true,
            expression,
            returnByValue: true,
            userGesture: true,
          },
        }),
      );
    };
    socket.addEventListener("open", evaluate);
    socket.addEventListener("message", (message) => {
      void handleMediaMessage(message.data);
    });

    async function handleMediaMessage(data: unknown): Promise<void> {
      try {
        const text = await decodeWebSocketMessage(data);
        if (text === null) return;
        const raw: unknown = JSON.parse(text);
        if (!z.object({ id: z.literal(requestId) }).safeParse(raw).success) return;
        const protocolError = z
          .object({
            error: z.object({ code: z.number(), message: z.string() }),
          })
          .safeParse(raw);
        if (protocolError.success) {
          if (
            protocolError.data.error.code === -32_000 &&
            protocolError.data.error.message === "Cannot find default execution context"
          ) {
            setTimeout(evaluate, 50);
            return;
          }
          fail(
            new Error(
              `Packaged media CDP protocol error ${String(protocolError.data.error.code)}: ${protocolError.data.error.message}`,
            ),
          );
          return;
        }
        const response = CdpEvaluationResponseSchema.parse(raw);
        if (response.result.exceptionDetails !== undefined) {
          fail(new Error("Packaged media CDP evaluation threw"));
          return;
        }
        const result = OfflinePlaybackSchema.parse(response.result.result.value);
        clearTimeout(timeout);
        socket.close();
        resolve(result);
      } catch (error) {
        fail(error instanceof Error ? error : new Error("Packaged media inspection failed"));
      }
    }
  });
}

async function decodeWebSocketMessage(data: unknown): Promise<string | null> {
  if (typeof data === "string") return data;
  if (data instanceof Blob) return data.text();
  if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(data);
  }
  return null;
}

test("installed MFA runtime verifies its manifest and starts without system Python or Conda", async () => {
  test.setTimeout(240_000);
  const { inspectAlignmentRuntime, packagedAlignmentRuntimeRoot } =
    await import("../../apps/desktop/src/main/alignment-runtime.ts");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const root = packagedAlignmentRuntimeRoot(resourcesPath);
  const info = await inspectAlignmentRuntime(root);
  expect(info.available).toBe(true);
  expect(info.installedBytes).toBeGreaterThan(0);
  const home = mkdtempSync(join(tmpdir(), "open-chords-mfa-installed-"));
  try {
    const env: Record<string, string> = {
      HOME: home,
      USERPROFILE: home,
      MFA_ROOT_DIR: home,
      APPDATA: home,
      LOCALAPPDATA: home,
      TEMP: home,
      TMP: home,
    };
    if (process.platform === "win32") {
      env.SystemRoot = process.env.SystemRoot!;
      env.PATH = join(env.SystemRoot, "System32");
    } else env.PATH = "/usr/bin:/bin";
    const executable = join(
      root,
      `open-chords-alignment${process.platform === "win32" ? ".exe" : ""}`,
    );
    const { stdout } = await promisify(execFile)(
      process.platform === "darwin" ? "/usr/bin/sandbox-exec" : executable,
      process.platform === "darwin"
        ? [
            "-p",
            '(version 1) (allow default) (deny file-read* (subpath "/opt/homebrew") (subpath "/usr/local"))',
            executable,
            "--probe",
          ]
        : ["--probe"],
      { env, timeout: 180_000, maxBuffer: 8192 },
    );
    expect(JSON.parse(stdout)).toEqual({
      runtime: "mfa",
      version: "3.4.1",
      kalpy: "KalpyAligner",
      fst: 0,
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("installed native Alignment worker runs exact EN/RU packs offline and publishes only verified occurrences", async () => {
  test.setTimeout(600_000);
  const { createHash, randomUUID } = await import("node:crypto");
  const { readdir, writeFile, stat, rename, rm } = await import("node:fs/promises");
  const { addLyricsDocument } = await import("@open-chords/domain");
  const { openAlignmentJobs } = await import("../../apps/desktop/src/main/alignment-jobs.ts");
  const { createContainedAlignmentWorker } =
    await import("../../apps/desktop/src/main/alignment-worker.ts");
  const { ALIGNMENT_PACKS } = await import("../../apps/desktop/src/main/alignment-packs.ts");
  const { openModelStore } = await import("../../apps/desktop/src/main/model-store.ts");
  const library = await openProjectLibrary({ stateRoot: userDataDirectory });
  const media = new LocalMediaService({ library, pickFile: async () => null });
  const source = await library.readProject(packagedProjectId);
  const modelStore = await openModelStore({
    stateRoot: userDataDirectory,
    packs: ALIGNMENT_PACKS,
    runtime: "mfa-3.4.1",
  });
  const runtimeRoot =
    process.platform === "darwin"
      ? join(
          resourcesPath,
          "..",
          "XPCServices",
          "OpenChordsAnalysisService.xpc",
          "Contents",
          "Resources",
          "open-chords-alignment",
        )
      : join(resourcesPath, "open-chords-alignment");
  const containmentRoot = join(resourcesPath, "containment");
  const digestFile = (path: string) =>
    createHash("sha256").update(readFileSync(path)).digest("hex");
  const worker = createContainedAlignmentWorker({
    stateRoot: userDataDirectory,
    runtimeRoot,
    runtimeManifestHash: digestFile(join(runtimeRoot, "runtime-info.json")),
    containmentRoot,
    containmentManifestHash: digestFile(join(containmentRoot, "containment-manifest.json")),
    ...(process.platform === "darwin"
      ? { bridgePath: join(resourcesPath, "..", "MacOS", "open-chords-containment-bridge") }
      : {}),
    media,
    modelStore,
  });
  const jobs = await openAlignmentJobs({
    stateRoot: userDataDirectory,
    modelStore,
    packs: ALIGNMENT_PACKS,
    runtimeManifestHash: digestFile(join(runtimeRoot, "runtime-info.json")),
  });
  for (const [language, text] of [
    ["en", "hello world\n(ＣＡＮ’T hello)\n[chorus]"],
    ["ru", "привет мир"],
  ] as const) {
    const pack = ALIGNMENT_PACKS.find((item) => item.language === language)!;
    await modelStore.install(pack.id);
    const envelope = ProjectEnvelopeSchema.parse(
      JSON.parse(
        readFileSync(
          join(process.cwd(), "packages/testkit/contracts/v1/valid/project-envelope.json"),
          "utf8",
        ),
      ),
    );
    envelope.payload.id = `project_native_alignment_${language}`;
    for (const revision of envelope.payload.analysisRevisions)
      revision.projectId = envelope.payload.id;
    envelope.payload = addLyricsDocument(
      envelope.payload,
      { text, language, format: "text" },
      `lyrics_native_${language}`,
    );
    const document = envelope.payload.lyricsDocuments.at(-1)!;
    const active = envelope.payload.activeView!;
    const layer = envelope.payload.editLayers.find((item) => item.id === active.editLayerId)!;
    layer.transactions.push({
      id: `anchor_transaction_${language}`,
      parentTransactionId: null,
      operations: [
        {
          type: "set_lyrics_anchor",
          anchor: {
            id: `anchor_native_${language}`,
            lyricsDocumentId: document.id,
            analysisRevisionId: active.analysisRevisionId,
            firstTokenId: document.tokens[0]!.id,
            lastTokenId: document.tokens[0]!.id,
            startSample: 12000,
            endSample: 24000,
          },
        },
      ],
    });
    active.editHistoryPosition = layer.transactions.length;
    await library.createProject({
      envelope,
      records: {
        ...source.records,
        legacyManifestlessAnalysisRevisionIds: envelope.payload.analysisRevisions.map(
          (item) => item.id,
        ),
      },
    });
    const job = await jobs.request({
      project: envelope.payload,
      lyricsDocumentId: `lyrics_native_${language}`,
      analysisRevisionId: envelope.payload.activeView!.analysisRevisionId,
      ...(await media.getAnalysisSource(envelope.payload.id)),
    });
    expect(await jobs.run(job.id, { library, worker })).toMatchObject({ state: "succeeded" });
    const result = (await library.getSnapshot(envelope.payload.id))!.project.lyricsAlignments.at(
      -1,
    )!;
    expect(result.provenance).toMatchObject({
      recipeHash: job.key,
      qualityStatus: "benchmark_pending",
    });
    expect(result.occurrences).toHaveLength(document.tokens.length);
    if (language === "en") {
      for (const occurrence of result.occurrences.slice(2, 4)) {
        expect(occurrence.timing).not.toMatchObject({ reasonCode: "annotation" });
        expect(occurrence.timing).not.toMatchObject({ reasonCode: "oov" });
      }
      expect(result.occurrences.at(-1)!.timing).toMatchObject({
        state: "unmatched",
        reasonCode: "annotation",
      });
    }
    if (language === "en")
      expect(result.occurrences.some((item) => item.timing.state === "matched")).toBe(true);
    expect(
      result.occurrences.every(
        (item) =>
          item.timing.state === "unmatched" || item.timing.assertion.state === "low_confidence",
      ),
    ).toBe(true);
    process.stdout.write(`Packaged Alignment stage: ${language}_published\n`);
    expect(await readdir(join(userDataDirectory, "alignment-workspaces"))).toEqual([]);
    if (language === "en") {
      const before = (await library.getSnapshot(envelope.payload.id))!;
      const lastTransaction = before.project.editLayers
        .find((item) => item.id === before.project.activeView!.editLayerId)!
        .transactions.at(-1)!;
      await library.commitEditTransaction({
        projectId: before.project.id,
        expectedProjectRevisionId: before.projectRevisionId,
        transaction: {
          id: "transaction_cancel_anchor",
          parentTransactionId: lastTransaction.id,
          operations: [
            {
              type: "set_lyrics_anchor",
              anchor: {
                id: "anchor_cancel_tail",
                lyricsDocumentId: document.id,
                analysisRevisionId: active.analysisRevisionId,
                firstTokenId: document.tokens[1]!.id,
                lastTokenId: document.tokens[1]!.id,
                startSample: 24000,
                endSample: 48000,
              },
            },
          ],
        },
      });
      const candidate = (await library.getSnapshot(before.project.id))!;
      const cancelJob = await jobs.request({
        project: candidate.project,
        lyricsDocumentId: document.id,
        analysisRevisionId: active.analysisRevisionId,
        ...(await media.getAnalysisSource(before.project.id)),
      });
      const jobsRoot = join(userDataDirectory, "alignment-jobs");
      const savedJobsRoot = `${jobsRoot}-stage-fault`;
      await expect(
        jobs.run(cancelJob.id, {
          library,
          worker: (input) =>
            worker({
              ...input,
              reportStage: async (stage) => {
                if (stage !== "aligning") return input.reportStage(stage);
                await rename(jobsRoot, savedJobsRoot);
                await writeFile(jobsRoot, "unavailable storage");
                try {
                  await input.reportStage(stage);
                } finally {
                  await rm(jobsRoot);
                  await rename(savedJobsRoot, jobsRoot);
                }
              },
            }),
        }),
      ).rejects.toBeInstanceOf(Error);
      expect(await jobs.get(cancelJob.id)).toMatchObject({
        state: "retryable",
        failure: "storage",
        circuitOpen: false,
      });
      expect(await readdir(join(userDataDirectory, "alignment-workspaces"))).toEqual([]);
      await jobs.confirm(cancelJob.id);
      const execution = jobs
        .run(cancelJob.id, {
          library,
          worker: (input) =>
            worker({
              ...input,
              reportStage: async (stage) => {
                await input.reportStage(stage);
                if (stage === "aligning") {
                  expect((await jobs.get(cancelJob.id))?.stage).toBe("aligning");
                  await jobs.cancel(cancelJob.id);
                }
              },
            }),
        })
        .then(
          (value) => value,
          (error: unknown) => error,
        );
      expect(await execution).toBeInstanceOf(Error);
      expect((await jobs.get(cancelJob.id))?.state).toBe("cancelled");
      expect((await library.getSnapshot(before.project.id))!.project.lyricsAlignments).toEqual(
        before.project.lyricsAlignments,
      );
      expect(await readdir(join(userDataDirectory, "alignment-workspaces"))).toEqual([]);
      process.stdout.write("Packaged Alignment stage: cancelled_and_cleaned\n");
      const { preparePackagedWorkspace } =
        await import("../../apps/desktop/src/main/packaged-sidecar-proof-workspace.ts");
      const { verifyContainmentRuntime } =
        await import("../../apps/desktop/src/main/sidecar-containment-integrity.ts");
      const { recoverAlignmentWorkspaces } =
        await import("../../apps/desktop/src/main/alignment-worker.ts");
      const recoveryOptions = {
        stateRoot: userDataDirectory,
        containmentRoot,
        containmentManifestHash: digestFile(join(containmentRoot, "containment-manifest.json")),
        ...(process.platform === "darwin"
          ? { bridgePath: join(resourcesPath, "../MacOS/open-chords-containment-bridge") }
          : {}),
      };
      const platform = process.platform === "darwin" ? "darwin" : "win32";
      const containment = verifyContainmentRuntime(
        containmentRoot,
        recoveryOptions.containmentManifestHash,
        platform,
        recoveryOptions.bridgePath,
      );
      const identity = randomUUID();
      await writeFile(join(userDataDirectory, "alignment-workspaces", identity), "", {
        flag: "wx",
      });
      const interrupted = preparePackagedWorkspace(
        platform,
        containment.helperPath,
        runtimeRoot,
        identity,
      );
      await writeFile(
        join(interrupted.workspace, "audio.wav"),
        Buffer.from("interrupted temporary audio"),
      );
      await recoverAlignmentWorkspaces(recoveryOptions);
      await expect(stat(interrupted.workspace)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readdir(join(userDataDirectory, "alignment-workspaces"))).toEqual([]);
      process.stdout.write("Packaged Alignment stage: interrupted_workspace_recovered\n");
    }
  }
  expect(
    await inspectInstalled(
      userDataDirectory,
      `(async () => {
    for (const language of ["en", "ru"]) {
      const projectId = "project_native_alignment_" + language;
      const snapshot = await window.openChords.project.getSnapshot(projectId);
      const status = await window.openChords.alignment.perform({ type: "status", projectId });
      if (snapshot.type !== "project.snapshot" || status.type !== "alignment.result") return false;
      const completed = status.jobs.find(job => job.state === "succeeded");
      if (!completed || !snapshot.project.lyricsAlignments.some(item => item.id === completed.alignmentId)) return false;
      const selected = await window.openChords.alignment.perform({ type: "select", projectId, expectedProjectRevisionId: snapshot.projectRevisionId, alignmentId: completed.alignmentId });
      if (selected.type !== "alignment.result") return false;
      const reopened = await window.openChords.project.getSnapshot(projectId);
      if (reopened.type !== "project.snapshot" || reopened.project.activeView.lyricsAlignmentId !== completed.alignmentId) return false;
    }
    return true;
  })()`,
    ),
  ).toBe(true);
});

function recordInstalledStartup(
  application: ReturnType<typeof spawn>,
  scenario: "shell" | "capability",
) {
  const started = Date.now();
  const stages =
    /^(?:Desktop startup stage: (?:library|network_mode|alignment_runtime|model_store|exports|archive_cache|renderer|window_created)|Desktop Library startup stage: (?:state_directory|relocation_journal|location|canonical_path|local_volume|initialize|relocation_cleanup|ready)|Desktop startup failed: (?:library|network_mode|alignment_runtime|model_store|exports|archive_cache|renderer|window_created)\.(?:ENOENT|EACCES|EPERM|ENOSPC|EINVAL|EIO|unknown))$/;
  for (const stream of [application.stdout, application.stderr]) {
    let pending = "";
    stream?.on("data", (chunk: Buffer) => {
      const lines = (pending + chunk.toString("utf8")).split("\n");
      pending = lines.pop()!.slice(-1024);
      for (const line of lines) {
        const safe = line.trim();
        if (stages.test(safe))
          process.stdout.write(
            `Installed startup probe: scenario=${scenario} elapsed_ms=${Date.now() - started} ${safe}\n`,
          );
      }
    });
  }
  return () => {
    const signal = application.signalCode;
    const safeSignal =
      signal && ["SIGTERM", "SIGKILL", "SIGABRT", "SIGSEGV"].includes(signal) ? signal : "none";
    process.stdout.write(
      `Installed startup probe: scenario=${scenario} elapsed_ms=${Date.now() - started} exit=${application.exitCode ?? "none"} signal=${safeSignal}\n`,
    );
  };
}

async function inspectInstalled(
  stateRoot: string,
  expression: string,
  env?: NodeJS.ProcessEnv,
  nativeDriver?: (applicationPid: number) => Promise<void>,
  nativeReadyExpression?: string,
) {
  const port = await reservePort();
  const application = spawn(
    executablePath,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${stateRoot}`,
      "--open-chords-startup-diagnostics",
    ],
    { env, stdio: ["ignore", "pipe", "pipe"] },
  );
  const startupProbe = recordInstalledStartup(application, "capability");
  let target: z.infer<typeof CdpTargetsSchema>[number] | undefined;
  let primaryFailure: { cause: unknown } | undefined;
  try {
    await expect
      .poll(
        async () => {
          try {
            target = CdpTargetsSchema.parse(
              await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(),
            ).find(
              (candidate) =>
                candidate.type === "page" && candidate.url.startsWith("open-chords://"),
            );
            return Boolean(target);
          } catch {
            return false;
          }
        },
        { timeout: INSTALLED_STARTUP_TIMEOUT_MS },
      )
      .toBe(true);
    if (!target) throw new Error("Installed Alignment capability is unavailable");
    const evaluation = evaluatePackagedExpression(
      target.webSocketDebuggerUrl,
      installedRendererExpression(expression),
      60000,
    );
    if (nativeDriver) {
      if (!application.pid) throw new Error("Installed native picker process unavailable");
      const applicationPid = application.pid;
      const webSocketUrl = target.webSocketDebuggerUrl;
      const [evaluated, driven] = await Promise.allSettled([
        evaluation,
        (async () => {
          if (nativeReadyExpression) {
            const ready = await evaluatePackagedExpression(
              webSocketUrl,
              installedRendererExpression(nativeReadyExpression),
              60000,
            );
            expect(ready).toBe(true);
          }
          await nativeDriver(applicationPid);
        })(),
      ]);
      if (driven.status === "rejected" && evaluated.status === "rejected")
        throw new AggregateError(
          [driven.reason, evaluated.reason],
          "Installed native driver and evaluator failed",
        );
      if (driven.status === "rejected") throw driven.reason;
      if (evaluated.status === "rejected") throw evaluated.reason;
      return evaluated.value;
    }
    return await evaluation;
  } catch (cause) {
    primaryFailure = { cause };
    if (nativeReadyExpression && target) {
      let observation: unknown;
      try {
        observation = await evaluatePackagedExpression(
          target.webSocketDebuggerUrl,
          "({ stage: document.documentElement?.dataset.installedChooseStage, rootPresent: document.documentElement !== null, preloadPresent: Boolean(window.openChords), readyState: document.readyState })",
          2000,
        );
      } catch {
        observation = undefined;
      }
      const parsed = z
        .object({
          stage: z.unknown().optional(),
          rootPresent: z.boolean(),
          preloadPresent: z.boolean(),
          readyState: z.enum(["loading", "interactive", "complete"]),
        })
        .safeParse(observation);
      const stage = parsed.success ? parsed.data.stage : undefined;
      const safeStage =
        typeof stage === "string" &&
        [
          "waiting_choose",
          "choose_clicked",
          "pending_observed",
          "cancel_restored",
          "retry_clicked",
          "workspace_visible",
          "snapshot_read",
        ].includes(stage)
          ? stage
          : "unknown";
      process.stdout.write(
        `Installed Choose evaluator: stage=${safeStage} root_present=${parsed.success ? parsed.data.rootPresent : "unknown"} preload_present=${parsed.success ? parsed.data.preloadPresent : "unknown"} ready=${parsed.success ? parsed.data.readyState : "unknown"}\n`,
      );
    }
    throw cause;
  } finally {
    startupProbe();
    const cleanupFailures: unknown[] = [];
    try {
      if (target) await quitInstalledApplication(application, target.webSocketDebuggerUrl);
    } catch (cause) {
      cleanupFailures.push(cause);
    }
    try {
      if (
        process.platform !== "win32" &&
        application.exitCode === null &&
        application.signalCode === null
      )
        application.kill("SIGKILL");
      await stopApplication(application);
    } catch (cause) {
      cleanupFailures.push(cause);
    }
    throwCombinedFailures(
      "Installed inspection and shutdown failed",
      primaryFailure,
      cleanupFailures,
    );
  }
}

async function quitInstalledApplication(
  application: ReturnType<typeof spawn>,
  webSocketUrl: string,
) {
  if (application.exitCode !== null || application.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(webSocketUrl);
    let sent = false;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      application.off("exit", onExit);
      socket.close();
      if (error) reject(error);
      else resolve();
    };
    const onExit = (code: number | null) =>
      finish(code === 0 ? undefined : new Error("Installed app did not quit cleanly"));
    const timeout = setTimeout(
      () => finish(new Error("Installed app quit lifecycle timed out")),
      15000,
    );
    application.once("exit", onExit);
    socket.addEventListener(
      "error",
      () => {
        // Quit may close the debugging socket before the process exit event.
        // Once sent, only a clean exit proves completion; the deadline remains active.
        if (!sent) finish(new Error("Installed app quit connection failed"));
      },
      { once: true },
    );
    // Electron handles Browser.close by invoking Browser::Quit on its main thread.
    socket.addEventListener(
      "open",
      () => {
        socket.send(JSON.stringify({ id: 1, method: "Browser.close" }));
        sent = true;
      },
      { once: true },
    );
  });
}

test("installed app installs an exact English pack, reopens, and removes it through named IPC", async () => {
  test.setTimeout(480_000);
  const stateRoot = join(packageRoot, "models-user-data");
  const operate = async (body: string) => {
    const port = await reservePort();
    const application = spawn(
      executablePath,
      [`--remote-debugging-port=${port}`, `--user-data-dir=${stateRoot}`],
      { stdio: "ignore" },
    );
    try {
      let target: z.infer<typeof CdpTargetsSchema>[number] | undefined;
      await expect
        .poll(
          async () => {
            try {
              const response = await fetch(`http://127.0.0.1:${port}/json/list`);
              target = CdpTargetsSchema.parse(await response.json()).find(
                (candidate) =>
                  candidate.type === "page" && candidate.url.startsWith("open-chords://"),
              );
              return Boolean(target);
            } catch {
              return false;
            }
          },
          { timeout: 30_000 },
        )
        .toBe(true);
      if (!target) throw new Error("Installed model capability is unavailable");
      return await evaluatePackagedExpression(
        target.webSocketDebuggerUrl,
        `(async () => {
        const deadline = Date.now() + 10000;
        while (!window.openChords && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
        const perform = action => window.openChords.models.perform(action);
        ${body}
      })()`,
        330_000,
      );
    } finally {
      if (process.platform !== "win32") application.kill("SIGKILL");
      await stopApplication(application);
    }
  };
  expect(
    await operate(`
    const before = await perform({type: "status"});
    if (before.type !== "models.result" || !before.runtime.available || before.packs.some(pack => pack.installed)) return false;
    const installed = await perform({type: "install", packId: "english_mfa-3.1.0"});
    return installed.type === "models.result" && installed.packs.find(pack => pack.language === "en").installed;
  `),
  ).toBe(true);
  expect(
    await operate(`
    const reopened = await perform({type: "status"});
    if (reopened.type !== "models.result" || !reopened.packs.find(pack => pack.language === "en").installed) return false;
    const preview = await perform({type: "preview_removal", packId: "english_mfa-3.1.0"});
    if (preview.type !== "models.result" || preview.removal.affectedProjectIds.length !== 0) return false;
    const removed = await perform({type: "remove", packId: preview.removal.packId, impactId: preview.removal.impactId});
    return removed.type === "models.result" && removed.packs.every(pack => !pack.installed);
  `),
  ).toBe(true);
  expect(
    await operate(`
    const reopened = await perform({type: "status"});
    return reopened.type === "models.result" && reopened.packs.every(pack => !pack.installed);
  `),
  ).toBe(true);
});

import { randomUUID } from "node:crypto";
import { writeSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  DESKTOP_IPC_PROTOCOL,
  DESKTOP_IPC_VERSION,
  ProjectEventSchema,
} from "@open-chords/contracts";
import { app, dialog, shell, powerMonitor, type BrowserWindow, type WebContents } from "electron";

import {
  EXPECTED_ACQUISITION_MANIFEST_SHA256,
  EXPECTED_ACQUISITION_POLICY_SHA256,
} from "./acquisition-build-metadata.ts";
import {
  AcquisitionJobsOpenError,
  openAcquisitionJobs,
  type AcquisitionJobs,
} from "./acquisition-jobs.ts";
import { EXPECTED_ALIGNMENT_MANIFEST_SHA256 } from "./alignment-build-metadata.ts";
import { ALIGNMENT_PACKS } from "./alignment-packs.ts";
import { inspectAlignmentRuntime, packagedAlignmentRuntimeRoot } from "./alignment-runtime.ts";
import { openAlignmentService, type AlignmentService } from "./alignment-service.ts";
import { createContainedAlignmentWorker, recoverAlignmentWorkspaces } from "./alignment-worker.ts";
import { EXPECTED_CONTAINMENT_MANIFEST_SHA256 } from "./containment-build-metadata.ts";
import { blockCpuWorkAfterIncompleteCleanup } from "./cpu-work.ts";
import { installDesktopIpc, publishProjectEvent } from "./desktop-ipc.ts";
import { openJsonExports, type JsonExports } from "./json-exports.ts";
import { LocalMediaService } from "./local-media.ts";
import { openLyricsDiscovery, type LyricsDiscovery } from "./lyrics-discovery.ts";
import { createMediaCleanupBeforeQuitHandler } from "./media-shutdown.ts";
import { openModelStore, type ModelStore } from "./model-store.ts";
import { openNetworkMode } from "./network-mode.ts";
import { runPackagedAcquisitionProof } from "./packaged-acquisition-proof.ts";
import { PACKAGED_SIDECAR_PROOF_ARGUMENT } from "./packaged-sidecar-proof-constants.ts";
import { packagedProofFailureCode, runPackagedSidecarProof } from "./packaged-sidecar-proof.ts";
import { openProjectLibrary } from "./project-library.ts";
import { installRendererProtocol, registerRendererScheme } from "./renderer-protocol.ts";
import {
  PRIMARY_RENDERER_SECURITY_CONFIGURATION,
  type DesktopSecurityConfiguration,
} from "./renderer-security.ts";
import { createDesktopWindow, hardenWebContents } from "./shell.ts";
import { EXPECTED_SIDECAR_MANIFEST_SHA256 } from "./sidecar-build-metadata.ts";
import { presentDesktopWindow } from "./window-lifecycle.ts";
import { IsolatedYouTubePlayer, isYouTubePlayerSession } from "./youtube-player.ts";
import { YouTubeService } from "./youtube-service.ts";
import { YouTubeMetadata } from "./youtube-source.ts";

if (
  process.argv.includes(PACKAGED_SIDECAR_PROOF_ARGUMENT) ||
  process.argv.includes("--open-chords-acquisition-proof")
) {
  // Electron otherwise opens a modal error dialog, hiding native CI failures
  // behind the outer process timeout. Never continue after an uncaught error.
  process.on("uncaughtException", (error) => {
    const allowedCodes = new Set([
      "ABORT_ERR",
      "EACCES",
      "ECONNRESET",
      "ENOENT",
      "EPERM",
      "EPIPE",
      "ERR_INVALID_ARG_TYPE",
      "ERR_INVALID_STATE",
      "ERR_OUT_OF_RANGE",
      "ERR_STREAM_DESTROYED",
    ]);
    const code: unknown = Object.getOwnPropertyDescriptor(error, "code")?.value;
    const kind =
      error instanceof TypeError
        ? "TypeError"
        : error instanceof RangeError
          ? "RangeError"
          : error instanceof SyntaxError
            ? "SyntaxError"
            : error instanceof AggregateError
              ? "AggregateError"
              : "Error";
    try {
      writeSync(
        2,
        `Packaged sidecar proof uncaught: ${kind}.${typeof code === "string" && allowedCodes.has(code) ? code : "unknown"}\n`,
      );
    } finally {
      app.exit(1);
    }
  });
  process.stderr.write("Packaged sidecar proof stage: application_started\n");
  void app
    .whenReady()
    .then(
      process.argv.includes("--open-chords-acquisition-proof")
        ? runPackagedAcquisitionProof
        : runPackagedSidecarProof,
    )
    .then(
      () => app.exit(0),
      (cause: unknown) => {
        process.stderr.write(`Packaged sidecar proof failed: ${packagedProofFailureCode(cause)}\n`);
        app.exit(1);
      },
    );
} else {
  if (process.platform === "win32") app.setAppUserModelId("io.github.qisoft.open-chords");
  registerRendererScheme();

  const MEDIA_CLEANUP_TIMEOUT_MS = 30_000;
  const ownsSingleInstance = app.requestSingleInstanceLock();
  let modelStore: ModelStore | null = null;
  let alignmentService: AlignmentService | null = null;
  let lyricsDiscovery: LyricsDiscovery | null = null;
  let youtube: YouTubeService | null = null;
  let acquisition: AcquisitionJobs | null = null;
  let jsonExports: JsonExports | null = null;
  let mainWindow: BrowserWindow | null = null;
  let localMediaAuthority: LocalMediaService | null = null;
  const rendererContexts = new Map<
    number,
    {
      generationId: string;
      security: DesktopSecurityConfiguration;
    }
  >();

  if (!ownsSingleInstance) {
    app.quit();
  } else {
    app.on(
      "before-quit",
      createMediaCleanupBeforeQuitHandler({
        dispose: async () => {
          jsonExports?.cancel();
          youtube?.close();
          try {
            await acquisition?.close();
          } finally {
            try {
              await alignmentService?.dispose();
            } finally {
              await localMediaAuthority?.dispose();
            }
          }
        },
        exitWithFailure: () => app.exit(1),
        quit: () => app.quit(),
        timeoutMs: MEDIA_CLEANUP_TIMEOUT_MS,
      }),
    );
    app.on("web-contents-created", (_event, contents) => {
      if (!isYouTubePlayerSession(contents.session)) hardenWebContents(contents);
    });
    app.on("second-instance", () => {
      void desktopReady.then(() => presentDesktopWindow(getOrCreateWindow()));
    });

    app.on("activate", () => {
      void desktopReady.then(() => presentDesktopWindow(getOrCreateWindow()));
    });

    app.on("window-all-closed", () => {
      lyricsDiscovery?.cancel();
      modelStore?.cancel();
      if (process.platform !== "darwin") app.quit();
    });

    const desktopReady = app
      .whenReady()
      .then(async () => {
        const projectLibrary = await openProjectLibrary({ stateRoot: app.getPath("userData") });
        const stateRoot = app.getPath("userData");
        jsonExports = await openJsonExports({
          library: projectLibrary,
          stateRoot,
          protectedRoots: [app.getAppPath(), process.resourcesPath, dirname(process.execPath)],
          pickTarget: async () => {
            const result = await dialog.showSaveDialog(getOrCreateWindow(), {
              title: "Export Open Chords JSON",
              defaultPath: "Open Chords.json",
              filters: [{ name: "Open Chords JSON", extensions: ["json"] }],
            });
            return result.canceled ? null : result.filePath;
          },
        });
        const network = await openNetworkMode(stateRoot);
        const packagedNativeRoot =
          process.platform === "darwin"
            ? join(
                process.resourcesPath,
                "../XPCServices/OpenChordsAnalysisService.xpc/Contents/Resources",
              )
            : process.resourcesPath;
        const acquisitionContainment = {
          containmentRoot: app.isPackaged
            ? join(
                process.resourcesPath,
                process.platform === "darwin" ? "../MacOS/containment" : "containment",
              )
            : join(app.getAppPath(), "dist/containment"),
          containmentManifestHash: EXPECTED_CONTAINMENT_MANIFEST_SHA256,
          ...(app.isPackaged && process.platform === "darwin"
            ? { bridgePath: join(process.resourcesPath, "../MacOS/open-chords-containment-bridge") }
            : {}),
        };
        try {
          acquisition = await openAcquisitionJobs({
            stateRoot,
            network,
            library: projectLibrary,
            policyHash: EXPECTED_ACQUISITION_POLICY_SHA256,
            runtime: {
              ...acquisitionContainment,
              runtimeRoot: app.isPackaged
                ? join(packagedNativeRoot, "open-chords-acquisition")
                : join(app.getAppPath(), "dist/acquisition-runtime/open-chords-acquisition"),
              runtimeManifestHash: EXPECTED_ACQUISITION_MANIFEST_SHA256,
            },
            validation: {
              ...acquisitionContainment,
              runtimeRoot: app.isPackaged
                ? join(packagedNativeRoot, "open-chords-analysis")
                : join(app.getAppPath(), "dist/analysis-sidecar/open-chords-analysis"),
              runtimeManifestHash: EXPECTED_SIDECAR_MANIFEST_SHA256,
            },
          });
        } catch (error) {
          const code =
            error instanceof AcquisitionJobsOpenError ? error.code : "cleanup_unverified";
          if (code === "cleanup_unverified") blockCpuWorkAfterIncompleteCleanup();
          console.warn(`Acquisition unavailable: ${code}`);
        }
        youtube = new YouTubeService({
          ...(acquisition ? { acquisition } : {}),
          library: projectLibrary,
          network,
          metadata: new YouTubeMetadata({ network }),
          player: new IsolatedYouTubePlayer(),
          openExternal: (url) => shell.openExternal(url),
        });
        lyricsDiscovery = await openLyricsDiscovery({ stateRoot, network });
        const runtime = await inspectAlignmentRuntime(
          app.isPackaged
            ? packagedAlignmentRuntimeRoot(process.resourcesPath)
            : join(app.getAppPath(), "dist/alignment-runtime/open-chords-alignment"),
          EXPECTED_ALIGNMENT_MANIFEST_SHA256,
        );
        modelStore = await openModelStore({
          stateRoot,
          packs: ALIGNMENT_PACKS,
          runtime: runtime.available ? runtime.id : "unavailable",
          network,
        });
        const localMedia = new LocalMediaService({
          library: projectLibrary,
          pickFile: async () => {
            const result = await dialog.showOpenDialog(getOrCreateWindow(), {
              filters: [{ extensions: ["wav", "wave"], name: "Wave audio" }],
              properties: ["openFile"],
            });
            return result.canceled || result.filePaths.length !== 1 ? null : result.filePaths[0]!;
          },
        });
        localMediaAuthority = localMedia;
        try {
          await recoverAlignmentWorkspaces({
            stateRoot,
            containmentRoot: app.isPackaged
              ? join(
                  process.resourcesPath,
                  process.platform === "darwin" ? "../MacOS/containment" : "containment",
                )
              : join(app.getAppPath(), "dist/containment"),
            containmentManifestHash: EXPECTED_CONTAINMENT_MANIFEST_SHA256,
            ...(app.isPackaged && process.platform === "darwin"
              ? {
                  bridgePath: join(
                    process.resourcesPath,
                    "../MacOS/open-chords-containment-bridge",
                  ),
                }
              : {}),
          });
          alignmentService = await openAlignmentService({
            runtimeManifestHash: EXPECTED_ALIGNMENT_MANIFEST_SHA256,
            stateRoot,
            modelStore,
            packs: ALIGNMENT_PACKS,
            library: projectLibrary,
            media: localMedia,
            worker: createContainedAlignmentWorker({
              stateRoot,
              runtimeRoot: app.isPackaged
                ? packagedAlignmentRuntimeRoot(process.resourcesPath)
                : join(app.getAppPath(), "dist/alignment-runtime/open-chords-alignment"),
              runtimeManifestHash: EXPECTED_ALIGNMENT_MANIFEST_SHA256,
              containmentRoot: app.isPackaged
                ? join(
                    process.resourcesPath,
                    process.platform === "darwin" ? "../MacOS/containment" : "containment",
                  )
                : join(app.getAppPath(), "dist/containment"),
              containmentManifestHash: EXPECTED_CONTAINMENT_MANIFEST_SHA256,
              ...(app.isPackaged && process.platform === "darwin"
                ? {
                    bridgePath: join(
                      process.resourcesPath,
                      "../MacOS/open-chords-containment-bridge",
                    ),
                  }
                : {}),
              modelStore,
              media: localMedia,
            }),
          });
        } catch {
          // Preserve the desktop and project access, but never start another
          // native workload when interrupted workspace cleanup is unverified.
          blockCpuWorkAfterIncompleteCleanup();
          alignmentService = null;
        }
        installRendererProtocol(join(__dirname, "../renderer"), localMedia);
        powerMonitor.on("suspend", () => {
          void alignmentService?.setSuspended(true).catch(() => app.exit(1));
        });
        powerMonitor.on("resume", () => {
          void alignmentService?.setSuspended(false).catch(() => app.exit(1));
        });
        projectLibrary.subscribe(({ projectId, projectRevisionId, sequence }) => {
          const window = mainWindow;
          if (window === null || window.isDestroyed()) return;
          const rendererContext = rendererContexts.get(window.webContents.id);
          if (rendererContext === undefined) return;
          publishProjectEvent(
            window.webContents,
            ProjectEventSchema.parse({
              generationId: rendererContext.generationId,
              projectId,
              projectRevisionId,
              protocol: DESKTOP_IPC_PROTOCOL,
              protocolVersion: DESKTOP_IPC_VERSION,
              sequence,
              type: "project.changed",
            }),
          );
        });
        installDesktopIpc(projectLibrary, {
          exports: jsonExports,
          youtube,
          ...(alignmentService ? { alignment: alignmentService } : {}),
          models: {
            store: modelStore,
            network,
            runtime,
            references: () => projectLibrary.listModelReferences(),
          },
          lyrics: { discovery: lyricsDiscovery, openExternal: (url) => shell.openExternal(url) },
          mediaAuthority: localMedia,
          onSenderAction: (_action, sender) => replaceCompromisedRenderer(sender),
          rendererContextFor: (sender) => rendererContexts.get(sender.id) ?? null,
        });
        getOrCreateWindow();
        return undefined;
      })
      .catch(() => {
        app.exit(1);
      });
  }

  function getOrCreateWindow() {
    if (mainWindow === null || mainWindow.isDestroyed()) {
      lyricsDiscovery?.cancel();
      modelStore?.cancel();
      const generationId = `generation_${randomUUID().replaceAll("-", "")}`;
      const window = createDesktopWindow(generationId);
      localMediaAuthority?.activateGeneration(generationId);
      mainWindow = window;
      const webContentsId = window.webContents.id;
      rendererContexts.set(webContentsId, {
        generationId,
        security: {
          ...PRIMARY_RENDERER_SECURITY_CONFIGURATION,
          persistentSession: window.webContents.session.isPersistent(),
        },
      });
      window.webContents.once("destroyed", () => {
        revokeRendererGeneration(webContentsId);
      });
      window.once("closed", () => {
        if (mainWindow === window) mainWindow = null;
      });
    }
    return mainWindow;
  }

  function replaceCompromisedRenderer(sender: WebContents): void {
    const isMainRenderer = mainWindow?.webContents === sender;
    revokeRendererGeneration(sender.id);
    if (!sender.isDestroyed()) sender.close({ waitForBeforeUnload: false });
    if (isMainRenderer) {
      mainWindow = null;
      queueMicrotask(() => getOrCreateWindow());
    }
  }

  function revokeRendererGeneration(webContentsId: number): void {
    jsonExports?.cancel();
    youtube?.cancel();
    lyricsDiscovery?.cancel();
    modelStore?.cancel();
    const context = rendererContexts.get(webContentsId);
    rendererContexts.delete(webContentsId);
    if (context !== undefined && localMediaAuthority !== null) {
      void localMediaAuthority.revokeGeneration(context.generationId).catch(() => app.exit(1));
    }
  }
}

import { randomUUID } from "node:crypto";
import { join } from "node:path";

import {
  DESKTOP_IPC_PROTOCOL,
  DESKTOP_IPC_VERSION,
  ProjectEventSchema,
} from "@open-chords/contracts";
import { app, dialog, type BrowserWindow, type WebContents } from "electron";

import { installDesktopIpc, publishProjectEvent } from "./desktop-ipc.ts";
import { LocalMediaService } from "./local-media.ts";
import { createMediaCleanupBeforeQuitHandler } from "./media-shutdown.ts";
import { openProjectLibrary } from "./project-library.ts";
import { installRendererProtocol, registerRendererScheme } from "./renderer-protocol.ts";
import {
  PRIMARY_RENDERER_SECURITY_CONFIGURATION,
  type DesktopSecurityConfiguration,
} from "./renderer-security.ts";
import { createDesktopWindow, hardenWebContents } from "./shell.ts";
import { presentDesktopWindow } from "./window-lifecycle.ts";

registerRendererScheme();

const MEDIA_CLEANUP_TIMEOUT_MS = 5_000;
const ownsSingleInstance = app.requestSingleInstanceLock();
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
      dispose: () => localMediaAuthority?.dispose() ?? Promise.resolve(),
      exitWithFailure: () => app.exit(1),
      quit: () => app.quit(),
      timeoutMs: MEDIA_CLEANUP_TIMEOUT_MS,
    }),
  );
  app.on("web-contents-created", (_event, contents) => hardenWebContents(contents));
  app.on("second-instance", () => {
    void desktopReady.then(() => presentDesktopWindow(getOrCreateWindow()));
  });

  app.on("activate", () => {
    void desktopReady.then(() => presentDesktopWindow(getOrCreateWindow()));
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  const desktopReady = app
    .whenReady()
    .then(async () => {
      const projectLibrary = await openProjectLibrary({ stateRoot: app.getPath("userData") });
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
      installRendererProtocol(join(__dirname, "../renderer"), localMedia);
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
  const context = rendererContexts.get(webContentsId);
  rendererContexts.delete(webContentsId);
  if (context !== undefined && localMediaAuthority !== null) {
    void localMediaAuthority.revokeGeneration(context.generationId).catch(() => app.exit(1));
  }
}

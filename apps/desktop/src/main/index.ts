import { randomUUID } from "node:crypto";
import { join } from "node:path";

import {
  DESKTOP_IPC_PROTOCOL,
  DESKTOP_IPC_VERSION,
  ProjectEventSchema,
} from "@open-chords/contracts";
import { app, type BrowserWindow, type WebContents } from "electron";

import { installDesktopIpc, publishProjectEvent } from "./desktop-ipc.ts";
import { openProjectLibrary } from "./project-library.ts";
import { installRendererProtocol, registerRendererScheme } from "./renderer-protocol.ts";
import {
  PRIMARY_RENDERER_SECURITY_CONFIGURATION,
  type DesktopSecurityConfiguration,
} from "./renderer-security.ts";
import { createDesktopWindow, hardenWebContents } from "./shell.ts";
import { presentDesktopWindow } from "./window-lifecycle.ts";

registerRendererScheme();

const ownsSingleInstance = app.requestSingleInstanceLock();
let mainWindow: BrowserWindow | null = null;
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
  app.on("web-contents-created", (_event, contents) => hardenWebContents(contents));
  app.on("second-instance", () => {
    const window = getOrCreateWindow();
    presentDesktopWindow(window);
  });

  app.on("activate", () => {
    presentDesktopWindow(getOrCreateWindow());
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  void app
    .whenReady()
    .then(async () => {
      installRendererProtocol(join(__dirname, "../renderer"));
      const projectLibrary = await openProjectLibrary({ stateRoot: app.getPath("userData") });
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
      rendererContexts.delete(webContentsId);
    });
    window.once("closed", () => {
      if (mainWindow === window) mainWindow = null;
    });
  }
  return mainWindow;
}

function replaceCompromisedRenderer(sender: WebContents): void {
  const isMainRenderer = mainWindow?.webContents === sender;
  rendererContexts.delete(sender.id);
  if (!sender.isDestroyed()) sender.close({ waitForBeforeUnload: false });
  if (isMainRenderer) {
    mainWindow = null;
    queueMicrotask(() => getOrCreateWindow());
  }
}

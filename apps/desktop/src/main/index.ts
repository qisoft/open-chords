import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { app, type BrowserWindow, type WebContents } from "electron";

import { installDesktopIpc } from "./desktop-ipc.ts";
import { installRendererProtocol, registerRendererScheme } from "./renderer-protocol.ts";
import {
  createDesktopWindow,
  hardenWebContents,
  PRIMARY_RENDERER_SECURITY_CONFIGURATION,
} from "./shell.ts";
import { unavailableProjectAuthority } from "./unavailable-project-authority.ts";
import { presentDesktopWindow } from "./window-lifecycle.ts";

registerRendererScheme();

const ownsSingleInstance = app.requestSingleInstanceLock();
let mainWindow: BrowserWindow | null = null;
const rendererContexts = new Map<
  number,
  {
    generationId: string;
    security: typeof PRIMARY_RENDERER_SECURITY_CONFIGURATION;
  }
>();

if (!ownsSingleInstance) {
  app.quit();
} else {
  app.on("web-contents-created", (_event, contents) => hardenWebContents(contents));
  app.on("second-instance", () => {
    const window = createOrFocusWindow();
    presentDesktopWindow(window);
  });

  app.on("activate", () => {
    presentDesktopWindow(createOrFocusWindow());
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  void app
    .whenReady()
    .then(() => {
      installRendererProtocol(join(__dirname, "../renderer"));
      installDesktopIpc(unavailableProjectAuthority, {
        onSenderAction: (_action, sender) => replaceCompromisedRenderer(sender),
        rendererContextFor: (sender) => rendererContexts.get(sender.id) ?? null,
      });
      createOrFocusWindow();
      return undefined;
    })
    .catch(() => {
      app.exit(1);
    });
}

function createOrFocusWindow() {
  if (mainWindow === null || mainWindow.isDestroyed()) {
    const generationId = `generation_${randomUUID().replaceAll("-", "")}`;
    const window = createDesktopWindow(generationId);
    mainWindow = window;
    const webContentsId = window.webContents.id;
    rendererContexts.set(webContentsId, {
      generationId,
      security: PRIMARY_RENDERER_SECURITY_CONFIGURATION,
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
    queueMicrotask(() => createOrFocusWindow());
  }
}

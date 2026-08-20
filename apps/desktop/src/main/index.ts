import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { app, type BrowserWindow, type WebContents } from "electron";

import { installDesktopIpc } from "./desktop-ipc.ts";
import { installRendererProtocol, registerRendererScheme } from "./renderer-protocol.ts";
import { createDesktopWindow, hardenWebContents } from "./shell.ts";
import { unavailableProjectAuthority } from "./unavailable-project-authority.ts";

registerRendererScheme();

const ownsSingleInstance = app.requestSingleInstanceLock();
let mainWindow: BrowserWindow | null = null;
const rendererGenerations = new Map<number, string>();

if (!ownsSingleInstance) {
  app.quit();
} else {
  app.on("web-contents-created", (_event, contents) => hardenWebContents(contents));
  app.on("second-instance", () => {
    const window = createOrFocusWindow();
    if (window.isMinimized()) window.restore();
    window.focus();
  });

  app.on("activate", () => {
    createOrFocusWindow();
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  void app
    .whenReady()
    .then(() => {
      installRendererProtocol(join(__dirname, "../renderer"));
      installDesktopIpc(unavailableProjectAuthority, {
        generationFor: (sender) => rendererGenerations.get(sender.id) ?? null,
        onSenderAction: (_action, sender) => replaceCompromisedRenderer(sender),
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
    mainWindow = createDesktopWindow(generationId);
    const webContentsId = mainWindow.webContents.id;
    rendererGenerations.set(webContentsId, generationId);
    mainWindow.webContents.once("destroyed", () => {
      rendererGenerations.delete(webContentsId);
    });
    mainWindow.once("closed", () => {
      mainWindow = null;
    });
  }
  return mainWindow;
}

function replaceCompromisedRenderer(sender: WebContents): void {
  const isMainRenderer = mainWindow?.webContents === sender;
  rendererGenerations.delete(sender.id);
  if (!sender.isDestroyed()) sender.close({ waitForBeforeUnload: false });
  if (isMainRenderer) {
    mainWindow = null;
    queueMicrotask(() => createOrFocusWindow());
  }
}

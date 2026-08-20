import { join } from "node:path";

import { app, BrowserWindow, type Session, type WebContents } from "electron";

export const APP_ENTRY_URL = "open-chords://app/index.html";
export const PRIMARY_RENDERER_PARTITION = "persist:open-chords-primary";

const hardenedSessions = new WeakSet<Session>();
const hardenedContents = new WeakSet<WebContents>();

function isPrimaryRendererUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "open-chords:" && url.host === "app";
  } catch {
    return false;
  }
}

export function hardenRendererSession(session: Session): void {
  if (hardenedSessions.has(session)) return;
  hardenedSessions.add(session);

  session.setPermissionCheckHandler(() => false);
  session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !isPrimaryRendererUrl(details.url) });
  });
}

export function hardenWebContents(contents: WebContents): void {
  if (hardenedContents.has(contents)) return;
  hardenedContents.add(contents);
  hardenRendererSession(contents.session);
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-attach-webview", (event) => event.preventDefault());
  contents.on("will-navigate", (event, url) => {
    if (url !== APP_ENTRY_URL) event.preventDefault();
  });
  contents.on("will-redirect", (event, url) => {
    if (url !== APP_ENTRY_URL) event.preventDefault();
  });
}

export function createDesktopWindow(generationId: string): BrowserWindow {
  const window = new BrowserWindow({
    backgroundColor: "#f7f8fb",
    height: 720,
    show: false,
    width: 1080,
    webPreferences: {
      additionalArguments: [`--open-chords-generation=${generationId}`],
      allowRunningInsecureContent: false,
      autoplayPolicy: "document-user-activation-required",
      contextIsolation: true,
      devTools: !app.isPackaged,
      enableWebSQL: false,
      navigateOnDragDrop: false,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      partition: PRIMARY_RENDERER_PARTITION,
      preload: join(__dirname, "../preload/preload.cjs"),
      safeDialogs: true,
      sandbox: true,
      spellcheck: false,
      webSecurity: true,
      webviewTag: false,
    },
  });

  hardenWebContents(window.webContents);
  window.once("ready-to-show", () => window.show());
  void window.loadURL(APP_ENTRY_URL).catch(() => window.destroy());
  return window;
}

import { join } from "node:path";

import { app, BrowserWindow, type Session, type WebContents } from "electron";

import { APP_ENTRY_URL, parseApplicationUrl } from "./desktop-origin.ts";
import { PRIMARY_RENDERER_SECURITY_CONFIGURATION } from "./renderer-security.ts";

export const PRIMARY_RENDERER_PARTITION = "open-chords-primary";

const hardenedSessions = new WeakSet<Session>();
const hardenedContents = new WeakSet<WebContents>();

function isPrimaryRendererUrl(value: string): boolean {
  try {
    const schemeEnd = value.indexOf("://");
    const pathStart = schemeEnd === -1 ? -1 : value.indexOf("/", schemeEnd + 3);
    const rawPath = pathStart === -1 ? "" : (value.slice(pathStart).split(/[?#]/, 1)[0] ?? "");
    const decodedPath = decodeURIComponent(rawPath);
    if (decodedPath.split("/").some((segment) => segment === "." || segment === "..")) {
      return false;
    }
    return parseApplicationUrl(value) !== null;
  } catch {
    return false;
  }
}

export function denyPermissionRequest(callback: (allowed: boolean) => void): void {
  callback(false);
}

export function denyWindowOpen() {
  return { action: "deny" } as const;
}

export function preventWebviewAttachment(event: { preventDefault(): void }): void {
  event.preventDefault();
}

export function guardPrimaryRendererNavigation(
  event: { preventDefault(): void },
  url: string,
): void {
  if (url !== APP_ENTRY_URL) event.preventDefault();
}

export function rendererRequestPolicy(url: string): { cancel: boolean } {
  return { cancel: !isPrimaryRendererUrl(url) };
}

export function hardenRendererSession(session: Session): void {
  if (hardenedSessions.has(session)) return;
  hardenedSessions.add(session);

  session.setPermissionCheckHandler(() => false);
  session.setPermissionRequestHandler((_webContents, _permission, callback) =>
    denyPermissionRequest(callback),
  );
  session.webRequest.onBeforeRequest((details, callback) => {
    callback(rendererRequestPolicy(details.url));
  });
}

export function hardenWebContents(contents: WebContents): void {
  if (hardenedContents.has(contents)) return;
  hardenedContents.add(contents);
  hardenRendererSession(contents.session);
  contents.setWindowOpenHandler(denyWindowOpen);
  contents.on("will-attach-webview", preventWebviewAttachment);
  contents.on("will-navigate", guardPrimaryRendererNavigation);
  contents.on("will-redirect", guardPrimaryRendererNavigation);
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
      ...PRIMARY_RENDERER_SECURITY_CONFIGURATION,
      devTools: !app.isPackaged,
      enableWebSQL: false,
      navigateOnDragDrop: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      partition: PRIMARY_RENDERER_PARTITION,
      preload: join(__dirname, "../preload/preload.cjs"),
      safeDialogs: true,
      spellcheck: false,
      webviewTag: false,
    },
  });

  hardenWebContents(window.webContents);
  window.once("ready-to-show", () => window.show());
  void window.loadURL(APP_ENTRY_URL).catch(() => window.destroy());
  return window;
}

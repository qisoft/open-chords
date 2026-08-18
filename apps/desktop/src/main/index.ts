import { join } from "node:path";

import { app, BrowserWindow } from "electron";

function createFoundationWindow(): BrowserWindow {
  const window = new BrowserWindow({
    height: 720,
    show: false,
    width: 1080,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(__dirname, "../preload/preload.cjs"),
      sandbox: true,
    },
  });

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  void window.loadFile(join(__dirname, "../renderer/index.html"));

  return window;
}

void app.whenReady().then(() => {
  const window = createFoundationWindow();
  window.once("ready-to-show", () => window.show());
  return undefined;
});

app.on("window-all-closed", () => app.quit());

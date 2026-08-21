import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { extractFile } from "@electron/asar";
import { FuseState, FuseV1Options, getCurrentFuseWire } from "@electron/fuses";
import { expect, test } from "@playwright/test";
import extractZip from "extract-zip";
import { z } from "zod";

const PRODUCT_NAME = "Open Chords";
const EXPECTED_RENDERER_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'none'",
  "font-src 'self'",
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
const packageRoot = mkdtempSync(join(tmpdir(), "open-chords-installed-"));
const executablePath =
  process.platform === "darwin"
    ? join(packageRoot, `${PRODUCT_NAME}.app`, "Contents", "MacOS", PRODUCT_NAME)
    : join(packageRoot, `${PRODUCT_NAME}${process.platform === "win32" ? ".exe" : ""}`);
const resourcesPath =
  process.platform === "darwin"
    ? join(packageRoot, `${PRODUCT_NAME}.app`, "Contents", "Resources")
    : join(packageRoot, "resources");

test.beforeAll(async () => {
  await extractZip(archivePath, { dir: packageRoot });
});

test.afterAll(() => {
  rmSync(packageRoot, { force: true, maxRetries: 10, recursive: true, retryDelay: 100 });
});

test("packaged shell flips every security fuse explicitly", async () => {
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

test("installed shell exposes only named capabilities and manifest assets", async () => {
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

  const debuggingPort = await reservePort();
  const application = spawn(executablePath, [`--remote-debugging-port=${String(debuggingPort)}`], {
    stdio: ["ignore", "pipe", "pipe"],
  });
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
      renderer = await Promise.race([inspectPackagedRenderer(debuggingPort), startupFailure]);
    } catch (error) {
      throw new Error(`Packaged renderer inspection failed\n${applicationOutput}`, {
        cause: error,
      });
    }
    expect(renderer).toMatchObject({
      apiKeys: ["project", "shell"],
      contentSecurityPolicy: EXPECTED_RENDERER_CSP,
      externalFetch: "rejected",
      heading: "Open Chords foundation",
      missingProject: { code: "project_not_found", type: "desktop.error" },
      nodeGlobals: {
        Buffer: "undefined",
        ipcRenderer: "undefined",
        process: "undefined",
        require: "undefined",
      },
      navigationDenied: true,
      permissionDenied: true,
      popupDenied: true,
      projectKeys: ["commitEditTransaction", "getSnapshot", "subscribe"],
      security: {
        security: {
          contextIsolation: true,
          nodeIntegration: false,
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
      const child = spawn(executablePath, [], { stdio: "ignore" });
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
    await stopApplication(application);
  }
});

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
    if (!application.kill()) {
      clearTimeout(timeout);
      resolve();
    }
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

const RendererSnapshotSchema = z.object({
  apiKeys: z.array(z.string()),
  contentSecurityPolicy: z.literal(EXPECTED_RENDERER_CSP),
  externalFetch: z.literal("rejected"),
  heading: z.string().nullable(),
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
  permissionDenied: z.literal(true),
  popupDenied: z.literal(true),
  projectKeys: z.array(z.string()),
  resourceUrls: z.array(z.string()),
  security: z.object({
    security: z.object({
      contextIsolation: z.literal(true),
      nodeIntegration: z.literal(false),
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

async function inspectPackagedRenderer(
  port: number,
): Promise<z.infer<typeof RendererSnapshotSchema>> {
  const endpoint = `http://127.0.0.1:${String(port)}`;
  const deadline = Date.now() + 30_000;
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
    if (target !== undefined) return await evaluateRendererTarget(target.webSocketDebuggerUrl);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Could not inspect packaged renderer", { cause: lastError });
}

async function evaluateRendererTarget(webSocketUrl: string) {
  const expression = `new Promise((resolve) => {
    const inspect = async () => {
      await new Promise((probeComplete) => {
        const image = new Image();
        image.addEventListener("load", probeComplete, { once: true });
        image.addEventListener("error", probeComplete, { once: true });
        image.src = "open-chords://app/index.html?csp-probe";
        document.body.append(image);
      });
      await new Promise((probeComplete) => {
        const image = new Image();
        image.addEventListener("load", probeComplete, { once: true });
        image.addEventListener("error", probeComplete, { once: true });
        image.src = "open-chords://app/asset-manifest.json";
        document.body.append(image);
      });
      const webSecurityEnforced = await new Promise((probeComplete) => {
        const frame = document.createElement("iframe");
        frame.addEventListener("load", () => {
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
      const permissionDenied = await Notification.requestPermission().then(
        (permission) => permission === "denied",
        () => true,
      );
      const popupDenied = window.open("https://example.com/", "_blank") === null;
      const originalUrl = window.location.href;
      const navigation = document.createElement("a");
      navigation.href = "https://example.com/";
      document.body.append(navigation);
      navigation.click();
      await new Promise((navigationSettled) => setTimeout(navigationSettled, 100));
      navigation.remove();
      resolve({
      apiKeys: Object.keys(window.openChords).sort(),
      externalFetch: await fetch("https://www.youtube.com/iframe_api").then(
        () => "resolved",
        () => "rejected",
      ),
      heading: document.querySelector("h1")?.textContent ?? null,
      missingProject: await window.openChords.project.getSnapshot("project_missing"),
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
      resourceUrls: Array.from(document.querySelectorAll("script[src], link[rel=stylesheet][href]"))
        .map((element) => element instanceof HTMLScriptElement ? element.src : element.href)
        .filter((url) => url.startsWith("open-chords://")),
      security: await window.openChords.shell.getSecuritySnapshot(),
      shellKeys: Object.keys(window.openChords.shell).sort(),
      url: window.location.href,
      webSecurityEnforced,
      });
    };
    if (document.readyState === "complete") void inspect();
    else window.addEventListener("load", () => void inspect(), { once: true });
  })`;

  return new Promise<z.infer<typeof RendererSnapshotSchema>>((resolve, reject) => {
    const socket = new WebSocket(webSocketUrl);
    let contentSecurityPolicy: string | undefined;
    let undeclaredAssetStatus: number | undefined;
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("Renderer CDP evaluation timed out"));
    }, 5_000);
    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error("Renderer CDP connection failed"));
    });
    socket.addEventListener("close", () => {
      clearTimeout(timeout);
      reject(new Error("Renderer CDP connection closed before evaluation completed"));
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
              method: "Page.setBypassCSP",
              params: { enabled: true },
            }),
          );
          return;
        }
        const bypassResponse = z
          .object({ id: z.literal(2), error: z.unknown().optional() })
          .safeParse(rawResponse);
        if (bypassResponse.success) {
          if (bypassResponse.data.error !== undefined) {
            throw new Error("Could not isolate webSecurity from packaged CSP");
          }
          socket.send(
            JSON.stringify({
              id: 3,
              method: "Runtime.evaluate",
              params: { awaitPromise: true, expression, returnByValue: true },
            }),
          );
          return;
        }
        if (!z.object({ id: z.literal(3) }).safeParse(rawResponse).success) return;
        const response = z
          .object({
            id: z.literal(3),
            result: z.object({
              exceptionDetails: z.unknown().optional(),
              result: z.object({ value: z.unknown().optional() }),
            }),
          })
          .safeParse(rawResponse);
        if (!response.success) throw new Error("Renderer returned an invalid CDP response");
        if (response.data.result.exceptionDetails !== undefined) {
          throw new Error("Renderer CDP evaluation threw");
        }
        const snapshotValue = z
          .record(z.string(), z.unknown())
          .parse(response.data.result.result.value);
        const snapshot = RendererSnapshotSchema.parse({
          ...snapshotValue,
          contentSecurityPolicy,
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

async function decodeWebSocketMessage(data: unknown): Promise<string | null> {
  if (typeof data === "string") return data;
  if (data instanceof Blob) return data.text();
  if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(data);
  }
  return null;
}

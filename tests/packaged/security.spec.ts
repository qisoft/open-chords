import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { extractFile } from "@electron/asar";
import { FuseState, FuseV1Options, getCurrentFuseWire } from "@electron/fuses";
import { monoPcmWav } from "@open-chords/testkit/media";
import { expect, test } from "@playwright/test";
import extractZip from "extract-zip";
import { z } from "zod";

import { LocalMediaService } from "../../apps/desktop/src/main/local-media.ts";
import { PACKAGED_SIDECAR_PROOF_ARGUMENT } from "../../apps/desktop/src/main/packaged-sidecar-proof-constants.ts";
import { openProjectLibrary } from "../../apps/desktop/src/main/project-library.ts";

const PRODUCT_NAME = "Open Chords";
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

test("installed artifact runs the main-owned sidecar lifecycle and reaps", async () => {
  test.setTimeout(300_000);
  const proof = spawn(executablePath, [PACKAGED_SIDECAR_PROOF_ARGUMENT], {
    cwd: packageRoot,
    env: {},
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let output = "";
  const capture = (chunk: Buffer) => {
    output = `${output}${chunk.toString("utf8")}`.slice(-64 * 1024);
  };
  proof.stdout.on("data", capture);
  proof.stderr.on("data", capture);

  const exit = await waitForApplicationExit(proof, 290_000);
  process.stdout.write(output);
  expect(exit, output).toEqual({ code: 0, signal: null });
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
  const application = spawn(
    executablePath,
    [`--remote-debugging-port=${String(debuggingPort)}`, `--user-data-dir=${userDataDirectory}`],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
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
    expect(renderer).toMatchObject({
      apiKeys: ["media", "project", "shell"],
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
      projectKeys: ["commitEditTransaction", "getSnapshot", "list", "subscribe"],
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
      const child = spawn(executablePath, [`--user-data-dir=${userDataDirectory}`], {
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
    const timeout = setTimeout(() => {
      void stopApplication(application).finally(() => {
        reject(new Error("Packaged lifecycle proof did not exit"));
      });
    }, timeoutMs);
    application.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    application.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
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
    if (target !== undefined) {
      const offlinePlayback = await evaluatePackagedMedia(target.webSocketDebuggerUrl, projectId);
      const security = await evaluateRendererTarget(target.webSocketDebuggerUrl);
      return RendererSnapshotSchema.parse({ ...security, offlinePlayback });
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Could not inspect packaged renderer", { cause: lastError });
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
          effectiveCsp = EffectiveCspProbeSchema.parse(response.result.result.value);
          socket.send(
            JSON.stringify({
              id: 3,
              method: "Page.setBypassCSP",
              params: { enabled: true },
            }),
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
    let timelineMoved = false;
    try {
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
      playButton.click();
      await waitFor(
        () => document.querySelector('button[aria-label="Pause"]'),
        "workspace playback did not start",
      );
      workspacePlayed = true;
      await waitFor(
        () => track.style.transform !== transformBeforePlay,
        "workspace timeline did not move",
      );
      timelineMoved = true;
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

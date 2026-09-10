import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { extractFile, listPackage } from "@electron/asar";
import { FuseState, FuseV1Options, getCurrentFuseWire } from "@electron/fuses";
import { ProjectEnvelopeSchema } from "@open-chords/contracts";
import { monoPcmWav } from "@open-chords/testkit/media";
import { expect, test } from "@playwright/test";
import extractZip from "extract-zip";
import { z } from "zod";

import { LocalMediaService } from "../../apps/desktop/src/main/local-media.ts";
import { PACKAGED_SIDECAR_PROOF_ARGUMENT } from "../../apps/desktop/src/main/packaged-sidecar-proof-constants.ts";
import { openProjectLibrary } from "../../apps/desktop/src/main/project-library.ts";
import { goldenRecords } from "../support/editor-fixture.ts";

test.skip(
  process.platform !== "darwin" && process.platform !== "win32",
  "Installed native profiles support macOS and Windows only",
);

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
  const files = listPackage(join(resourcesPath, "app.asar"), { isPack: false }).map((file) =>
    file.replaceAll("\\", "/"),
  );
  expect(new Set(files.map((file) => file.split("/")[1]))).toEqual(
    new Set(["LICENSE", "dist", "node_modules", "package.json"]),
  );
  expect(
    new Set(files.filter((file) => file.startsWith("/dist/")).map((file) => file.split("/")[2])),
  ).toEqual(new Set(["main", "preload", "renderer"]));
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

test("installed artifact runs contained analysis, publishes Revisions, and reaps", async () => {
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

  const exit = await waitForApplicationExit(proof, 290_000).finally(() => {
    process.stdout.write(output);
  });
  expect(exit, output).toEqual({ code: 0, signal: null });
  expect(output).toContain("Packaged sidecar proof stage: publication_completed");
});

test("installed editor and practice save through named IPC with a durable reopened result", async () => {
  test.setTimeout(60_000);
  const stateRoot = join(packageRoot, "editor-user-data");
  const envelope = ProjectEnvelopeSchema.parse(
    JSON.parse(
      readFileSync(
        join(process.cwd(), "packages/testkit/contracts/v1/valid/project-envelope.json"),
        "utf8",
      ),
    ),
  );
  const library = await openProjectLibrary({ stateRoot });
  await library.createProject({ envelope, records: goldenRecords() });
  const port = await reservePort();
  const application = spawn(
    executablePath,
    [`--remote-debugging-port=${port}`, `--user-data-dir=${stateRoot}`],
    { stdio: "ignore" },
  );
  try {
    const endpoint = `http://127.0.0.1:${port}`;
    let target: z.infer<typeof CdpTargetsSchema>[number] | undefined;
    await expect
      .poll(
        async () => {
          try {
            const response = await fetch(`${endpoint}/json/list`);
            target = CdpTargetsSchema.parse(await response.json()).find(
              (candidate) =>
                candidate.type === "page" && candidate.url.startsWith("open-chords://"),
            );
            return target !== undefined;
          } catch {
            return false;
          }
        },
        // Startup verifies the bundled runtime before exposing desktop capabilities.
        { timeout: 30_000 },
      )
      .toBe(true);
    if (target === undefined) throw new Error("Packaged editor target is unavailable");
    expect(await evaluatePackagedEditor(target.webSocketDebuggerUrl)).toEqual({
      saved: true,
      undone: true,
      practiceSaved: true,
      lyricsSaved: true,
    });
    process.stdout.write("Packaged editor stage: save_and_undo_verified\n");
  } finally {
    process.stdout.write("Packaged editor stage: stopping\n");
    // Reopen after abrupt termination to verify that Save/Undo already reached durable storage.
    if (process.platform !== "win32") application.kill("SIGKILL");
    await stopApplication(application);
    process.stdout.write("Packaged editor stage: stopped\n");
  }
  const reopened = await openProjectLibrary({ stateRoot });
  const saved = (await reopened.getSnapshot("project_golden"))!.project;
  expect(
    saved.lyricsDocuments.find((document) => document.id === saved.activeView!.lyricsDocumentId)!
      .text,
  ).toBe("Installed local words");
  expect(saved.activeView!.editHistoryPosition).toBe(0);
  expect(saved.editLayers[0]!.transactions).toHaveLength(2);
  expect(saved.analysisRevisions).toEqual(envelope.payload.analysisRevisions);
  expect(saved.practice).toMatchObject({
    speed: 0.75,
    instrument: "piano",
    loop: { firstBarId: "bar_pickup", lastBarId: "bar_pickup", status: "ready" },
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
      apiKeys: ["alignment", "exports", "lyrics", "media", "models", "project", "shell", "youtube"],
      modelsKeys: ["perform"],
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
      projectKeys: [
        "addLyrics",
        "changeEditHistory",
        "changePractice",
        "commitEditTransaction",
        "getSnapshot",
        "list",
        "subscribe",
      ],
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
    const onError = (error: Error) => {
      clearTimeout(timeout);
      application.off("exit", onExit);
      reject(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timeout);
      application.off("error", onError);
      resolve({ code, signal });
    };
    const timeout = setTimeout(() => {
      application.off("error", onError);
      application.off("exit", onExit);
      reject(new Error("Packaged lifecycle proof did not exit"));
      void stopApplication(application).catch(() => undefined);
    }, timeoutMs);
    application.once("error", onError);
    application.once("exit", onExit);
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
  modelsKeys: z.array(z.string()),
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

async function evaluatePackagedEditor(webSocketUrl: string): Promise<unknown> {
  // Use the same page-level CDP boundary as the installed security/playback probes.
  // Browser-level target discovery stalled this installed Electron probe in native CI.
  const expression = `(async () => {
    const deadline = Date.now() + 10000;
    const waitFor = async (read, stage) => {
      while (Date.now() < deadline) {
        const value = read();
        if (value) return value;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      throw new Error("Packaged editor stage timed out: " + stage);
    };
    const button = (label, parent = document) => [...parent.querySelectorAll("button")].find(element => element.textContent.trim() === label && !element.disabled);
    await waitFor(() => window.openChords && button("Edit chords"), "ready");
    const pickup = await waitFor(() => document.querySelector('[data-region-id="bar_pickup"]'), "timeline");
    const originalLabel = pickup.getAttribute("aria-label");
    button("Edit chords").click();
    const editor = await waitFor(() => document.querySelector('[aria-label="Chord Editor"]'), "opened");
    button("Choose chord", editor).click();
    const picker = await waitFor(() => editor.querySelector('[aria-label="Chord picker"]'), "picker");
    const root = picker.querySelector("select");
    root.value = "N";
    root.dispatchEvent(new Event("change", { bubbles: true }));
    await waitFor(() => picker.querySelectorAll("select").length === 1, "no_chord");
    button("Done", picker).click();
    (await waitFor(() => button("Save", editor), "valid_draft")).click();
    await waitFor(() => !document.querySelector('[aria-label="Chord Editor"]') && pickup.getAttribute("aria-label").includes("Chords: N"), "saved");
    const saved = await window.openChords.project.getSnapshot("project_golden");
    button("Undo edit").click();
    await waitFor(() => pickup.getAttribute("aria-label") === originalLabel, "undo");
    const undone = await window.openChords.project.getSnapshot("project_golden");
    (await waitFor(() => button("Set loop from selection"), "practice_loop_ready")).click();
    await waitFor(() => document.querySelector('.loop-status').textContent.includes("Pickup"), "practice_loop_saved");
    const choose = async (label, value) => {
      const select = await waitFor(() => { const element = document.querySelector('select[aria-label="' + label + '"]'); return element && !element.disabled && !element.closest('fieldset:disabled') ? element : null; }, "practice_setting_ready");
      select.value = value;
      select.dispatchEvent(new Event("change", {bubbles: true}));
      await new Promise(resolve => setTimeout(resolve, 0));
      await waitFor(() => select.value === value && document.querySelector('[aria-label="Practice settings status"]').textContent === "Practice saved" && !select.disabled && !select.closest('fieldset:disabled'), "practice_setting_saved");
    };
    await choose("Playback speed", "0.75");
    await choose("Instrument", "piano");
    const practiced = await window.openChords.project.getSnapshot("project_golden");
    button("Choose lyrics").click();
    const lyrics = await waitFor(() => document.querySelector('.lyrics-selection textarea'), "lyrics_open");
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(lyrics, "Installed local words");
    lyrics.dispatchEvent(new Event("input", { bubbles: true }));
    (await waitFor(() => button("Save new Lyrics Document"), "lyrics_valid")).click();
    await waitFor(() => document.querySelector('[aria-label="Lyrics selection status"]').textContent === "Lyrics saved", "lyrics_saved");
    const withLyrics = await window.openChords.project.getSnapshot("project_golden");
    return { lyricsSaved: withLyrics.type === "project.snapshot" && withLyrics.project.lyricsDocuments.some(document => document.id === withLyrics.project.activeView.lyricsDocumentId && document.text === "Installed local words"), saved: saved.type === "project.snapshot" && saved.project.activeView.editHistoryPosition === 2, undone: undone.type === "project.snapshot" && undone.project.activeView.editHistoryPosition === 0, practiceSaved: practiced.type === "project.snapshot" && practiced.project.practice.speed === 0.75 && practiced.project.practice.instrument === "piano" && practiced.project.practice.loop.firstBarId === "bar_pickup" };
  })()`;
  return evaluatePackagedExpression(webSocketUrl, expression);
}

async function evaluatePackagedExpression(
  webSocketUrl: string,
  expression: string,
  timeoutMs = 15_000,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketUrl);
    let requestId = 0;
    let settled = false;
    const finish = (error: Error | null, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.close();
      if (error !== null) reject(error);
      else resolve(value);
    };
    const timeout = setTimeout(
      () => finish(new Error("Packaged editor CDP evaluation timed out")),
      timeoutMs,
    );
    const evaluate = () => {
      if (settled) return;
      requestId += 1;
      socket.send(
        JSON.stringify({
          id: requestId,
          method: "Runtime.evaluate",
          params: { awaitPromise: true, expression, returnByValue: true, userGesture: true },
        }),
      );
    };
    socket.addEventListener("open", evaluate);
    socket.addEventListener("error", () =>
      finish(new Error("Packaged editor CDP connection failed")),
    );
    socket.addEventListener("close", () =>
      finish(new Error("Packaged editor CDP connection closed before completion")),
    );
    socket.addEventListener("message", (message) => {
      void handle(message.data);
    });
    async function handle(data: unknown) {
      try {
        const text = await decodeWebSocketMessage(data);
        if (text === null) return;
        const raw: unknown = JSON.parse(text);
        if (!z.object({ id: z.literal(requestId) }).safeParse(raw).success) return;
        const protocolError = z
          .object({ error: z.object({ code: z.number(), message: z.string() }) })
          .safeParse(raw);
        if (protocolError.success) {
          if (
            protocolError.data.error.code === -32000 &&
            protocolError.data.error.message === "Cannot find default execution context"
          ) {
            setTimeout(evaluate, 50);
            return;
          }
          finish(new Error("Packaged editor CDP protocol failed"));
          return;
        }
        const response = CdpEvaluationResponseSchema.parse(raw);
        if (response.result.exceptionDetails !== undefined) {
          finish(new Error("Packaged editor journey failed"));
          return;
        }
        finish(null, response.result.result.value);
      } catch {
        finish(new Error("Packaged editor response was invalid"));
      }
    }
  });
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
      modelsKeys: Object.keys(window.openChords.models).sort(),
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
      // Preserve transient playback evidence even if the short fixture ends between timer ticks.
      await new Promise((resolve, reject) => {
        const fail = (message) => {
          observer.disconnect();
          reject(new Error(message));
        };
        let timeout;
        const observer = new MutationObserver(() => {
          const previouslyPlaying = workspacePlayed;
          workspacePlayed ||= playButton.getAttribute("aria-label") === "Pause";
          timelineMoved ||= track.style.transform !== transformBeforePlay;
          if (workspacePlayed && timelineMoved) {
            clearTimeout(timeout);
            observer.disconnect();
            resolve();
          } else if (!previouslyPlaying && workspacePlayed) {
            clearTimeout(timeout);
            timeout = setTimeout(() => fail("workspace timeline did not move"), 3000);
          }
        });
        timeout = setTimeout(() => fail("workspace playback did not start"), 3000);
        observer.observe(playButton, { attributes: true, attributeFilter: ["aria-label"] });
        observer.observe(track, { attributes: true, attributeFilter: ["style"] });
        playButton.click();
      });
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

test("installed MFA runtime verifies its manifest and starts without system Python or Conda", async () => {
  test.setTimeout(240_000);
  const { inspectAlignmentRuntime, packagedAlignmentRuntimeRoot } =
    await import("../../apps/desktop/src/main/alignment-runtime.ts");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const root = packagedAlignmentRuntimeRoot(resourcesPath);
  const info = await inspectAlignmentRuntime(root);
  expect(info.available).toBe(true);
  expect(info.installedBytes).toBeGreaterThan(0);
  const home = mkdtempSync(join(tmpdir(), "open-chords-mfa-installed-"));
  try {
    const env: Record<string, string> = {
      HOME: home,
      USERPROFILE: home,
      MFA_ROOT_DIR: home,
      APPDATA: home,
      LOCALAPPDATA: home,
      TEMP: home,
      TMP: home,
    };
    if (process.platform === "win32") {
      env.SystemRoot = process.env.SystemRoot!;
      env.PATH = join(env.SystemRoot, "System32");
    } else env.PATH = "/usr/bin:/bin";
    const executable = join(
      root,
      `open-chords-alignment${process.platform === "win32" ? ".exe" : ""}`,
    );
    const { stdout } = await promisify(execFile)(
      process.platform === "darwin" ? "/usr/bin/sandbox-exec" : executable,
      process.platform === "darwin"
        ? [
            "-p",
            '(version 1) (allow default) (deny file-read* (subpath "/opt/homebrew") (subpath "/usr/local"))',
            executable,
            "--probe",
          ]
        : ["--probe"],
      { env, timeout: 180_000, maxBuffer: 8192 },
    );
    expect(JSON.parse(stdout)).toEqual({
      runtime: "mfa",
      version: "3.4.1",
      kalpy: "KalpyAligner",
      fst: 0,
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("installed native Alignment worker runs exact EN/RU packs offline and publishes only verified occurrences", async () => {
  test.setTimeout(600_000);
  const { createHash, randomUUID } = await import("node:crypto");
  const { readdir, writeFile, stat, rename, rm } = await import("node:fs/promises");
  const { addLyricsDocument } = await import("@open-chords/domain");
  const { openAlignmentJobs } = await import("../../apps/desktop/src/main/alignment-jobs.ts");
  const { createContainedAlignmentWorker } =
    await import("../../apps/desktop/src/main/alignment-worker.ts");
  const { ALIGNMENT_PACKS } = await import("../../apps/desktop/src/main/alignment-packs.ts");
  const { openModelStore } = await import("../../apps/desktop/src/main/model-store.ts");
  const library = await openProjectLibrary({ stateRoot: userDataDirectory });
  const media = new LocalMediaService({ library, pickFile: async () => null });
  const source = await library.readProject(packagedProjectId);
  const modelStore = await openModelStore({
    stateRoot: userDataDirectory,
    packs: ALIGNMENT_PACKS,
    runtime: "mfa-3.4.1",
  });
  const runtimeRoot =
    process.platform === "darwin"
      ? join(
          resourcesPath,
          "..",
          "XPCServices",
          "OpenChordsAnalysisService.xpc",
          "Contents",
          "Resources",
          "open-chords-alignment",
        )
      : join(resourcesPath, "open-chords-alignment");
  const containmentRoot =
    process.platform === "darwin"
      ? join(resourcesPath, "..", "MacOS", "containment")
      : join(resourcesPath, "containment");
  const digestFile = (path: string) =>
    createHash("sha256").update(readFileSync(path)).digest("hex");
  const worker = createContainedAlignmentWorker({
    stateRoot: userDataDirectory,
    runtimeRoot,
    runtimeManifestHash: digestFile(join(runtimeRoot, "runtime-info.json")),
    containmentRoot,
    containmentManifestHash: digestFile(join(containmentRoot, "containment-manifest.json")),
    ...(process.platform === "darwin"
      ? { bridgePath: join(resourcesPath, "..", "MacOS", "open-chords-containment-bridge") }
      : {}),
    media,
    modelStore,
  });
  const jobs = await openAlignmentJobs({
    stateRoot: userDataDirectory,
    modelStore,
    packs: ALIGNMENT_PACKS,
    runtimeManifestHash: digestFile(join(runtimeRoot, "runtime-info.json")),
  });
  for (const [language, text] of [
    ["en", "hello world\n(ＣＡＮ’T hello)\n[chorus]"],
    ["ru", "привет мир"],
  ] as const) {
    const pack = ALIGNMENT_PACKS.find((item) => item.language === language)!;
    await modelStore.install(pack.id);
    const envelope = ProjectEnvelopeSchema.parse(
      JSON.parse(
        readFileSync(
          join(process.cwd(), "packages/testkit/contracts/v1/valid/project-envelope.json"),
          "utf8",
        ),
      ),
    );
    envelope.payload.id = `project_native_alignment_${language}`;
    for (const revision of envelope.payload.analysisRevisions)
      revision.projectId = envelope.payload.id;
    envelope.payload = addLyricsDocument(
      envelope.payload,
      { text, language, format: "text" },
      `lyrics_native_${language}`,
    );
    const document = envelope.payload.lyricsDocuments.at(-1)!;
    const active = envelope.payload.activeView!;
    const layer = envelope.payload.editLayers.find((item) => item.id === active.editLayerId)!;
    layer.transactions.push({
      id: `anchor_transaction_${language}`,
      parentTransactionId: null,
      operations: [
        {
          type: "set_lyrics_anchor",
          anchor: {
            id: `anchor_native_${language}`,
            lyricsDocumentId: document.id,
            analysisRevisionId: active.analysisRevisionId,
            firstTokenId: document.tokens[0]!.id,
            lastTokenId: document.tokens[0]!.id,
            startSample: 12000,
            endSample: 24000,
          },
        },
      ],
    });
    active.editHistoryPosition = layer.transactions.length;
    await library.createProject({
      envelope,
      records: {
        ...source.records,
        legacyManifestlessAnalysisRevisionIds: envelope.payload.analysisRevisions.map(
          (item) => item.id,
        ),
      },
    });
    const job = await jobs.request({
      project: envelope.payload,
      lyricsDocumentId: `lyrics_native_${language}`,
      analysisRevisionId: envelope.payload.activeView!.analysisRevisionId,
      ...(await media.getAnalysisSource(envelope.payload.id)),
    });
    expect(await jobs.run(job.id, { library, worker })).toMatchObject({ state: "succeeded" });
    const result = (await library.getSnapshot(envelope.payload.id))!.project.lyricsAlignments.at(
      -1,
    )!;
    expect(result.provenance).toMatchObject({
      recipeHash: job.key,
      qualityStatus: "benchmark_pending",
    });
    expect(result.occurrences).toHaveLength(document.tokens.length);
    if (language === "en") {
      for (const occurrence of result.occurrences.slice(2, 4)) {
        expect(occurrence.timing).not.toMatchObject({ reasonCode: "annotation" });
        expect(occurrence.timing).not.toMatchObject({ reasonCode: "oov" });
      }
      expect(result.occurrences.at(-1)!.timing).toMatchObject({
        state: "unmatched",
        reasonCode: "annotation",
      });
    }
    if (language === "en")
      expect(result.occurrences.some((item) => item.timing.state === "matched")).toBe(true);
    expect(
      result.occurrences.every(
        (item) =>
          item.timing.state === "unmatched" || item.timing.assertion.state === "low_confidence",
      ),
    ).toBe(true);
    process.stdout.write(`Packaged Alignment stage: ${language}_published\n`);
    expect(await readdir(join(userDataDirectory, "alignment-workspaces"))).toEqual([]);
    if (language === "en") {
      const before = (await library.getSnapshot(envelope.payload.id))!;
      const lastTransaction = before.project.editLayers
        .find((item) => item.id === before.project.activeView!.editLayerId)!
        .transactions.at(-1)!;
      await library.commitEditTransaction({
        projectId: before.project.id,
        expectedProjectRevisionId: before.projectRevisionId,
        transaction: {
          id: "transaction_cancel_anchor",
          parentTransactionId: lastTransaction.id,
          operations: [
            {
              type: "set_lyrics_anchor",
              anchor: {
                id: "anchor_cancel_tail",
                lyricsDocumentId: document.id,
                analysisRevisionId: active.analysisRevisionId,
                firstTokenId: document.tokens[1]!.id,
                lastTokenId: document.tokens[1]!.id,
                startSample: 24000,
                endSample: 48000,
              },
            },
          ],
        },
      });
      const candidate = (await library.getSnapshot(before.project.id))!;
      const cancelJob = await jobs.request({
        project: candidate.project,
        lyricsDocumentId: document.id,
        analysisRevisionId: active.analysisRevisionId,
        ...(await media.getAnalysisSource(before.project.id)),
      });
      const jobsRoot = join(userDataDirectory, "alignment-jobs");
      const savedJobsRoot = `${jobsRoot}-stage-fault`;
      await expect(
        jobs.run(cancelJob.id, {
          library,
          worker: (input) =>
            worker({
              ...input,
              reportStage: async (stage) => {
                if (stage !== "aligning") return input.reportStage(stage);
                await rename(jobsRoot, savedJobsRoot);
                await writeFile(jobsRoot, "unavailable storage");
                try {
                  await input.reportStage(stage);
                } finally {
                  await rm(jobsRoot);
                  await rename(savedJobsRoot, jobsRoot);
                }
              },
            }),
        }),
      ).rejects.toBeInstanceOf(Error);
      expect(await jobs.get(cancelJob.id)).toMatchObject({
        state: "retryable",
        failure: "storage",
        circuitOpen: false,
      });
      expect(await readdir(join(userDataDirectory, "alignment-workspaces"))).toEqual([]);
      await jobs.confirm(cancelJob.id);
      const execution = jobs
        .run(cancelJob.id, {
          library,
          worker: (input) =>
            worker({
              ...input,
              reportStage: async (stage) => {
                await input.reportStage(stage);
                if (stage === "aligning") {
                  expect((await jobs.get(cancelJob.id))?.stage).toBe("aligning");
                  await jobs.cancel(cancelJob.id);
                }
              },
            }),
        })
        .then(
          (value) => value,
          (error: unknown) => error,
        );
      expect(await execution).toBeInstanceOf(Error);
      expect((await jobs.get(cancelJob.id))?.state).toBe("cancelled");
      expect((await library.getSnapshot(before.project.id))!.project.lyricsAlignments).toEqual(
        before.project.lyricsAlignments,
      );
      expect(await readdir(join(userDataDirectory, "alignment-workspaces"))).toEqual([]);
      process.stdout.write("Packaged Alignment stage: cancelled_and_cleaned\n");
      const { preparePackagedWorkspace } =
        await import("../../apps/desktop/src/main/packaged-sidecar-proof-workspace.ts");
      const { verifyContainmentRuntime } =
        await import("../../apps/desktop/src/main/sidecar-containment-integrity.ts");
      const { recoverAlignmentWorkspaces } =
        await import("../../apps/desktop/src/main/alignment-worker.ts");
      const recoveryOptions = {
        stateRoot: userDataDirectory,
        containmentRoot,
        containmentManifestHash: digestFile(join(containmentRoot, "containment-manifest.json")),
        ...(process.platform === "darwin"
          ? { bridgePath: join(resourcesPath, "../MacOS/open-chords-containment-bridge") }
          : {}),
      };
      const platform = process.platform === "darwin" ? "darwin" : "win32";
      const containment = verifyContainmentRuntime(
        containmentRoot,
        recoveryOptions.containmentManifestHash,
        platform,
        recoveryOptions.bridgePath,
      );
      const identity = randomUUID();
      await writeFile(join(userDataDirectory, "alignment-workspaces", identity), "", {
        flag: "wx",
      });
      const interrupted = preparePackagedWorkspace(
        platform,
        containment.helperPath,
        runtimeRoot,
        identity,
      );
      await writeFile(
        join(interrupted.workspace, "audio.wav"),
        Buffer.from("interrupted temporary audio"),
      );
      await recoverAlignmentWorkspaces(recoveryOptions);
      await expect(stat(interrupted.workspace)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readdir(join(userDataDirectory, "alignment-workspaces"))).toEqual([]);
      process.stdout.write("Packaged Alignment stage: interrupted_workspace_recovered\n");
    }
  }
  expect(
    await inspectInstalled(
      userDataDirectory,
      `(async () => {
    for (const language of ["en", "ru"]) {
      const projectId = "project_native_alignment_" + language;
      const snapshot = await window.openChords.project.getSnapshot(projectId);
      const status = await window.openChords.alignment.perform({ type: "status", projectId });
      if (snapshot.type !== "project.snapshot" || status.type !== "alignment.result") return false;
      const completed = status.jobs.find(job => job.state === "succeeded");
      if (!completed || !snapshot.project.lyricsAlignments.some(item => item.id === completed.alignmentId)) return false;
      const selected = await window.openChords.alignment.perform({ type: "select", projectId, expectedProjectRevisionId: snapshot.projectRevisionId, alignmentId: completed.alignmentId });
      if (selected.type !== "alignment.result") return false;
      const reopened = await window.openChords.project.getSnapshot(projectId);
      if (reopened.type !== "project.snapshot" || reopened.project.activeView.lyricsAlignmentId !== completed.alignmentId) return false;
    }
    return true;
  })()`,
    ),
  ).toBe(true);
});

async function inspectInstalled(stateRoot: string, expression: string) {
  const port = await reservePort();
  const application = spawn(
    executablePath,
    [`--remote-debugging-port=${port}`, `--user-data-dir=${stateRoot}`],
    { stdio: "ignore" },
  );
  let target: z.infer<typeof CdpTargetsSchema>[number] | undefined;
  try {
    await expect
      .poll(
        async () => {
          try {
            target = CdpTargetsSchema.parse(
              await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(),
            ).find(
              (candidate) =>
                candidate.type === "page" && candidate.url.startsWith("open-chords://"),
            );
            return Boolean(target);
          } catch {
            return false;
          }
        },
        { timeout: 30000 },
      )
      .toBe(true);
    if (!target) throw new Error("Installed Alignment capability is unavailable");
    return await evaluatePackagedExpression(
      target.webSocketDebuggerUrl,
      `(async () => {
      const deadline = Date.now() + 10000;
      while (!window.openChords && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
      return await (${expression});
    })()`,
      60000,
    );
  } finally {
    try {
      if (target) await quitInstalledApplication(application, target.webSocketDebuggerUrl);
    } finally {
      if (
        process.platform !== "win32" &&
        application.exitCode === null &&
        application.signalCode === null
      )
        application.kill("SIGKILL");
      await stopApplication(application);
    }
  }
}

async function quitInstalledApplication(
  application: ReturnType<typeof spawn>,
  webSocketUrl: string,
) {
  if (application.exitCode !== null || application.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(webSocketUrl);
    let sent = false;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      application.off("exit", onExit);
      socket.close();
      if (error) reject(error);
      else resolve();
    };
    const onExit = (code: number | null) =>
      finish(code === 0 ? undefined : new Error("Installed app did not quit cleanly"));
    const timeout = setTimeout(
      () => finish(new Error("Installed app quit lifecycle timed out")),
      15000,
    );
    application.once("exit", onExit);
    socket.addEventListener(
      "error",
      () => {
        // Quit may close the debugging socket before the process exit event.
        // Once sent, only a clean exit proves completion; the deadline remains active.
        if (!sent) finish(new Error("Installed app quit connection failed"));
      },
      { once: true },
    );
    // Electron handles Browser.close by invoking Browser::Quit on its main thread.
    socket.addEventListener(
      "open",
      () => {
        socket.send(JSON.stringify({ id: 1, method: "Browser.close" }));
        sent = true;
      },
      { once: true },
    );
  });
}

test("installed app installs an exact English pack, reopens, and removes it through named IPC", async () => {
  test.setTimeout(480_000);
  const stateRoot = join(packageRoot, "models-user-data");
  const operate = async (body: string) => {
    const port = await reservePort();
    const application = spawn(
      executablePath,
      [`--remote-debugging-port=${port}`, `--user-data-dir=${stateRoot}`],
      { stdio: "ignore" },
    );
    try {
      let target: z.infer<typeof CdpTargetsSchema>[number] | undefined;
      await expect
        .poll(
          async () => {
            try {
              const response = await fetch(`http://127.0.0.1:${port}/json/list`);
              target = CdpTargetsSchema.parse(await response.json()).find(
                (candidate) =>
                  candidate.type === "page" && candidate.url.startsWith("open-chords://"),
              );
              return Boolean(target);
            } catch {
              return false;
            }
          },
          { timeout: 30_000 },
        )
        .toBe(true);
      if (!target) throw new Error("Installed model capability is unavailable");
      return await evaluatePackagedExpression(
        target.webSocketDebuggerUrl,
        `(async () => {
        const deadline = Date.now() + 10000;
        while (!window.openChords && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
        const perform = action => window.openChords.models.perform(action);
        ${body}
      })()`,
        330_000,
      );
    } finally {
      if (process.platform !== "win32") application.kill("SIGKILL");
      await stopApplication(application);
    }
  };
  expect(
    await operate(`
    const before = await perform({type: "status"});
    if (before.type !== "models.result" || !before.runtime.available || before.packs.some(pack => pack.installed)) return false;
    const installed = await perform({type: "install", packId: "english_mfa-3.1.0"});
    return installed.type === "models.result" && installed.packs.find(pack => pack.language === "en").installed;
  `),
  ).toBe(true);
  expect(
    await operate(`
    const reopened = await perform({type: "status"});
    if (reopened.type !== "models.result" || !reopened.packs.find(pack => pack.language === "en").installed) return false;
    const preview = await perform({type: "preview_removal", packId: "english_mfa-3.1.0"});
    if (preview.type !== "models.result" || preview.removal.affectedProjectIds.length !== 0) return false;
    const removed = await perform({type: "remove", packId: preview.removal.packId, impactId: preview.removal.impactId});
    return removed.type === "models.result" && removed.packs.every(pack => !pack.installed);
  `),
  ).toBe(true);
  expect(
    await operate(`
    const reopened = await perform({type: "status"});
    return reopened.type === "models.result" && reopened.packs.every(pack => !pack.installed);
  `),
  ).toBe(true);
});

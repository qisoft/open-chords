import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { expect, it } from "vitest";

import { AcquisitionBroker } from "../apps/desktop/src/main/acquisition-broker.ts";
import { runAcquisitionSession } from "../apps/desktop/src/main/acquisition-session.ts";
import {
  createUncontainedSpawnLauncherForProof,
  parseSidecarSessionRequest,
} from "../apps/desktop/src/main/sidecar-session.ts";

it("runs the pinned worker's sole request handler with streaming and the real HTTP downloader", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "open-chords-acquisition-proof-"));
  const media = Buffer.alloc(700_123, 37);
  const page = JSON.stringify({
    padding: "x".repeat(300_000),
    url: "https://rr1---sn-abcd.googlevideo.com/videoplayback?id=abc123&itag=140&source=youtube&mime=audio%2Fmp4",
  });
  const destinations: string[] = [];
  let pid: number | undefined;
  const broker = new AcquisitionBroker({
    videoId: "aqz-KE-bpKQ",
    network: {
      resolve: async () => ({ aliases: [], addresses: ["142.250.74.206"] }),
      request: async ({ url }) => {
        destinations.push(url.pathname);
        if (url.pathname === "/watch")
          return new Response(page, { headers: { "content-type": "text/html" } });
        return new Response(media, {
          headers: { "content-type": "audio/mp4", "content-length": String(media.length) },
        });
      },
    },
  });
  const launcher = createUncontainedSpawnLauncherForProof({
    executablePath:
      process.env.OPEN_CHORDS_ACQUISITION_PYTHON ??
      resolve(
        "dist/acquisition-runtime/open-chords-acquisition",
        process.platform === "win32" ? "open-chords-acquisition.exe" : "open-chords-acquisition",
      ),
    args: [
      ...(process.env.OPEN_CHORDS_ACQUISITION_PYTHON
        ? [resolve("sidecar/acquisition/entry.py")]
        : []),
      "--transport-proof",
    ],
    cwd: workspace,
    env: {},
    onSpawn: (value) => {
      pid = value;
    },
  });
  try {
    const result = await runAcquisitionSession({
      videoId: "aqz-KE-bpKQ",
      broker,
      proof: true,
      launch: (signal) =>
        launcher.launch(
          parseSidecarSessionRequest({
            jobId: "acquisition-proof",
            requestId: "acquisition-proof",
            nonce: "native-launch",
            manifestHash: "a".repeat(64),
            timeoutMs: 15000,
          }),
          signal,
        ),
    });
    expect(result).toMatchObject({
      proof: true,
      artifact: {
        path: "media.bin",
        bytes: media.length,
        sha256: createHash("sha256").update(media).digest("hex"),
      },
    });
    expect(await readFile(join(workspace, "media.bin"))).toEqual(media);
    expect(destinations).toEqual(["/watch", "/videoplayback"]);
    expect(broker.counters()).toMatchObject({
      activeStreams: 0,
      responseBytes: Buffer.byteLength(page) + media.length,
    });
    expect(() => process.kill(pid!, 0)).toThrow(/ESRCH|kill/u);
  } finally {
    await broker.close();
    await rm(workspace, { recursive: true, force: true });
  }
}, 20000);

it.each(["truncated", "network_failure"] as const)(
  "retries a %s progressive transfer through the broker",
  async (failure) => {
    const workspace = await mkdtemp(join(tmpdir(), "open-chords-acquisition-retry-"));
    const media = Buffer.alloc(100_000, 51);
    const ranges: (string | undefined)[] = [];
    const broker = new AcquisitionBroker({
      videoId: "aqz-KE-bpKQ",
      network: {
        resolve: async () => ({ aliases: [], addresses: ["142.250.74.206"] }),
        request: async ({ url, headers }) => {
          if (url.pathname === "/watch")
            return new Response(
              JSON.stringify({
                url: "https://rr1---sn-abcd.googlevideo.com/videoplayback?id=abc123&itag=140&source=youtube&mime=audio%2Fmp4",
              }),
            );
          ranges.push(headers["range"]);
          if (failure === "network_failure") {
            if (ranges.length === 1) throw new Error("private provider token");
            return new Response(media, {
              headers: { "content-type": "audio/mp4", "content-length": "100000" },
            });
          }
          if (ranges.length === 1)
            return new Response(media.subarray(0, 20_000), {
              headers: { "content-type": "audio/mp4", "content-length": "100000" },
            });
          return new Response(media.subarray(20_000), {
            status: 206,
            headers: {
              "content-type": "audio/mp4",
              "content-length": "80000",
              "content-range": "bytes 20000-99999/100000",
            },
          });
        },
      },
    });
    const launcher = createUncontainedSpawnLauncherForProof({
      executablePath:
        process.env.OPEN_CHORDS_ACQUISITION_PYTHON ??
        resolve(
          "dist/acquisition-runtime/open-chords-acquisition",
          process.platform === "win32" ? "open-chords-acquisition.exe" : "open-chords-acquisition",
        ),
      args: [
        ...(process.env.OPEN_CHORDS_ACQUISITION_PYTHON
          ? [resolve("sidecar/acquisition/entry.py")]
          : []),
        "--transport-proof",
      ],
      cwd: workspace,
      env: {},
    });
    try {
      await runAcquisitionSession({
        videoId: "aqz-KE-bpKQ",
        broker,
        proof: true,
        launch: (signal) =>
          launcher.launch(
            parseSidecarSessionRequest({
              jobId: "retry",
              requestId: "retry",
              nonce: "launch",
              manifestHash: "a".repeat(64),
              timeoutMs: 15000,
            }),
            signal,
          ),
      });
      expect(await readFile(join(workspace, "media.bin"))).toEqual(media);
      expect(ranges).toEqual(
        failure === "truncated" ? [undefined, "bytes=20000-"] : [undefined, undefined],
      );
    } finally {
      await broker.close();
      await rm(workspace, { recursive: true, force: true });
    }
  },
  20000,
);

it("fails closed on a bot check from the real Youtube extractor without a media transfer", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "open-chords-acquisition-bot-check-"));
  const player = {
    playabilityStatus: {
      status: "LOGIN_REQUIRED",
      reason: "Sign in to confirm you're not a bot. private-provider-token",
    },
    videoDetails: { videoId: "aqz-KE-bpKQ", title: "Private fixture title", lengthSeconds: "3" },
  };
  const destinations: string[] = [];
  const broker = new AcquisitionBroker({
    videoId: "aqz-KE-bpKQ",
    network: {
      resolve: async () => ({ aliases: [], addresses: ["142.250.74.206"] }),
      request: async ({ url }) => {
        destinations.push(url.pathname);
        if (url.pathname === "/watch")
          return new Response(`var ytInitialPlayerResponse = ${JSON.stringify(player)};`, {
            headers: { "content-type": "text/html" },
          });
        if (url.pathname === "/youtubei/v1/player")
          return new Response(JSON.stringify(player), {
            headers: { "content-type": "application/json" },
          });
        return new Response("var placeholder = 1;", {
          headers: { "content-type": "text/javascript" },
        });
      },
    },
  });
  const launcher = createUncontainedSpawnLauncherForProof({
    executablePath:
      process.env.OPEN_CHORDS_ACQUISITION_PYTHON ??
      resolve(
        "dist/acquisition-runtime/open-chords-acquisition",
        process.platform === "win32" ? "open-chords-acquisition.exe" : "open-chords-acquisition",
      ),
    args: [
      ...(process.env.OPEN_CHORDS_ACQUISITION_PYTHON
        ? [resolve("sidecar/acquisition/entry.py")]
        : []),
      "--acquire",
    ],
    cwd: workspace,
    env: {},
  });
  try {
    await expect(
      runAcquisitionSession({
        videoId: "aqz-KE-bpKQ",
        broker,
        launch: (signal) =>
          launcher.launch(
            parseSidecarSessionRequest({
              jobId: "bot-check",
              requestId: "bot-check",
              nonce: "launch",
              manifestHash: "a".repeat(64),
              timeoutMs: 15000,
            }),
            signal,
          ),
      }),
    ).rejects.toMatchObject({ code: "bot_check", message: "bot_check" });
    expect(destinations).toContain("/watch");
    expect(destinations).not.toContain("/videoplayback");
    await expect(readFile(join(workspace, "media.bin"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(broker.counters().activeStreams).toBe(0);
  } finally {
    await broker.close();
    await rm(workspace, { recursive: true, force: true });
  }
}, 20000);

it("extracts one progressive object with the pinned Youtube extractor and no manifest fetch", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "open-chords-acquisition-extract-"));
  const media = Buffer.alloc(50_000, 42);
  const mediaUrl =
    "https://rr1---sn-abcd.googlevideo.com/videoplayback?id=abc123&itag=18&source=youtube&mime=video%2Fmp4";
  const player = {
    playabilityStatus: { status: "OK" },
    videoDetails: {
      videoId: "aqz-KE-bpKQ",
      title: "Synthetic authorized fixture",
      lengthSeconds: "3",
      isLiveContent: false,
    },
    streamingData: {
      formats: [
        {
          itag: 18,
          url: mediaUrl,
          mimeType: 'video/mp4; codecs="avc1.42001E, mp4a.40.2"',
          contentLength: "50000",
          bitrate: 100000,
          width: 320,
          height: 180,
          quality: "small",
          audioQuality: "AUDIO_QUALITY_LOW",
          approxDurationMs: "3000",
        },
      ],
      hlsManifestUrl: "https://manifest.googlevideo.com/api/manifest/hls/forbidden",
      dashManifestUrl: "https://manifest.googlevideo.com/api/manifest/dash/forbidden",
    },
  };
  const destinations: string[] = [];
  const broker = new AcquisitionBroker({
    videoId: "aqz-KE-bpKQ",
    network: {
      resolve: async () => ({ aliases: [], addresses: ["142.250.74.206"] }),
      request: async ({ url }) => {
        destinations.push(url.pathname);
        if (url.pathname === "/watch")
          return new Response(`var ytInitialPlayerResponse = ${JSON.stringify(player)};`, {
            headers: { "content-type": "text/html" },
          });
        if (url.pathname === "/youtubei/v1/player")
          return new Response(JSON.stringify(player), {
            headers: { "content-type": "application/json" },
          });
        if (url.pathname === "/videoplayback")
          return new Response(media, {
            headers: { "content-type": "video/mp4", "content-length": "50000" },
          });
        return new Response("var placeholder = 1;", {
          headers: { "content-type": "text/javascript" },
        });
      },
    },
  });
  const launcher = createUncontainedSpawnLauncherForProof({
    executablePath:
      process.env.OPEN_CHORDS_ACQUISITION_PYTHON ??
      resolve(
        "dist/acquisition-runtime/open-chords-acquisition",
        process.platform === "win32" ? "open-chords-acquisition.exe" : "open-chords-acquisition",
      ),
    args: [
      ...(process.env.OPEN_CHORDS_ACQUISITION_PYTHON
        ? [resolve("sidecar/acquisition/entry.py")]
        : []),
      "--acquire",
    ],
    cwd: workspace,
    env: {},
  });
  try {
    const result = await runAcquisitionSession({
      videoId: "aqz-KE-bpKQ",
      broker,
      launch: (signal) =>
        launcher.launch(
          parseSidecarSessionRequest({
            jobId: "extract",
            requestId: "extract",
            nonce: "launch",
            manifestHash: "a".repeat(64),
            timeoutMs: 15000,
          }),
          signal,
        ),
    });
    expect(result).toMatchObject({
      proof: false,
      artifact: {
        path: "media.bin",
        bytes: 50000,
        sha256: createHash("sha256").update(media).digest("hex"),
      },
    });
    expect(await readFile(join(workspace, "media.bin"))).toEqual(media);
    expect(destinations.filter((path) => path === "/videoplayback")).toHaveLength(1);
    expect(destinations.some((path) => path.includes("manifest"))).toBe(false);
  } finally {
    await broker.close();
    await rm(workspace, { recursive: true, force: true });
  }
}, 20000);

it("cancels a worker waiting for the broker and reaps it before returning", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "open-chords-acquisition-cancel-"));
  let requested: () => void = () => undefined;
  const ready = new Promise<void>((resolveRequest) => {
    requested = resolveRequest;
  });
  let pid: number | undefined;
  const broker = new AcquisitionBroker({
    videoId: "aqz-KE-bpKQ",
    network: {
      resolve: async () => ({ aliases: [], addresses: ["142.250.74.206"] }),
      request: async ({ signal }) =>
        new Promise<Response>((_, reject) => {
          requested();
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    },
  });
  const launcher = createUncontainedSpawnLauncherForProof({
    executablePath:
      process.env.OPEN_CHORDS_ACQUISITION_PYTHON ??
      resolve(
        "dist/acquisition-runtime/open-chords-acquisition",
        process.platform === "win32" ? "open-chords-acquisition.exe" : "open-chords-acquisition",
      ),
    args: [
      ...(process.env.OPEN_CHORDS_ACQUISITION_PYTHON
        ? [resolve("sidecar/acquisition/entry.py")]
        : []),
      "--transport-proof",
    ],
    cwd: workspace,
    env: {},
    onSpawn: (value) => {
      pid = value;
    },
  });
  const abort = new AbortController();
  try {
    const running = runAcquisitionSession({
      videoId: "aqz-KE-bpKQ",
      broker,
      proof: true,
      signal: abort.signal,
      launch: (signal) =>
        launcher.launch(
          parseSidecarSessionRequest({
            jobId: "cancel",
            requestId: "cancel",
            nonce: "launch",
            manifestHash: "a".repeat(64),
            timeoutMs: 15000,
          }),
          signal,
        ),
    });
    const rejected = running.catch((error: unknown) => error);
    await ready;
    abort.abort();
    expect(await rejected).toMatchObject({ code: "cancelled" });
    expect(() => process.kill(pid!, 0)).toThrow(/ESRCH|kill/u);
    expect(broker.counters().activeStreams).toBe(0);
  } finally {
    await broker.close();
    await rm(workspace, { recursive: true, force: true });
  }
}, 20000);

it("waits for a late worker launch and reaps that process when cancellation wins the race", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "open-chords-acquisition-late-"));
  const abort = new AbortController();
  let spawned: () => void = () => undefined;
  const ready = new Promise<void>((resolveSpawn) => {
    spawned = resolveSpawn;
  });
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolveLaunch) => {
    release = resolveLaunch;
  });
  let pid: number | undefined;
  const launcher = createUncontainedSpawnLauncherForProof({
    executablePath:
      process.env.OPEN_CHORDS_ACQUISITION_PYTHON ??
      resolve(
        "dist/acquisition-runtime/open-chords-acquisition",
        process.platform === "win32" ? "open-chords-acquisition.exe" : "open-chords-acquisition",
      ),
    args: [
      ...(process.env.OPEN_CHORDS_ACQUISITION_PYTHON
        ? [resolve("sidecar/acquisition/entry.py")]
        : []),
      "--transport-proof",
    ],
    cwd: workspace,
    env: {},
    onSpawn: (value) => {
      pid = value;
      spawned();
    },
  });
  const broker = new AcquisitionBroker({ videoId: "aqz-KE-bpKQ" });
  let child: Awaited<ReturnType<typeof launcher.launch>> | undefined;
  let settled = false;
  try {
    const running = runAcquisitionSession({
      videoId: "aqz-KE-bpKQ",
      broker,
      proof: true,
      signal: abort.signal,
      launch: async () => {
        child = await launcher.launch(
          parseSidecarSessionRequest({
            jobId: "late",
            requestId: "late",
            nonce: "launch",
            manifestHash: "a".repeat(64),
            timeoutMs: 15000,
          }),
          new AbortController().signal,
        );
        await held;
        return child;
      },
    })
      .catch((error: unknown) => error)
      .finally(() => {
        settled = true;
      });
    await ready;
    abort.abort();
    await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
    expect(settled).toBe(false);
    release();
    expect(await running).toMatchObject({ code: "cancelled" });
    expect(() => process.kill(pid!, 0)).toThrow(/ESRCH|kill/u);
  } finally {
    release();
    await child?.stop("completed");
    await broker.close();
    await rm(workspace, { recursive: true, force: true });
  }
}, 20000);

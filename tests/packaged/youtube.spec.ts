import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chromium, expect, test, type Browser } from "@playwright/test";
import extractZip from "extract-zip";

import {
  installYouTubeMediaFixture,
  installYouTubeProviderFixture,
} from "../support/youtube-provider-fixture.ts";

test.skip(
  process.platform !== "darwin" && process.platform !== "win32",
  "Installed macOS/Windows profiles",
);
let root: string;
let executable: string;
test.beforeAll(async () => {
  test.setTimeout(90000);
  root = await mkdtemp(join(tmpdir(), "open-chords-installed-youtube-"));
  await extractZip(
    join(
      process.cwd(),
      "out",
      "make",
      "zip",
      process.platform,
      process.arch,
      `Open Chords-${process.platform}-${process.arch}-0.0.0.zip`,
    ),
    { dir: root },
  );
  executable =
    process.platform === "darwin"
      ? join(root, "Open Chords.app", "Contents", "MacOS", "Open Chords")
      : join(root, "Open Chords.exe");
});
test.afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true, maxRetries: 40, retryDelay: 250 });
});

async function launchInstalled() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Debug port missing");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const state = await mkdtemp(join(root, "profile-"));
  const child = spawn(
    executable,
    [`--remote-debugging-port=${address.port}`, `--user-data-dir=${state}`],
    { stdio: "ignore" },
  );
  const endpoint = `http://127.0.0.1:${address.port}`;
  let connected: Browser | undefined;
  try {
    await expect
      .poll(
        async () =>
          fetch(`${endpoint}/json/version`).then(
            (response) => response.ok,
            () => false,
          ),
        { timeout: 30000 },
      )
      .toBe(true);
    const browser = await chromium.connectOverCDP(endpoint);
    connected = browser;
    process.stdout.write("YouTube installed probe: CDP connected\n");
    const context = browser.contexts()[0];
    if (!context) throw new Error("Installed context missing");
    await expect
      .poll(() => context.pages().some((page) => page.url().startsWith("open-chords://")), {
        timeout: 30000,
      })
      .toBe(true);
    const primary = context.pages().find((page) => page.url().startsWith("open-chords://"));
    if (!primary) throw new Error("Installed primary target missing");
    await expect(
      primary.getByRole("button", { name: "YouTube source", exact: true }),
    ).toBeVisible();
    process.stdout.write("YouTube installed probe: primary ready\n");
    return { child, browser, context, primary };
  } catch (error) {
    if (connected) await stopInstalled(child, connected);
    else child.kill();
    throw error;
  }
}
async function stopInstalled(child: ChildProcess, browser: Browser) {
  try {
    const cdp = await browser.newBrowserCDPSession();
    process.stdout.write("YouTube installed probe: closing\n");
    // Electron may exit without acknowledging Browser.close on this transport.
    void cdp.send("Browser.close").catch(() => undefined);
    await expect
      .poll(() => child.exitCode !== null || child.signalCode !== null, { timeout: 15000 })
      .toBe(true);
  } finally {
    await browser.close();
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
}

test("installed isolated player preserves commands, errors and Offline Mode at the named API", async () => {
  test.setTimeout(120000);
  const { child, browser, context, primary } = await launchInstalled();
  try {
    await installYouTubeProviderFixture(context);
    process.stdout.write("YouTube installed probe: provider fixture installed\n");
    await primary.evaluate(() =>
      window.openChords!.youtube.perform({
        type: "open_player",
        url: "https://youtu.be/aqz-KE-bpKQ",
      }),
    );
    process.stdout.write("YouTube installed probe: player opened\n");
    await expect
      .poll(() => primary.evaluate(() => window.openChords!.youtube.perform({ type: "status" })))
      .toMatchObject({ player: { state: "ready" } });
    const results = await primary.evaluate(async () => {
      const status = await window.openChords!.youtube.perform({ type: "status" });
      if (status.type !== "youtube.result" || !status.player) throw new Error("Player missing");
      const sessionId = status.player.sessionId;
      const play = await window.openChords!.youtube.perform({ type: "play", sessionId });
      const pause = await window.openChords!.youtube.perform({ type: "pause", sessionId });
      const seek = await window.openChords!.youtube.perform({
        type: "seek",
        sessionId,
        seconds: 42.5,
      });
      const rate = await window.openChords!.youtube.perform({
        type: "set_rate",
        sessionId,
        rate: 1.5,
      });
      return { play, pause, seek, rate };
    });
    expect(results).toMatchObject({
      play: { player: { state: "playing" } },
      pause: { player: { state: "paused" } },
      seek: { player: { seconds: 42.5 } },
      rate: { player: { rate: 1.5 } },
    });
    await expect
      .poll(() => context.pages().some((page) => page.url().startsWith("open-chords-player://")), {
        timeout: 30000,
      })
      .toBe(true);
    const player = context.pages().find((page) => page.url().startsWith("open-chords-player://"));
    if (!player) throw new Error("Installed player target missing");
    expect(
      await player.evaluate(async () => ({
        origin: location.origin,
        api: "openChords" in window,
        node: "require" in window || "process" in window,
        local: await fetch("open-chords://app/index.html").then(
          () => true,
          () => false,
        ),
        popup: window.open("https://example.com") !== null,
      })),
    ).toEqual({
      origin: "open-chords-player://player",
      api: false,
      node: false,
      local: false,
      popup: false,
    });
    for (const [code, error] of [
      [153, "missing_identity"],
      [101, "not_embeddable"],
      [-1, "autoplay_denied"],
    ] as const) {
      await primary.evaluate(
        (videoId) =>
          window.openChords!.youtube.perform({
            type: "open_player",
            url: `https://youtu.be/${videoId}`,
          }),
        `error${String(code === -1 ? 1 : code).padStart(6, "0")}`,
      );
      await expect
        .poll(() => primary.evaluate(() => window.openChords!.youtube.perform({ type: "status" })))
        .toMatchObject({ player: { state: "error", error } });
    }
    await primary.evaluate(() =>
      window.openChords!.youtube.perform({
        type: "open_player",
        url: "https://youtu.be/stall000000",
      }),
    );
    await expect
      .poll(() => primary.evaluate(() => window.openChords!.youtube.perform({ type: "status" })))
      .toMatchObject({ player: { state: "ready" } });
    await primary.evaluate(async () => {
      const status = await window.openChords!.youtube.perform({ type: "status" });
      if (status.type !== "youtube.result" || !status.player) throw new Error("Player missing");
      return window.openChords!.youtube.perform({
        type: "play",
        sessionId: status.player.sessionId,
      });
    });
    await expect
      .poll(() => primary.evaluate(() => window.openChords!.youtube.perform({ type: "status" })))
      .toMatchObject({ player: { state: "buffering", seconds: 1 } });
    await expect
      .poll(() => primary.evaluate(() => window.openChords!.youtube.perform({ type: "status" })), {
        timeout: 18000,
      })
      .toMatchObject({ player: { state: "error", error: "network_unavailable" } });
    await context.unrouteAll({ behavior: "wait" });
    await context.route("https://www.youtube.com/**", (route) =>
      route.abort("internetdisconnected"),
    );
    await primary.evaluate(() =>
      window.openChords!.youtube.perform({
        type: "open_player",
        url: "https://youtu.be/aqz-KE-bpKQ",
      }),
    );
    await expect
      .poll(() => primary.evaluate(() => window.openChords!.youtube.perform({ type: "status" })))
      .toMatchObject({ player: { state: "error", error: "network_unavailable" } });
    expect(
      await primary.evaluate(() =>
        window.openChords!.youtube.perform({ type: "set_offline", offline: true }),
      ),
    ).toMatchObject({ offline: true, player: null });
    await expect.poll(() => context.pages().length).toBe(1);
    expect(
      await primary.evaluate(() =>
        window.openChords!.youtube.perform({
          type: "open_player",
          url: "https://youtu.be/aqz-KE-bpKQ",
        }),
      ),
    ).toMatchObject({ type: "desktop.error" });
  } finally {
    await stopInstalled(child, browser);
  }
});

test("installed live YouTube starts from application controls without player activation", async () => {
  const testInfo = test.info();
  test.skip(
    process.env.OPEN_CHORDS_LIVE_YOUTUBE !== "1",
    "Live-provider observations run explicitly, separately from deterministic fixtures",
  );
  test.setTimeout(120000);
  const { child, browser, context, primary } = await launchInstalled();
  const identity: string[] = [];
  const states: unknown[] = [];
  try {
    // Browser-level target discovery attaches to the real player before its provider requests.
    context.on("page", (page) => {
      void (async () => {
        const cdp = await context.newCDPSession(page);
        await cdp.send("Network.enable");
        cdp.on("Network.requestWillBeSentExtraInfo", (event) => {
          const referer = event.headers.Referer ?? event.headers.referer;
          if (typeof referer === "string" && referer === "https://io.github.qisoft.open-chords/")
            identity.push(referer);
        });
      })().catch(() => undefined);
    });
    await primary.evaluate(() =>
      window.openChords!.youtube.perform({
        type: "open_player",
        url: "https://youtu.be/aqz-KE-bpKQ",
      }),
    );
    await expect
      .poll(() => context.pages().some((page) => page.url().startsWith("open-chords-player://")), {
        timeout: 30000,
      })
      .toBe(true);
    const player = context.pages().find((page) => page.url().startsWith("open-chords-player://"));
    if (!player) throw new Error("Installed player target missing");
    await expect
      .poll(() => primary.evaluate(() => window.openChords!.youtube.perform({ type: "status" })), {
        timeout: 30000,
      })
      .toMatchObject({ player: { state: "ready" } });
    await primary.getByRole("button", { name: "YouTube source", exact: true }).click();
    await primary.getByRole("button", { name: "Play YouTube", exact: true }).click();
    await expect
      .poll(
        async () => {
          const result = await primary.evaluate(() =>
            window.openChords!.youtube.perform({ type: "status" }),
          );
          states.push(result.type === "youtube.result" ? result.player : { type: result.type });
          return (
            result.type === "youtube.result" &&
            result.player?.state === "playing" &&
            result.player.seconds > 2
          );
        },
        { timeout: 30000 },
      )
      .toBe(true);
    expect(identity.length).toBeGreaterThan(0);
    const result = await primary.evaluate(() =>
      window.openChords!.youtube.perform({ type: "status" }),
    );
    if (result.type !== "youtube.result" || !result.player)
      throw new Error("Live playback missing");
    const advancingSeconds = result.player.seconds;
    await primary.evaluate(async (sessionId) => {
      await window.openChords!.youtube.perform({ type: "seek", sessionId, seconds: 30 });
      await window.openChords!.youtube.perform({ type: "set_rate", sessionId, rate: 1.5 });
      await window.openChords!.youtube.perform({ type: "pause", sessionId });
    }, result.player.sessionId);
    await expect
      .poll(() => primary.evaluate(() => window.openChords!.youtube.perform({ type: "status" })))
      .toMatchObject({ player: { state: "paused", rate: 1.5 } });
    const paused = await primary.evaluate(() =>
      window.openChords!.youtube.perform({ type: "status" }),
    );
    if (paused.type !== "youtube.result" || !paused.player)
      throw new Error("Live seek result missing");
    expect(paused.player.seconds).toBeGreaterThanOrEqual(29);
    expect(paused.player.seconds).toBeLessThan(40);
    const observationPath = testInfo.outputPath("live-player-observation.json");
    await writeFile(
      observationPath,
      JSON.stringify(
        {
          observedAt: new Date().toISOString(),
          platform: process.platform,
          arch: process.arch,
          origin: player.url(),
          referer: identity[0],
          advancingSeconds,
          startedFrom: "application_play_button_without_player_interaction",
          player: {
            videoId: paused.player.videoId,
            state: paused.player.state,
            seconds: paused.player.seconds,
            durationSeconds: paused.player.durationSeconds,
            rate: paused.player.rate,
          },
        },
        null,
        2,
      ),
    );
    await testInfo.attach("live-player-observation", {
      path: observationPath,
      contentType: "application/json",
    });
    await player.screenshot({ path: testInfo.outputPath("live-player.png") });
  } catch (error) {
    const failurePath = testInfo.outputPath("live-player-failure.json");
    await writeFile(
      failurePath,
      JSON.stringify({ platform: process.platform, arch: process.arch, identity, states }, null, 2),
    );
    await testInfo.attach("live-player-failure", {
      path: failurePath,
      contentType: "application/json",
    });
    const player = context.pages().find((page) => page.url().startsWith("open-chords-player://"));
    if (player)
      await player
        .screenshot({ path: testInfo.outputPath("live-player-failure.png"), timeout: 5000 })
        .catch(() => undefined);
    throw error;
  } finally {
    await stopInstalled(child, browser);
  }
});

test("installed application Play starts unmuted iframe media without player interaction", async () => {
  test.setTimeout(90000);
  const { child, browser, context, primary } = await launchInstalled();
  try {
    await installYouTubeMediaFixture(context);
    await primary.getByRole("button", { name: "YouTube source", exact: true }).click();
    await primary.getByLabel("YouTube video URL").fill("https://youtu.be/aqz-KE-bpKQ");
    await primary.getByRole("button", { name: "Open player", exact: true }).click();
    await expect
      .poll(() => primary.evaluate(() => window.openChords!.youtube.perform({ type: "status" })))
      .toMatchObject({ player: { state: "ready", seconds: 0 } });
    const player = context.pages().find((page) => page.url().startsWith("open-chords-player://"));
    if (!player) throw new Error("Player target missing");
    const activation = await context.newCDPSession(player);
    expect(
      (
        await activation.send("Runtime.evaluate", {
          expression: "navigator.userActivation.hasBeenActive",
          returnByValue: true,
          userGesture: false,
        })
      ).result.value,
    ).toBe(false);
    await primary.getByRole("button", { name: "Play YouTube", exact: true }).click();
    await expect
      .poll(async () => {
        const status = await primary.evaluate(() =>
          window.openChords!.youtube.perform({ type: "status" }),
        );
        return (
          status.type === "youtube.result" &&
          status.player?.state === "playing" &&
          status.player.seconds > 0
        );
      })
      .toBe(true);
    expect(
      (
        await activation.send("Runtime.evaluate", {
          expression: "navigator.userActivation.hasBeenActive",
          returnByValue: true,
          userGesture: false,
        })
      ).result.value,
    ).toBe(false);
  } finally {
    await stopInstalled(child, browser);
  }
});

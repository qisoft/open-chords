import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chromium, expect, test, type Browser } from "@playwright/test";
import extractZip from "extract-zip";

import { installYouTubeProviderFixture } from "../support/youtube-provider-fixture.ts";

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
  const context = browser.contexts()[0];
  if (!context) throw new Error("Installed context missing");
  await expect
    .poll(() => context.pages().some((page) => page.url().startsWith("open-chords://")))
    .toBe(true);
  const primary = context.pages().find((page) => page.url().startsWith("open-chords://"))!;
  await expect(primary.getByRole("button", { name: "YouTube source", exact: true })).toBeVisible();
  return { child, browser, context, primary };
}
async function stopInstalled(child: ChildProcess, browser: Browser) {
  try {
    const cdp = await browser.newBrowserCDPSession();
    await cdp.send("Browser.close");
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
    await primary.evaluate(() =>
      window.openChords!.youtube.perform({
        type: "open_player",
        url: "https://youtu.be/aqz-KE-bpKQ",
      }),
    );
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
    const player = context.pages().find((page) => page.url().startsWith("open-chords-player://"))!;
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
      await context.unrouteAll({ behavior: "wait" });
      await installYouTubeProviderFixture(context, code);
      await primary.evaluate(() =>
        window.openChords!.youtube.perform({
          type: "open_player",
          url: "https://youtu.be/aqz-KE-bpKQ",
        }),
      );
      await expect
        .poll(() => primary.evaluate(() => window.openChords!.youtube.perform({ type: "status" })))
        .toMatchObject({ player: { state: "error", error } });
    }
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

test("installed live YouTube sends app identity and advances actual media time", async () => {
  const testInfo = test.info();
  test.skip(
    process.env.OPEN_CHORDS_LIVE_YOUTUBE !== "1",
    "Live-provider observations run explicitly, separately from deterministic fixtures",
  );
  test.setTimeout(120000);
  const { child, browser, context, primary } = await launchInstalled();
  const identity: string[] = [];
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
    const player = context.pages().find((page) => page.url().startsWith("open-chords-player://"))!;
    await player
      .frameLocator("iframe")
      .getByRole("button", { name: "Play video", exact: true })
      .click({ timeout: 30000 });
    await expect
      .poll(
        async () => {
          const result = await primary.evaluate(() =>
            window.openChords!.youtube.perform({ type: "status" }),
          );
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
    await testInfo.attach("live-player-observation", {
      body: JSON.stringify(
        {
          platform: process.platform,
          arch: process.arch,
          origin: player.url(),
          referer: identity[0],
          result,
        },
        null,
        2,
      ),
      contentType: "application/json",
    });
  } finally {
    await stopInstalled(child, browser);
  }
});

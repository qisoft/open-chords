import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { _electron as electron, expect, test } from "@playwright/test";

import { installYouTubeProviderFixture } from "../support/youtube-provider-fixture.ts";

for (const [code, error] of [
  [2, "invalid_video"],
  [5, "playback_failed"],
  [100, "unavailable"],
  [101, "not_embeddable"],
  [150, "not_embeddable"],
  [153, "missing_identity"],
  [-1, "autoplay_denied"],
] as const) {
  test(`YouTube provider error ${code} is normalized as ${error}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "open-chords-youtube-error-"));
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env))
      if (key !== "ELECTRON_RUN_AS_NODE" && value !== undefined) env[key] = value;
    const application = await electron.launch({
      args: [join(import.meta.dirname, "../.."), `--user-data-dir=${root}`],
      env,
    });
    try {
      await installYouTubeProviderFixture(application.context(), code);
      const primary = await application.firstWindow();
      await expect(primary.getByRole("heading", { name: "Open a local recording" })).toBeVisible();
      await primary.evaluate(() =>
        window.openChords!.youtube.perform({
          type: "open_player",
          url: "https://youtu.be/aqz-KE-bpKQ",
        }),
      );
      await expect
        .poll(() => primary.evaluate(() => window.openChords!.youtube.perform({ type: "status" })))
        .toMatchObject({ type: "youtube.result", player: { state: "error", error } });
      if (code === -1) {
        const recovered = await primary.evaluate(async () => {
          const status = await window.openChords!.youtube.perform({ type: "status" });
          if (status.type !== "youtube.result" || !status.player) throw new Error("Player missing");
          return window.openChords!.youtube.perform({
            type: "play",
            sessionId: status.player.sessionId,
          });
        });
        expect(recovered).toMatchObject({ player: { state: "playing" } });
        expect(recovered.type === "youtube.result" && recovered.player?.error).toBeUndefined();
        const player = application.windows().find((page) => page !== primary)!;
        await expect(player.getByRole("status")).toHaveText("Playback: playing");
      }
    } finally {
      await application.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("a slow provider status read leaves the existing player session available", async () => {
  const root = mkdtempSync(join(tmpdir(), "open-chords-youtube-slow-"));
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env))
    if (key !== "ELECTRON_RUN_AS_NODE" && value !== undefined) env[key] = value;
  const application = await electron.launch({
    args: [join(import.meta.dirname, "../.."), `--user-data-dir=${root}`],
    env,
  });
  try {
    await installYouTubeProviderFixture(application.context());
    const primary = await application.firstWindow();
    await expect(
      primary.getByRole("button", { name: "YouTube source", exact: true }),
    ).toBeVisible();
    await primary.evaluate(() =>
      window.openChords!.youtube.perform({
        type: "open_player",
        url: "https://youtu.be/slow0000000",
      }),
    );
    await expect.poll(() => application.windows().length).toBe(2);
    const player = application.windows().find((page) => page !== primary)!;
    await expect(
      player.frameLocator("iframe").getByText("Deterministic provider fixture"),
    ).toBeVisible();
    expect(
      await primary.evaluate(() => window.openChords!.youtube.perform({ type: "status" })),
    ).toMatchObject({ player: { videoId: "slow0000000" } });
    expect(application.windows()).toHaveLength(2);
    await expect
      .poll(() => primary.evaluate(() => window.openChords!.youtube.perform({ type: "status" })))
      .toMatchObject({ player: { state: "ready", videoId: "slow0000000" } });
  } finally {
    await application.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("the named player API opens an unprivileged surface and Offline Mode destroys it", async () => {
  test.setTimeout(60000);
  const root = mkdtempSync(join(tmpdir(), "open-chords-youtube-player-"));
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key !== "ELECTRON_RUN_AS_NODE" && value !== undefined) env[key] = value;
  }
  const application = await electron.launch({
    args: [join(import.meta.dirname, "../.."), `--user-data-dir=${root}`],
    env,
  });
  try {
    await installYouTubeProviderFixture(application.context());
    const primary = await application.firstWindow();
    await expect(primary.getByRole("heading", { name: "Open a local recording" })).toBeVisible();
    await primary.getByRole("button", { name: "YouTube source", exact: true }).click();
    await primary
      .getByRole("textbox", { name: "YouTube video URL" })
      .fill("https://youtu.be/aqz-KE-bpKQ");
    await primary.getByRole("button", { name: "Open player", exact: true }).click();
    await expect
      .poll(() =>
        primary.evaluate(() =>
          window.openChords!.youtube.perform({
            type: "status",
          }),
        ),
      )
      .toMatchObject({ type: "youtube.result", player: { videoId: "aqz-KE-bpKQ" } });
    await expect.poll(() => application.windows().length).toBe(2);
    await expect
      .poll(async () => {
        const response = await primary.evaluate(() =>
          window.openChords!.youtube.perform({ type: "status" }),
        );
        return response.type === "youtube.result" ? response.player?.state : response.type;
      })
      .toBe("ready");
    const oldSession = await primary.evaluate(async () => {
      const response = await window.openChords!.youtube.perform({ type: "status" });
      return response.type === "youtube.result" ? response.player : null;
    });
    expect(oldSession).toHaveProperty("sessionId");
    await primary.getByRole("button", { name: "Close controls", exact: true }).click();
    await expect.poll(() => application.windows().length).toBe(2);
    await primary.getByRole("button", { name: "YouTube source", exact: true }).click();
    await expect
      .poll(() => primary.evaluate(() => window.openChords!.youtube.perform({ type: "status" })))
      .toMatchObject({ player: oldSession });
    expect(
      await primary.evaluate(() =>
        window.openChords!.youtube.perform({ type: "set_offline", offline: false }),
      ),
    ).toMatchObject({ player: oldSession });
    await primary.getByRole("button", { name: "Play YouTube", exact: true }).click();
    await expect(primary.getByText("Player playing", { exact: true })).toBeVisible();
    await primary.getByRole("button", { name: "Pause YouTube", exact: true }).click();
    await expect(primary.getByText("Player paused", { exact: true })).toBeVisible();
    await primary.getByRole("spinbutton", { name: "Source time in seconds" }).fill("42.5");
    await primary.getByRole("button", { name: "Seek YouTube", exact: true }).click();
    await primary.getByRole("combobox", { name: "YouTube playback speed" }).selectOption("1.5");
    await expect
      .poll(() => primary.evaluate(() => window.openChords!.youtube.perform({ type: "status" })))
      .toMatchObject({ player: { seconds: 42.5, rate: 1.5 } });
    const player = application.windows().find((page) => page !== primary)!;
    expect(
      await player.evaluate(async () => ({
        desktop: "openChords" in window,
        node: "require" in window || "process" in window,
        local: await fetch("open-chords://app/index.html").then(
          () => true,
          () => false,
        ),
        loopback: await fetch("http://127.0.0.1:1/private").then(
          () => true,
          () => false,
        ),
        popup: window.open("https://example.com") !== null,
      })),
    ).toEqual({ desktop: false, node: false, local: false, loopback: false, popup: false });
    const remote = player.frameLocator("iframe");
    await expect(remote.getByText("Deterministic provider fixture")).toBeVisible();
    expect(
      await remote
        .locator("body")
        .evaluate(() => "openChords" in window || "require" in window || "process" in window),
    ).toBe(false);
    if (!oldSession) throw new Error("Playback session missing");
    await primary.evaluate(() =>
      window.openChords!.youtube.perform({
        type: "open_player",
        url: "https://youtu.be/aqz-KE-bpKQ",
      }),
    );
    expect(
      await primary.evaluate(
        (sessionId) => window.openChords!.youtube.perform({ type: "seek", sessionId, seconds: 9 }),
        oldSession.sessionId,
      ),
    ).toMatchObject({ type: "desktop.error" });
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
      .toMatchObject({ player: { state: "buffering" } });
    await expect
      .poll(() => primary.evaluate(() => window.openChords!.youtube.perform({ type: "status" })), {
        timeout: 18000,
      })
      .toMatchObject({ player: { state: "error", error: "network_unavailable" } });
    expect(
      await primary.evaluate(() =>
        window.openChords!.youtube.perform({ type: "set_offline", offline: true }),
      ),
    ).toMatchObject({ type: "youtube.result", offline: true, player: null });
    await expect.poll(() => application.windows().length).toBe(1);
    expect(
      await primary.evaluate(() =>
        window.openChords!.youtube.perform({
          type: "open_player",
          url: "https://youtu.be/aqz-KE-bpKQ",
        }),
      ),
    ).toMatchObject({ type: "desktop.error" });
  } finally {
    await application.close();
    rmSync(root, { recursive: true, force: true });
  }
});

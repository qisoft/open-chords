import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { openAcquisitionJobs } from "../apps/desktop/src/main/acquisition-jobs.ts";
import { DesktopCommandGateway } from "../apps/desktop/src/main/desktop-command-gateway.ts";
import { openNetworkMode } from "../apps/desktop/src/main/network-mode.ts";
import { openProjectLibrary } from "../apps/desktop/src/main/project-library.ts";
import { YouTubeService } from "../apps/desktop/src/main/youtube-service.ts";
import { YouTubeMetadata } from "../apps/desktop/src/main/youtube-source.ts";
import { AcquisitionJobSummarySchema } from "../packages/contracts/src/youtube.ts";

test("named metadata commands persist safely while a remote player sender has no desktop authority", async () => {
  const root = await mkdtemp(join(tmpdir(), "open-chords-youtube-desktop-"));
  const library = await openProjectLibrary({ stateRoot: root });
  const network = await openNetworkMode(root);
  const acquisition = await openAcquisitionJobs({ stateRoot: root, network, library });
  const service = new YouTubeService({
    acquisition,
    library,
    network,
    metadata: new YouTubeMetadata({
      network,
      fetch: async () => Response.json({ title: "Public title", author_name: "Uploader" }),
    }),
  });
  const gateway = new DesktopCommandGateway(
    library,
    undefined,
    undefined,
    undefined,
    undefined,
    service,
  );
  const sender = {
    generationId: "generation_test",
    senderId: 1,
    isMainFrame: true,
    frameUrl: "open-chords://app/index.html",
    security: {
      contextIsolation: true,
      nodeIntegration: false,
      persistentSession: false,
      sandbox: true,
      webSecurity: true,
    },
  };
  const command = {
    protocol: "open-chords/desktop-ipc",
    protocolVersion: "1.0",
    requestId: "request_test",
    generationId: "generation_test",
    type: "youtube.perform",
    action: { type: "refresh", url: "https://youtu.be/aqz-KE-bpKQ" },
  };
  try {
    expect((await gateway.execute(command, sender)).response).toMatchObject({
      type: "youtube.result",
      offline: false,
      sources: [{ videoId: "aqz-KE-bpKQ", title: "Public title" }],
      player: null,
    });
    expect(
      (
        await gateway.execute(command, {
          ...sender,
          frameUrl: "https://www.youtube.com/embed/aqz-KE-bpKQ",
        })
      ).action,
    ).toBe("destroy_sender");
    expect(
      (
        await gateway.execute(
          { ...command, action: { type: "status", path: "/private/file" } },
          sender,
        )
      ).response,
    ).toMatchObject({ type: "desktop.error", code: "invalid_command" });
    const acquired = (
      await gateway.execute(
        { ...command, action: { type: "acquire", url: "https://youtu.be/aqz-KE-bpKQ?t=10" } },
        sender,
      )
    ).response;
    expect(acquired).toMatchObject({
      type: "youtube.result",
      acquisitionJobs: [
        { videoId: "aqz-KE-bpKQ", state: "blocked", reason: "runtime_unavailable" },
      ],
    });
    expect(JSON.stringify(acquired)).not.toContain("runtimeRoot");
    await gateway.execute({ ...command, action: { type: "set_offline", offline: true } }, sender);
    expect(
      (
        await gateway.execute(
          { ...command, action: { type: "acquire", url: "https://youtu.be/aqz-KE-bpKQ" } },
          sender,
        )
      ).response,
    ).toMatchObject({
      type: "youtube.result",
      acquisitionJobs: [
        { state: "blocked", reason: "offline" },
        { state: "blocked", reason: "runtime_unavailable" },
      ],
    });
    expect(
      (await gateway.execute({ ...command, action: { type: "clear_acquisition_history" } }, sender))
        .response,
    ).toMatchObject({ type: "youtube.result", acquisitionJobs: [] });
    expect(
      (
        await gateway.execute(
          {
            ...command,
            action: { type: "acquire", url: "https://youtu.be/aqz-KE-bpKQ", cookies: "secret" },
          },
          sender,
        )
      ).response,
    ).toMatchObject({ type: "desktop.error", code: "invalid_command" });
    const reopened = await openProjectLibrary({ stateRoot: root });
    expect((await reopened.listYouTubeSources())[0]?.metadataObservations).toHaveLength(1);
    expect(reopened.listProjects()).toEqual([]);
  } finally {
    service.close();
    await acquisition.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("public acquisition summaries reject impossible lifecycle combinations", () => {
  const identity = { id: "11111111-1111-4111-8111-111111111111", videoId: "aqz-KE-bpKQ" };
  for (const fields of [
    { state: "succeeded" },
    { state: "running" },
    { state: "failed" },
    { state: "cancelled", reason: "offline", snapshotId: `snapshot_${"a".repeat(64)}` },
    { state: "blocked", reason: "offline", stage: "acquiring" },
    { state: "succeeded", snapshotId: `snapshot_${"a".repeat(64)}`, reason: "worker_failed" },
  ])
    expect(AcquisitionJobSummarySchema.safeParse({ ...identity, ...fields }).success).toBe(false);
  for (const fields of [
    { state: "succeeded", snapshotId: `snapshot_${"a".repeat(64)}` },
    { state: "running", stage: "acquiring" },
    { state: "blocked", reason: "offline" },
    { state: "failed", reason: "worker_failed" },
    { state: "cancelled", reason: "cancelled" },
  ])
    expect(AcquisitionJobSummarySchema.safeParse({ ...identity, ...fields }).success).toBe(true);
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import { openAcquisitionJobs } from "../apps/desktop/src/main/acquisition-jobs.ts";
import { openNetworkMode } from "../apps/desktop/src/main/network-mode.ts";

it("retains a canonical blocked Job without an Attempt when the runtime is unavailable or offline", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "open-chords-acquisition-jobs-"));
  try {
    const network = await openNetworkMode(stateRoot);
    const jobs = await openAcquisitionJobs({ stateRoot, network });
    const missing = await jobs.start({ url: "https://youtu.be/aqz-KE-bpKQ" });
    expect(missing).toMatchObject({
      videoId: "aqz-KE-bpKQ",
      state: "blocked",
      reason: "runtime_unavailable",
      attempts: [],
    });
    await network.setOffline(true);
    const offline = await jobs.start({ url: "https://www.youtube.com/watch?v=aqz-KE-bpKQ" });
    expect(offline).toMatchObject({ state: "blocked", reason: "offline", attempts: [] });
    await jobs.close();
    const reopened = await openAcquisitionJobs({ stateRoot, network });
    expect(reopened.list()).toEqual([missing, offline]);
    await expect(
      reopened.start({ url: "https://www.youtube.com/playlist?list=PLprivate" }),
    ).rejects.toThrow("invalid_input");
    expect(JSON.stringify(reopened.list())).not.toContain("https:");
    await reopened.close();
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

it("expires failed history after seven days while the application remains open", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "open-chords-acquisition-retention-"));
  let now = new Date("2026-09-01T00:00:00.000Z");
  try {
    const network = await openNetworkMode(stateRoot);
    const jobs = await openAcquisitionJobs({ stateRoot, network, now: () => now });
    await jobs.start({ url: "https://youtu.be/aqz-KE-bpKQ" });
    now = new Date("2026-09-07T23:59:59.999Z");
    expect(jobs.list()).toHaveLength(1);
    now = new Date("2026-09-08T00:00:00.000Z");
    expect(jobs.list()).toEqual([]);
    await jobs.close();
    const reopened = await openAcquisitionJobs({ stateRoot, network, now: () => now });
    expect(reopened.list()).toEqual([]);
    await reopened.close();
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

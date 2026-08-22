import { describe, expect, it } from "vitest";

import {
  continueLoopAtBoundary,
  requestProjectPlayback,
} from "../apps/desktop/src/renderer/workspace-playback.ts";

describe("workspace playback request", () => {
  it("resumes an ended Source after seeking to the loop start", async () => {
    let playCount = 0;
    const source = {
      ended: true,
      play: async () => {
        playCount += 1;
      },
    };
    const seeks: number[] = [];

    const message = await continueLoopAtBoundary(source, 12_000, (positionSamples) => {
      seeks.push(positionSamples);
      source.ended = false;
    });

    expect(seeks).toEqual([12_000]);
    expect(playCount).toBe(1);
    expect(message).toBeNull();
  });

  it("reports a rejected loop resume", async () => {
    await expect(
      continueLoopAtBoundary(
        { ended: true, play: async () => Promise.reject(new Error("resume blocked")) },
        12_000,
        () => undefined,
      ),
    ).resolves.toBe("Playback could not resume the loop. Check the verified Source.");
  });

  it("turns rejected preload IPC into a visible playback error", async () => {
    await expect(
      requestProjectPlayback(
        { openPlayback: async () => Promise.reject(new Error("transport unavailable")) },
        "project_fixture",
      ),
    ).resolves.toEqual({
      kind: "error",
      message: "Could not prepare the verified Source for playback.",
    });
  });
});

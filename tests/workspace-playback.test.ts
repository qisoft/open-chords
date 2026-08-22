import { describe, expect, it } from "vitest";

import { requestProjectPlayback } from "../apps/desktop/src/renderer/workspace-playback.ts";

describe("workspace playback request", () => {
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

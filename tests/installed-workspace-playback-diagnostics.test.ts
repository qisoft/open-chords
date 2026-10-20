import { expect, it } from "vitest";

import { workspacePlaybackDiagnostic } from "./support/installed-workspace-playback-diagnostics.ts";

const probe = {
  stage: "start",
  visibility: "visible",
  ready: "complete",
  buttonConnected: true,
  buttonEnabled: true,
  label: "play",
  trackConnected: true,
  timelineChanged: false,
  audioCount: 1,
  audioReady: 0,
  audioNetwork: 2,
  audioError: 0,
  audioPaused: true,
  audioEnded: false,
  audioPositionPositive: false,
  audioSourcePresent: false,
  alertPresent: false,
  mutations: 0,
  oldPauseSeen: false,
};
it("reports fixed workspace/media state without content", () => {
  const result = workspacePlaybackDiagnostic(probe);
  expect(result).toContain("stage=start");
  expect(result).toContain("audioReady=0");
  expect(result).toContain("oldPauseSeen=false");
});
it.each([
  { ...probe, label: "private title" },
  { ...probe, audioReady: 5 },
  { ...probe, audioNetwork: 4 },
  { ...probe, audioError: 5 },
  { ...probe, audioCount: 3 },
  { ...probe, mutations: 257 },
  { ...probe, url: "file:///private/media.wav" },
])("rejects private or unbounded observations", (value) => {
  expect(workspacePlaybackDiagnostic(value)).toBe("Workspace playback probe: invalid_evidence");
});

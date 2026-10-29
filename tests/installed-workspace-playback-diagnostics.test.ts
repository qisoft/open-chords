import { runInNewContext } from "node:vm";

import { expect, it } from "vitest";

import {
  workspacePlaybackDiagnostic,
  workspacePlaybackAlertCategory,
} from "./support/installed-workspace-playback-diagnostics.ts";

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

it.each([
  [null, "none"],
  [undefined, "none"],
  ["Playback could not start. Check the verified Source.", "start_refused"],
  ["Could not prepare the verified Source for playback.", "prepare_refused"],
  ["The verified Source is unavailable. Relink it to enable playback.", "source_unavailable"],
  ["Playback could not resume the loop. Check the verified Source.", "loop_refused"],
  ["/private/path provider-token", "other"],
  [{ private: "secret" }, "other"],
])("classifies source alerts without retaining private text", (value, expected) => {
  expect(workspacePlaybackAlertCategory(value)).toBe(expected);
  expect(workspacePlaybackDiagnostic({ ...probe, sourceAlert: expected })).toContain(
    `sourceAlert=${expected}`,
  );
});
it("rejects private text in the new diagnostic field", () => {
  expect(workspacePlaybackDiagnostic({ ...probe, sourceAlert: "/private/path" })).toBe(
    "Workspace playback probe: invalid_evidence",
  );
});
it("serializes a self-contained classifier for the read-only renderer probe", () => {
  const evaluate = (value: unknown): unknown =>
    runInNewContext(`(${workspacePlaybackAlertCategory.toString()})(value)`, { value });
  expect(evaluate("Playback could not start. Check the verified Source.")).toBe("start_refused");
  expect(evaluate("private")).toBe("other");
});

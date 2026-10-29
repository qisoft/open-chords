import { z } from "zod";

export const WorkspacePlaybackProbeSchema = z.strictObject({
  stage: z.enum(["start", "timeline"]),
  visibility: z.enum(["visible", "hidden", "other"]),
  ready: z.enum(["loading", "interactive", "complete", "other"]),
  buttonConnected: z.boolean(),
  buttonEnabled: z.boolean(),
  label: z.enum(["play", "pause", "other"]),
  trackConnected: z.boolean(),
  timelineChanged: z.boolean(),
  audioCount: z.number().int().min(0).max(2),
  audioReady: z.number().int().min(-1).max(4),
  audioNetwork: z.number().int().min(-1).max(3),
  audioError: z.number().int().min(0).max(4),
  audioPaused: z.boolean(),
  audioEnded: z.boolean(),
  audioPositionPositive: z.boolean(),
  audioSourcePresent: z.boolean(),
  alertPresent: z.boolean(),
  sourceAlert: z
    .enum([
      "none",
      "start_refused",
      "prepare_refused",
      "source_unavailable",
      "loop_refused",
      "other",
    ])
    .optional(),
  mutations: z.number().int().min(0).max(256),
  oldPauseSeen: z.boolean(),
});

export function workspacePlaybackDiagnostic(value: unknown) {
  const result = WorkspacePlaybackProbeSchema.safeParse(value);
  if (!result.success) return "Workspace playback probe: invalid_evidence";
  return (
    "Workspace playback probe: " +
    Object.entries(result.data)
      .map(([key, item]) => `${key}=${item}`)
      .join(" ")
  );
}

export function workspacePlaybackAlertCategory(value: unknown) {
  if (value === null || value === undefined) return "none";
  switch (value) {
    case "Playback could not start. Check the verified Source.":
      return "start_refused";
    case "Could not prepare the verified Source for playback.":
      return "prepare_refused";
    case "The verified Source is unavailable. Relink it to enable playback.":
      return "source_unavailable";
    case "Playback could not resume the loop. Check the verified Source.":
      return "loop_refused";
    default:
      return "other";
  }
}

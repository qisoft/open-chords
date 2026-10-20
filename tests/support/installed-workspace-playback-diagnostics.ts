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

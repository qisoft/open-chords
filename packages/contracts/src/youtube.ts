import { z } from "zod";
const playbackSession = { sessionId: z.string().regex(/^playback_[a-f0-9]{32}$/) };

export const YouTubeActionSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("status") }),
  z.strictObject({ type: z.literal("acquire"), url: z.string().min(1).max(4096) }),
  z.strictObject({ type: z.literal("cancel_acquisition"), jobId: z.string().uuid() }),
  z.strictObject({ type: z.literal("clear_acquisition_history") }),
  z.strictObject({ type: z.literal("refresh"), url: z.string().min(1).max(4096) }),
  z.strictObject({ type: z.literal("set_offline"), offline: z.boolean() }),
  z.strictObject({ type: z.literal("cancel") }),
  z.strictObject({ type: z.literal("open_player"), url: z.string().min(1).max(4096) }),
  z.strictObject({ type: z.literal("open_external"), url: z.string().min(1).max(4096) }),
  z.strictObject({ type: z.literal("close_player") }),
  z.strictObject({ ...playbackSession, type: z.literal("play") }),
  z.strictObject({ ...playbackSession, type: z.literal("pause") }),
  z.strictObject({
    ...playbackSession,
    type: z.literal("seek"),
    seconds: z.number().finite().min(0).max(86400),
  }),
  z.strictObject({
    ...playbackSession,
    type: z.literal("set_rate"),
    rate: z.number().finite().min(0.25).max(2),
  }),
]);

export const YouTubePlayerStateSchema = z.strictObject({
  ...playbackSession,
  videoId: z.string().regex(/^[A-Za-z0-9_-]{11}$/),
  state: z.enum(["loading", "ready", "playing", "paused", "ended", "buffering", "error"]),
  seconds: z.number().finite().min(0).max(86400),
  durationSeconds: z.number().finite().min(0).max(86400),
  rate: z.number().finite().min(0.25).max(2),
  error: z
    .enum([
      "invalid_video",
      "playback_failed",
      "unavailable",
      "not_embeddable",
      "missing_identity",
      "autoplay_denied",
      "network_unavailable",
    ])
    .optional(),
});
export const YouTubeSourceSummarySchema = z.strictObject({
  snapshots: z
    .array(
      z.strictObject({
        id: z.string().min(1).max(150),
        durationSamples: z.number().int().positive(),
      }),
    )
    .max(1000),
  id: z.string().min(1).max(150),
  videoId: z.string().regex(/^[A-Za-z0-9_-]{11}$/),
  title: z.string().max(500).optional(),
  uploader: z.string().max(500).optional(),
  observedAt: z.string().max(50).optional(),
});
export type YouTubeAction = z.infer<typeof YouTubeActionSchema>;
export type YouTubePlayerState = z.infer<typeof YouTubePlayerStateSchema>;

const AcquisitionReasonSchema = z.enum([
  "offline",
  "runtime_unavailable",
  "cancelled",
  "interrupted",
  "bot_check",
  "unsupported_delivery",
  "provider_unavailable",
  "endpoint_denied",
  "dns_denied",
  "network_unavailable",
  "budget_exceeded",
  "deadline",
  "cleanup_failure",
  "worker_failed",
  "invalid_output",
]);

const AcquisitionSummaryIdentity = z.strictObject({
  id: z.string().uuid(),
  videoId: z.string().regex(/^[A-Za-z0-9_-]{11}$/),
});
export const AcquisitionJobSummarySchema = z.discriminatedUnion("state", [
  AcquisitionSummaryIdentity.extend({
    state: z.literal("running"),
    stage: z.enum(["acquiring", "validating", "publishing"]),
  }),
  AcquisitionSummaryIdentity.extend({
    state: z.literal("succeeded"),
    snapshotId: z.string().regex(/^snapshot_[a-f0-9]{64}$/),
  }),
  AcquisitionSummaryIdentity.extend({
    state: z.literal("blocked"),
    reason: AcquisitionReasonSchema,
  }),
  AcquisitionSummaryIdentity.extend({
    state: z.literal("failed"),
    reason: AcquisitionReasonSchema,
  }),
  AcquisitionSummaryIdentity.extend({
    state: z.literal("cancelled"),
    reason: z.literal("cancelled"),
  }),
]);

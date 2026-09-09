import { z } from "zod";
const playbackSession = { sessionId: z.string().regex(/^playback_[a-f0-9]{32}$/) };

export const YouTubeActionSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("status") }),
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
  id: z.string().min(1).max(150),
  videoId: z.string().regex(/^[A-Za-z0-9_-]{11}$/),
  title: z.string().max(500).optional(),
  uploader: z.string().max(500).optional(),
  observedAt: z.string().max(50).optional(),
});
export type YouTubeAction = z.infer<typeof YouTubeActionSchema>;
export type YouTubePlayerState = z.infer<typeof YouTubePlayerStateSchema>;

import { z } from "zod";

const id = z.string().min(1).max(160);
export const AlignmentActionSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("status"), projectId: id }),
  z.strictObject({ type: z.literal("start"), projectId: id, expectedProjectRevisionId: id }),
  z.strictObject({ type: z.literal("cancel"), projectId: id, jobId: id }),
  z.strictObject({ type: z.literal("retry"), projectId: id, jobId: id }),
  z.strictObject({
    type: z.literal("select"),
    projectId: id,
    expectedProjectRevisionId: id,
    alignmentId: id,
  }),
]);
export const AlignmentJobSummarySchema = z.strictObject({
  id,
  projectId: id,
  lyricsDocumentId: id,
  analysisRevisionId: id,
  state: z.enum([
    "blocked",
    "queued",
    "running",
    "succeeded",
    "retryable",
    "cancelled",
    "awaiting_confirmation",
  ]),
  blockedReasons: z
    .array(z.enum(["missing_pack", "unsupported_language", "missing_runtime"]))
    .max(3),
  alignmentId: id.optional(),
  stage: z
    .enum([
      "waiting_for_cpu",
      "verifying_runtime",
      "staging",
      "aligning",
      "cleanup",
      "validating",
      "completed",
    ])
    .optional(),
  cleanupPending: z.boolean(),
  elapsedMs: z.number().int().nonnegative(),
});
export type AlignmentAction = z.infer<typeof AlignmentActionSchema>;
export type AlignmentJobSummary = z.infer<typeof AlignmentJobSummarySchema>;

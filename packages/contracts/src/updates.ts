import { z } from "zod";

export const UpdateActionSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("status") }),
  z.strictObject({ type: z.literal("check") }),
  z.strictObject({ type: z.literal("cancel") }),
  z.strictObject({ type: z.literal("open_release") }),
  z.strictObject({ type: z.literal("open_verification") }),
]);
export const UpdateReleaseSchema = z.strictObject({
  tag: z
    .string()
    .regex(/^v?\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/)
    .max(100),
  name: z.string().max(200),
  notes: z.string().max(64000),
  publishedAt: z.iso.datetime(),
  url: z
    .string()
    .regex(/^https:\/\/github\.com\/qisoft\/open-chords\/releases\/tag\/[A-Za-z0-9.-]+$/),
  checksumsUrl: z
    .string()
    .regex(
      /^https:\/\/github\.com\/qisoft\/open-chords\/releases\/download\/[A-Za-z0-9.-]+\/SHA256SUMS$/,
    )
    .nullable(),
  artifacts: z
    .array(
      z.strictObject({
        name: z
          .string()
          .regex(/^open-chords-[A-Za-z0-9.-]+-(?:macos-arm64|windows-x64)\.zip$/)
          .max(200),
        size: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        sha256: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .nullable(),
      }),
    )
    .max(2),
});
export const UpdateStatusSchema = z.strictObject({
  state: z.enum([
    "idle",
    "checking",
    "available",
    "not_published",
    "offline",
    "cancelled",
    "failed",
  ]),
  currentVersion: z.string().max(100),
  target: z.enum(["macos-arm64", "windows-x64", "unsupported"]),
  offline: z.boolean(),
  checkedAt: z.iso.datetime().nullable(),
  release: UpdateReleaseSchema.nullable(),
});
export type UpdateStatus = z.infer<typeof UpdateStatusSchema>;
export type UpdateAction = z.infer<typeof UpdateActionSchema>;

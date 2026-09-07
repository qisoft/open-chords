import { z } from "zod";

export const AlignmentPackIdSchema = z.enum(["english_mfa-3.1.0", "russian_mfa-3.1.0"]);
export const ModelActionSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("status") }),
  z.strictObject({ type: z.literal("cancel") }),
  z.strictObject({ type: z.literal("set_offline"), offline: z.boolean() }),
  z.strictObject({ type: z.literal("install"), packId: AlignmentPackIdSchema }),
  z.strictObject({ type: z.literal("preview_removal"), packId: AlignmentPackIdSchema }),
  z.strictObject({
    type: z.literal("remove"),
    packId: AlignmentPackIdSchema,
    impactId: z.string().regex(/^[a-f0-9]{64}$/),
  }),
]);
export const ModelRuntimeInfoSchema = z.strictObject({
  id: z.literal("mfa-3.4.1"),
  available: z.boolean(),
  placement: z.literal("bundled"),
  installedBytes: z.number().int().nonnegative(),
  transferBytes: z.number().int().nonnegative(),
});
export const ModelPackInfoSchema = z.strictObject({
  id: AlignmentPackIdSchema,
  language: z.enum(["en", "ru"]),
  version: z.literal("3.1.0"),
  installed: z.boolean(),
  transferBytes: z.number().int().positive(),
  installedBytes: z.number().int().positive(),
  artifacts: z
    .array(
      z.strictObject({
        id: z.string().max(100),
        version: z.string().max(100),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        source: z.url(),
        license: z.literal("CC-BY-4.0"),
        attribution: z.string().max(2000),
        modelCard: z.url(),
      }),
    )
    .min(1)
    .max(2),
});
export const ModelRemovalImpactSchema = z.strictObject({
  packId: AlignmentPackIdSchema,
  impactId: z.string().regex(/^[a-f0-9]{64}$/),
  affectedProjectIds: z.array(z.string().max(128)).max(10000),
  unknownProjectIds: z.array(z.string().max(128)).max(10000),
});
export type ModelRuntimeInfo = z.infer<typeof ModelRuntimeInfoSchema>;

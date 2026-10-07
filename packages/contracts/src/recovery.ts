import { z } from "zod";

import { DesktopMessageIdSchema } from "./identifiers.ts";

export const RecoveryActionSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("list") }),
  z.strictObject({ type: z.literal("inspect"), projectId: DesktopMessageIdSchema }),
  z.strictObject({
    type: z.literal("rollback"),
    projectId: DesktopMessageIdSchema,
    expectedProjectRevisionId: DesktopMessageIdSchema,
    targetProjectRevisionId: DesktopMessageIdSchema,
    confirmedTargetProjectRevisionId: DesktopMessageIdSchema,
  }),
]);
export const RecoveryProjectSchema = z.strictObject({
  projectId: DesktopMessageIdSchema,
  status: z.enum(["active", "damaged"]),
  compatibility: z.enum(["writable", "read_only"]).nullable(),
  projectRevisionId: DesktopMessageIdSchema.nullable(),
  readOnlyReason: z.enum(["migration_failed", "unsupported_schema"]).nullable(),
  recoveredHead: z.boolean(),
});
export const RecoveryDetailSchema = z.strictObject({
  project: RecoveryProjectSchema,
  schemaVersion: z
    .string()
    .regex(/^\d+\.\d+$/)
    .nullable(),
  earlierRevisionCount: z.number().int().nonnegative(),
  revisions: z
    .array(
      z.strictObject({
        projectRevisionId: DesktopMessageIdSchema,
        createdAt: z.iso.datetime({ offset: true }),
        reason: z.enum([
          "analysis_publication",
          "created",
          "edit_transaction",
          "migration",
          "restored",
          "rollback",
        ]),
      }),
    )
    .max(100),
  recovery: z
    .strictObject({
      createdAt: z.iso.datetime({ offset: true }),
      lostProjectRevisionId: DesktopMessageIdSchema.nullable(),
      recoveredProjectRevisionId: DesktopMessageIdSchema.nullable(),
    })
    .nullable(),
});
export const RecoveryResultSchema = z.strictObject({
  projects: z.array(RecoveryProjectSchema).max(10000),
  truncated: z.boolean(),
  detail: RecoveryDetailSchema.nullable(),
  restoredProjectRevisionId: DesktopMessageIdSchema.nullable(),
});
export type RecoveryResult = z.infer<typeof RecoveryResultSchema>;

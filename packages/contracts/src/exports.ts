import { JsonExportOptionsSchema, StableIdSchema } from "@open-chords/domain";
import { z } from "zod";

export const ExportActionSchema = z.discriminatedUnion("type", [
  JsonExportOptionsSchema.extend({
    type: z.literal("save_json"),
    projectId: StableIdSchema,
    expectedProjectRevisionId: z.string().regex(/^projectrevision_[a-f0-9]{32}$/),
  }),
  z.strictObject({
    type: z.literal("save_archive"),
    projectId: StableIdSchema,
    expectedProjectRevisionId: z.string().regex(/^projectrevision_[a-f0-9]{32}$/),
    includeMedia: z.boolean(),
  }),
  z.strictObject({ type: z.literal("list"), projectId: StableIdSchema }),
  z.strictObject({ type: z.literal("cancel"), projectId: StableIdSchema }),
  z.strictObject({ type: z.literal("recover"), projectId: StableIdSchema }),
]);
export const ExportReceiptSummarySchema = z.strictObject({
  id: StableIdSchema,
  createdAt: z.iso.datetime({ offset: true }),
  format: z.enum(["open_chords_json", "chordpro", "lrc", "pdf", "project_archive"]),
  profileVersion: z.string().min(1).max(100),
  outputHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  activeViewHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  detailsTruncated: z.boolean(),
  displayName: z.string().min(1).max(240),
  omissions: z.array(z.string().min(1).max(200)).max(100),
});
export type ExportAction = z.infer<typeof ExportActionSchema>;
export const ArchiveImportRejectionSchema = z.enum([
  "active_content",
  "compression_ratio",
  "declaration_mismatch",
  "encrypted_entry",
  "hash_mismatch",
  "identity_exhausted",
  "invariant_invalid",
  "link_entry",
  "malformed_zip",
  "missing_entry",
  "name_collision",
  "reference_invalid",
  "schema_invalid",
  "size_limit",
  "source_conflict",
  "undeclared_entry",
  "unreadable_archive",
  "unsafe_path",
  "unsupported_version",
  "unsupported_zip_feature",
]);
export type ArchiveImportRejection = z.infer<typeof ArchiveImportRejectionSchema>;

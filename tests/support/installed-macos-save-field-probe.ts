import { z } from "zod";

const formats = ["json", "lrc", "chordpro", "pdf", "archive"] as const;
export type MacSaveFormat = (typeof formats)[number];
const probeSchema = z.strictObject({
  format: z.enum(formats),
  total: z.number().int().min(0).max(256),
  unreadableRoles: z.number().int().min(0).max(256),
  truncated: z.boolean(),
  fields: z
    .array(
      z.strictObject({
        role: z.enum(["text_field", "combo"]),
        subrole: z.enum(["search", "empty", "other", "unavailable"]),
        name: z.enum(["save_as", "empty", "other", "unavailable"]),
        value: z.enum(["expected", "basename", "empty", "other", "unavailable"]),
        enabled: z.enum(["true", "false", "unknown"]),
      }),
    )
    .max(16),
});

export function installedMacSaveFieldDiagnostic(value: unknown, expectedFormat: MacSaveFormat) {
  const parsed = probeSchema.safeParse(value);
  if (
    !parsed.success ||
    parsed.data.format !== expectedFormat ||
    parsed.data.total + parsed.data.unreadableRoles > 256 ||
    parsed.data.fields.length !== Math.min(parsed.data.total, 16) ||
    parsed.data.truncated !== parsed.data.total > 16
  )
    return "Native macOS Save field probe: invalid_evidence";
  const probe = parsed.data;
  return [
    `Native macOS Save field probe: format=${probe.format} total=${probe.total} unreadable_roles=${probe.unreadableRoles} truncated=${probe.truncated}`,
    ...probe.fields.map(
      (field, index) =>
        `Native macOS Save field: index=${index} role=${field.role} subrole=${field.subrole} name=${field.name} value=${field.value} enabled=${field.enabled}`,
    ),
  ].join("\n");
}

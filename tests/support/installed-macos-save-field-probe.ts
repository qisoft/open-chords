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

function parseProbe(value: unknown, expectedFormat: MacSaveFormat) {
  const parsed = probeSchema.safeParse(value);
  if (
    !parsed.success ||
    parsed.data.format !== expectedFormat ||
    parsed.data.total + parsed.data.unreadableRoles > 256 ||
    parsed.data.fields.length !== Math.min(parsed.data.total, 16) ||
    parsed.data.truncated !== parsed.data.total > 16
  )
    return undefined;
  return parsed.data;
}

export function installedMacSaveDefaultFilenameVerified(
  value: unknown,
  expectedFormat: MacSaveFormat,
) {
  const probe = parseProbe(value, expectedFormat);
  if (
    !probe ||
    probe.truncated ||
    probe.unreadableRoles !== 0 ||
    probe.fields.some((field) => field.name === "unavailable")
  )
    return false;
  const named = probe.fields.filter((field) => field.name === "save_as");
  return (
    named.length === 1 &&
    named[0]?.role === "text_field" &&
    named[0].enabled === "true" &&
    named[0].value === "expected"
  );
}

export function installedMacSaveFieldDiagnostic(value: unknown, expectedFormat: MacSaveFormat) {
  const probe = parseProbe(value, expectedFormat);
  if (!probe) return "Native macOS Save field probe: invalid_evidence";
  return [
    `Native macOS Save field probe: format=${probe.format} total=${probe.total} unreadable_roles=${probe.unreadableRoles} truncated=${probe.truncated}`,
    ...probe.fields.map(
      (field, index) =>
        `Native macOS Save field: index=${index} role=${field.role} subrole=${field.subrole} name=${field.name} value=${field.value} enabled=${field.enabled}`,
    ),
  ].join("\n");
}

export function installedMacSaveResultVerified(
  value: unknown,
  expectedFormat: MacSaveFormat,
  scenario:
    | "cancel_save"
    | "cancel_save_edited"
    | "cancel_save_directory"
    | "cancel_save_edited_expanded",
): value is { saveFieldProbe: unknown } {
  const result = z
    .strictObject({
      action: z.literal(scenario),
      nativePress: z.literal(true),
      dialogDismissed: z.literal(true),
      defaultFilenameVerified: z.literal(true),
      filenameInputVerified: z.literal(scenario !== "cancel_save"),
      directoryNavigationVerified: z.literal(scenario === "cancel_save_directory"),
      saveFieldProbe: z.unknown(),
    })
    .safeParse(value);
  return (
    result.success &&
    installedMacSaveDefaultFilenameVerified(result.data.saveFieldProbe, expectedFormat)
  );
}

export function installedMacSaveDirectoryPreparationVerified(
  value: unknown,
  expectedFormat: MacSaveFormat,
) {
  const result = z
    .strictObject({
      prepared: z.literal(true),
      nativePress: z.literal(false),
      navigationDismissed: z.literal(true),
      directoryNavigationVerified: z.literal(true),
      defaultFilenameVerified: z.literal(true),
      saveFieldProbe: z.unknown(),
    })
    .safeParse(value);
  return (
    result.success &&
    installedMacSaveDefaultFilenameVerified(result.data.saveFieldProbe, expectedFormat)
  );
}

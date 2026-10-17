import { expect, it } from "vitest";

import {
  installedMacSaveDefaultFilenameVerified,
  installedMacSaveResultVerified,
  installedMacSaveFieldDiagnostic,
} from "./support/installed-macos-save-field-probe.ts";

const field = {
  role: "text_field",
  subrole: "empty",
  name: "save_as",
  value: "expected",
  enabled: "true",
};
const probe = { format: "json", total: 1, unreadableRoles: 0, truncated: false, fields: [field] };

it.each(["cancel_save", "cancel_save_edited", "cancel_save_directory"] as const)(
  "requires exact native acknowledgement for %s",
  (scenario) => {
    const result = {
      action: scenario,
      nativePress: true,
      dialogDismissed: true,
      defaultFilenameVerified: true,
      filenameInputVerified: scenario !== "cancel_save",
      directoryNavigationVerified: scenario === "cancel_save_directory",
      saveFieldProbe: probe,
    };
    expect(installedMacSaveResultVerified(result, "json", scenario)).toBe(true);
    for (const invalid of [
      { ...result, action: "cancel" },
      { ...result, nativePress: false },
      { ...result, dialogDismissed: false },
      { ...result, defaultFilenameVerified: false },
      { ...result, filenameInputVerified: !result.filenameInputVerified },
      { ...result, filenameInputVerified: undefined },
      { ...result, directoryNavigationVerified: !result.directoryNavigationVerified },
      { ...result, directoryNavigationVerified: undefined },
      { ...result, path: "/private/file" },
      { ...result, saveFieldProbe: { ...probe, fields: [{ ...field, value: "other" }] } },
    ])
      expect(installedMacSaveResultVerified(invalid, "json", scenario)).toBe(false);
    expect(installedMacSaveResultVerified(result, "pdf", scenario)).toBe(false);
  },
);

it.each(["json", "lrc", "chordpro", "pdf", "archive"] as const)(
  "accepts one exact enabled Save As field for %s",
  (format) => {
    expect(
      installedMacSaveDefaultFilenameVerified(
        {
          ...probe,
          format,
          total: 2,
          fields: [field, { ...field, name: "other", value: "empty" }],
        },
        format,
      ),
    ).toBe(true);
  },
);

it.each([
  { ...probe, total: 0, fields: [] },
  { ...probe, unreadableRoles: 1 },
  { ...probe, total: 17, truncated: true, fields: Array(16).fill(field) },
  { ...probe, total: 2, fields: [field, { ...field, enabled: "false" }] },
  ...["combo"].map((role) => ({ ...probe, fields: [{ ...field, role }] })),
  ...["false", "unknown"].map((enabled) => ({ ...probe, fields: [{ ...field, enabled }] })),
  ...["basename", "empty", "other", "unavailable"].map((value) => ({
    ...probe,
    fields: [{ ...field, value }],
  })),
  ...["empty", "other", "unavailable"].map((name) => ({ ...probe, fields: [{ ...field, name }] })),
  { ...probe, total: 2, fields: [field, { ...field, name: "unavailable" }] },
  { ...probe, format: "pdf" },
  { ...probe, path: "/private/file" },
])("refuses ambiguous, incomplete or inexact default filename evidence", (value) => {
  expect(installedMacSaveDefaultFilenameVerified(value, "json")).toBe(false);
});

it.each(["json", "lrc", "chordpro", "pdf", "archive"] as const)(
  "retains fixed Save categories for %s",
  (format) => {
    const output = installedMacSaveFieldDiagnostic({ ...probe, format }, format);
    expect(output).toContain(`format=${format} total=1 unreadable_roles=0 truncated=false`);
    expect(output).toContain(
      "index=0 role=text_field subrole=empty name=save_as value=expected enabled=true",
    );
  },
);

it("reports bounded truncated and empty observations without inventing filename proof", () => {
  const output = installedMacSaveFieldDiagnostic(
    { ...probe, total: 17, truncated: true, fields: Array(16).fill(field) },
    "json",
  );
  expect(output).toContain("total=17 unreadable_roles=0 truncated=true");
  expect(output.split("\n")).toHaveLength(17);
  expect(installedMacSaveFieldDiagnostic({ ...probe, total: 0, fields: [] }, "json")).toContain(
    "total=0 unreadable_roles=0 truncated=false",
  );
});

it.each([
  "/private/raw",
  { ...probe, path: "/private/file" },
  { ...probe, total: 257 },
  { ...probe, unreadableRoles: 256 },
  { ...probe, total: -1 },
  { ...probe, total: 2 },
  { ...probe, truncated: true },
  { ...probe, total: 17, truncated: true, fields: Array(17).fill(field) },
  { ...probe, fields: [{ ...field, name: "/private/file" }] },
  { ...probe, fields: [{ ...field, value: "/private/file" }] },
  { ...probe, fields: [{ ...field, subrole: "/private/file" }] },
  { ...probe, fields: [{ ...field, enabled: true }] },
  { ...probe, format: "pdf" },
])("rejects private, malformed or inconsistent Save observations", (value) => {
  expect(installedMacSaveFieldDiagnostic(value, "json")).toBe(
    "Native macOS Save field probe: invalid_evidence",
  );
});

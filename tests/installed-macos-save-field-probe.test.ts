import { expect, it } from "vitest";

import { installedMacSaveFieldDiagnostic } from "./support/installed-macos-save-field-probe.ts";

const field = {
  role: "text_field",
  subrole: "empty",
  name: "save_as",
  value: "expected",
  enabled: "true",
};
const probe = { format: "json", total: 1, unreadableRoles: 0, truncated: false, fields: [field] };

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

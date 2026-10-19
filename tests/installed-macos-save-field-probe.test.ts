import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

import { expect, it } from "vitest";

import {
  installedMacSaveDefaultFilenameVerified,
  installedMacSaveResultVerified,
  installedMacSaveDirectoryPreparationVerified,
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

it("requires read-only directory preparation and exact default evidence before the snapshot", () => {
  const preparation = {
    prepared: true,
    nativePress: false,
    navigationDismissed: true,
    directoryNavigationVerified: true,
    defaultFilenameVerified: true,
    saveFieldProbe: probe,
  };
  expect(installedMacSaveDirectoryPreparationVerified(preparation, "json")).toBe(true);
  for (const invalid of [
    { ...preparation, prepared: false },
    { ...preparation, nativePress: true },
    { ...preparation, navigationDismissed: false },
    { ...preparation, directoryNavigationVerified: false },
    { ...preparation, defaultFilenameVerified: false },
    { ...preparation, path: "/private/file" },
    { ...preparation, saveFieldProbe: { ...probe, unreadableRoles: 1 } },
  ])
    expect(installedMacSaveDirectoryPreparationVerified(invalid, "json")).toBe(false);
  expect(installedMacSaveDirectoryPreparationVerified(preparation, "pdf")).toBe(false);
});

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

it("expanded filename verification excludes only identified search fields", () => {
  const source = readFileSync(
    new URL("./support/installed-picker-macos.jxa", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("  function verifyDefaultFilename(");
  const end = source.indexOf("\n  try {\n    discovery:", start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const fixture = `
    var expandedControls = true;
    var saveDefaults = { json: 'Open Chords.json' };
    function attribute(field, key) { return Object.prototype.hasOwnProperty.call(field, key) ? field[key] : null; }
    var filename = { role: 'AXTextField', name: 'Save As:', value: 'Open Chords.json', enabled: true };
    var search = { role: 'AXTextField', subrole: 'AXSearchField', enabled: true };
    ${source.slice(start, end)}
    verifyDefaultFilename('json', [filename, search]).probe.total;
  `;
  expect(runInNewContext(fixture, { console: { log() {} } }, { timeout: 1000 })).toBe(1);
  expect(() =>
    runInNewContext(
      fixture.replace("var expandedControls = true", "var expandedControls = false"),
      {},
      { timeout: 1000 },
    ),
  ).toThrow("default filename unavailable");
  expect(() =>
    runInNewContext(
      fixture.replace("subrole: 'AXSearchField'", "subrole: 'other'"),
      { console: { log() {} } },
      { timeout: 1000 },
    ),
  ).toThrow("default filename unavailable");
  expect(() =>
    runInNewContext(
      fixture.replace("[filename, search]", "[filename, filename, search]"),
      { console: { log() {} } },
      { timeout: 1000 },
    ),
  ).toThrow("default filename unavailable");
});

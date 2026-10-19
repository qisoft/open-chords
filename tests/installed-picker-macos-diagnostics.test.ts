import { expect, it } from "vitest";

import {
  installedMacPickerDiagnostic,
  installedMacPickerRefreshDiagnostic,
  installedMacSaveControlsDiagnostic,
} from "./support/installed-picker-macos-diagnostics.ts";

it("retains only three fixed attribute failures and one allowlisted refusal", () => {
  const read = "Native macOS picker attribute: stage=action attribute=role os_error=-1728";
  const refusal = "Native macOS picker refusal: reason=navigation_parent_changed";
  const result = installedMacPickerDiagnostic(
    {},
    [
      read,
      read,
      read,
      read,
      refusal,
      refusal,
      read + " /private/path",
      read.replace("attribute=role", "attribute=/private/value"),
      refusal.replace("navigation_parent_changed", "/private/error"),
    ].join("\n"),
    1,
  );
  expect(result.split(read)).toHaveLength(4);
  expect(result.split(refusal)).toHaveLength(2);
  expect(result).not.toContain("private");
});

it.each(["activate", "before_input", "after_probe"])(
  "retains bounded guard observations at %s",
  (phase) => {
    const probe = `Native macOS picker guard: phase=${phase} mask=253 unknown_mask=0`;
    const diagnostic = installedMacPickerDiagnostic({}, (probe + "\n").repeat(5), 1);
    expect(diagnostic.split(probe)).toHaveLength(4);
  },
);

it.each([
  "phase=private mask=253 unknown_mask=0",
  "phase=activate mask=256 unknown_mask=0",
  "phase=activate mask=253 unknown_mask=256",
  "phase=activate mask=-1 unknown_mask=0",
  "phase=activate mask=253 unknown_mask=0 /private/path",
  "phase=activate mask=253 unknown_mask=private",
])("rejects malformed or private guard observations", (fields) => {
  expect(installedMacPickerDiagnostic({}, `Native macOS picker guard: ${fields}`, 1)).not.toContain(
    "picker guard:",
  );
});

it.each([
  "processes",
  "windows",
  "sheets",
  "elements",
  "selection",
  "navigation",
  "path_entry",
  "navigation_dismissal",
  "selected_file",
  "action",
  "dismissal",
  "deadline",
])("keeps only bounded macOS picker observations at %s", (stage) => {
  const probe = `Native macOS picker failure: stage=${stage} elapsed_ms=90000 processes=1 windows=2 sheets=1 elements=120 cancel=1 open=1 navigation_sheets=1 path_fields=1 selected_rows=1 selected_urls=1 selected_matches=1 selection_step=unverified os_error=-1743`;
  const diagnostic = installedMacPickerDiagnostic(
    { killed: true, signal: "SIGTERM", message: "/private/fixture" },
    `${probe}\n${probe}\n${probe} /private/file\n${probe.replace("windows=2", "windows=1234")}\n${probe.replace(`stage=${stage}`, "stage=private")}`,
    100000,
  );
  expect(diagnostic.split(probe)).toHaveLength(2);
  expect(diagnostic).toContain("killed=true");
  expect(diagnostic).not.toContain("private");
  expect(diagnostic).not.toContain("windows=1234");
  expect(installedMacPickerDiagnostic({}, `${probe}\n${"x".repeat(65536)}`, 100)).not.toContain(
    "stage=",
  );
});

it("retains only the last complete fixed selection classification without private AX data", () => {
  const probe =
    "Native macOS selection probe: step=complete os_error=none elements=99 complete=1 selected_boolean=1 selected_number=0 selected_string=0 selected_row=0 selected_cell=1 selected_image=0 selected_other=0 url_strings=2 url_matches=1 selected_children=1 selected_rows=0 containers=2 relationship_arrays=2 relationship_other=0 selected_filter=1 filter_errors=0 url_other=0 column_children=1 target_names=1 target_values=1 filename_strings=1 filename_matches=1";
  const diagnostic = installedMacPickerDiagnostic(
    {},
    [
      probe,
      probe,
      `${probe} /private/file`,
      probe.replace("selected_cell=1", "selected_cell=1000"),
      probe.replace("selected_cell=1", "AXPrivate=1"),
      "Native macOS selection probe: file:///private/file",
    ].join("\n"),
    9000,
  );
  expect(diagnostic.split(probe)).toHaveLength(2);
  expect(diagnostic).not.toContain("private");
  expect(diagnostic).not.toContain("1000");
  expect(diagnostic).not.toContain("AXPrivate");
  expect(installedMacPickerDiagnostic({}, `${probe}\n${"x".repeat(65536)}`, 1)).not.toContain(
    "selection probe",
  );
});

it.each([
  "elements",
  "selected",
  "role",
  "url",
  "relationships",
  "selected_query",
  "columns",
  "complete",
  "bound",
])("preserves selection probe progress and numeric failures at %s", (step) => {
  const probe = `Native macOS selection probe: step=${step} os_error=-1728 elements=0 complete=0 selected_boolean=0 selected_number=0 selected_string=0 selected_row=0 selected_cell=0 selected_image=0 selected_other=0 url_strings=0 url_matches=0 selected_children=0 selected_rows=0 containers=0 relationship_arrays=0 relationship_other=0 selected_filter=0 filter_errors=0 url_other=0 column_children=0 target_names=0 target_values=0 filename_strings=0 filename_matches=0`;
  expect(installedMacPickerDiagnostic({}, probe, 1)).toContain(probe);
  for (const malformed of [
    probe.replace(`step=${step}`, "step=private"),
    probe.replace("os_error=-1728", "os_error=/private/file"),
    probe.replace("elements=0", "elements=NaN"),
  ]) {
    expect(installedMacPickerDiagnostic({}, malformed, 1)).not.toContain("selection probe");
  }
});

it("retains a fixed probe failure without allowing an attached exception", () => {
  const probe = "Native macOS selection unavailable: fixed_probe_failure";
  expect(installedMacPickerDiagnostic({}, probe, 1)).toContain(probe);
  expect(installedMacPickerDiagnostic({}, `${probe} /private/file`, 1)).not.toContain(
    "selection unavailable",
  );
});

it("allows only fixed native target role and exact-match counts", () => {
  const probe =
    "Native macOS target probe: role=column matches=1 path_values=0 directory_values=1 url_values=0 path_attributes=0 document_matches=0";
  const diagnostic = installedMacPickerDiagnostic(
    {},
    [
      probe,
      probe,
      `${probe} /private/file`,
      probe.replace("role=column", "role=private"),
      probe.replace("matches=1", "matches=1000"),
    ].join("\n"),
    1,
  );
  expect(diagnostic.split(probe)).toHaveLength(2);
  expect(diagnostic).not.toContain("private");
  expect(diagnostic).not.toContain("1000");
});

it.each(["complete", "deadline", "bound", "error"])(
  "retains only the final fixed guard snapshot with status %s",
  (status) => {
    const probe = `Native macOS picker guard snapshot: phase=activate status=${status} age_ms=210 sheet_exists=false button_exists=false windows=1 sheets=1 os_error=-1728`;
    const diagnostic = installedMacPickerDiagnostic(
      {},
      [
        ...Array(4).fill(probe),
        `${probe} /private/path`,
        probe.replace("age_ms=210", "age_ms=1234567"),
        probe.replace("windows=1", "windows=18"),
        probe.replace("status=" + status, "status=private"),
        probe.replace("sheet_exists=false", "sheet_exists=private"),
      ].join("\n"),
      1,
    );
    expect(diagnostic.split(probe)).toHaveLength(2);
    expect(diagnostic).not.toContain("private");
    expect(diagnostic).not.toContain("windows=18");
    expect(diagnostic).not.toContain("1234567");
  },
);

it("retains only the fixed single pre-input stale-reference refresh", () => {
  const probe = "Native macOS picker refresh: reason=stale_reference attempt=1 before_input=true";
  expect(installedMacPickerRefreshDiagnostic(`/private/path\n${probe}\n`)).toBe(probe);
  expect(installedMacPickerDiagnostic({}, probe, 1)).toContain(probe);
  for (const line of [
    probe + " /private/path",
    probe.replace("attempt=1", "attempt=2"),
    probe.replace("before_input=true", "before_input=false"),
    probe.replace("stale_reference", "private"),
  ]) {
    expect(installedMacPickerRefreshDiagnostic(line)).toBeUndefined();
  }
});

it("retains only bounded dialog-control traversal evidence without private UI content", () => {
  const probe = "Native macOS Save controls probe: elements=18 skipped_content=1 complete=true";
  expect(installedMacSaveControlsDiagnostic(probe)).toBe(probe);
  expect(installedMacPickerDiagnostic({}, probe, 1)).toContain(probe);
  for (const line of [
    probe + " /private/path",
    probe.replace("elements=18", "elements=257"),
    probe.replace("skipped_content=1", "skipped_content=19"),
    probe.replace("complete=true", "complete=private"),
  ]) {
    expect(installedMacSaveControlsDiagnostic(line)).toBeUndefined();
  }
});

it("retains only schema-validated filename categories on native failure", () => {
  const evidence = {
    format: "json",
    total: 1,
    unreadableRoles: 0,
    truncated: false,
    fields: [
      { role: "text_field", subrole: "empty", name: "other", value: "expected", enabled: "true" },
    ],
  };
  const prefix = "Native macOS Save field evidence: ";
  const diagnostic = (value: unknown) =>
    installedMacPickerDiagnostic({}, prefix + JSON.stringify(value), 1);
  expect(diagnostic(evidence)).toContain("name=other value=expected");
  expect(diagnostic({ ...evidence, privatePath: "/private/secret" })).not.toContain(
    "Save field probe",
  );
  expect(
    diagnostic({ ...evidence, fields: [{ ...evidence.fields[0], name: "/private/secret" }] }),
  ).not.toContain("secret");
  expect(installedMacPickerDiagnostic({}, prefix + "{invalid", 1)).not.toContain(
    "Save field probe",
  );
});

it("reports only bounded initial disclosure counts on expanded preparation failure", () => {
  const line =
    "Native macOS Save initial disclosure: controls=29 disclosures=1 zero=0 one=1 unknown=0";
  expect(installedMacPickerDiagnostic({}, line, 1)).toContain(line);
  for (const invalid of [
    line + " /private/path",
    line.replace("controls=29", "controls=257"),
    line.replace("one=1", "one=2"),
    line.replace("disclosures=1", "disclosures=30"),
  ]) {
    expect(installedMacPickerDiagnostic({}, invalid, 1)).not.toContain("initial disclosure");
  }
});

it("keeps only bounded unreadable reference classifications", () => {
  const line = "Native macOS Save unreadable references: total=14 gone=14 live=0 unknown=0";
  expect(installedMacPickerDiagnostic({}, line, 1)).toContain(line);
  for (const invalid of [
    line + " /private/path",
    line.replace("total=14", "total=257"),
    line.replace("gone=14", "gone=15"),
  ]) {
    expect(installedMacPickerDiagnostic({}, invalid, 1)).not.toContain("unreadable references");
  }
});

it("retains only bounded fixed fresh-control evidence after a guard refusal", () => {
  const probe =
    "Native macOS picker fresh controls: phase=activate status=complete before_input=true elements=9 primary=1 cancel=1 os_error=none";
  const output = installedMacPickerDiagnostic(
    {},
    [
      probe,
      probe,
      `${probe} /private/path`,
      probe.replace("elements=9", "elements=258"),
      probe.replace("primary=1", "primary=18"),
      probe.replace("status=complete", "status=private"),
    ].join("\n"),
    1,
  );
  expect(output.split(probe)).toHaveLength(2);
  expect(output).not.toContain("private");
  expect(output).not.toContain("elements=258");
  expect(output).not.toContain("primary=18");
});

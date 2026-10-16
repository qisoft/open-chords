import { expect, it } from "vitest";

import { installedMacPickerDiagnostic } from "./support/installed-picker-macos-diagnostics.ts";

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

import { expect, it } from "vitest";

import { installedMacPickerDiagnostic } from "./support/installed-picker-macos-diagnostics.ts";

it.each([
  "processes",
  "windows",
  "sheets",
  "elements",
  "selection",
  "action",
  "dismissal",
  "deadline",
])("keeps only bounded macOS picker observations at %s", (stage) => {
  const probe = `Native macOS picker failure: stage=${stage} elapsed_ms=90000 processes=1 windows=2 sheets=1 elements=120 cancel=1 open=1 os_error=-1743`;
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

import { expect, it } from "vitest";

import { installedMacPickerFreshPrimary } from "./support/installed-picker-macos-diagnostics.ts";

const line =
  "Native macOS picker fresh primary: phase=activate status=complete present=1 enabled=0 disabled=1 unknown=0";
it("retains fixed disabled primary evidence without raw UI text", () => {
  expect(installedMacPickerFreshPrimary(`/private\n${line}\nprivate`)).toEqual([line]);
});
it("preserves an incomplete inventory after a read error", () => {
  const failed = line
    .replace("status=complete", "status=error")
    .replace("disabled=1", "disabled=0");
  expect(installedMacPickerFreshPrimary(failed)).toEqual([failed]);
});
it("does not fall back from an invalid last observation", () => {
  expect(
    installedMacPickerFreshPrimary(`${line}\nNative macOS picker fresh primary: private`),
  ).toEqual([]);
});
it.each([
  line + " /private",
  line.replace("phase=activate", "phase=private"),
  line.replace("status=complete", "status=private"),
  line.replace("present=1", "present=18"),
  line.replace("present=1", "present=0"),
  line.replace("enabled=0", "enabled=99"),
  line.replace("unknown=0", "unknown=private"),
])("rejects malformed or impossible evidence", (raw) => {
  expect(installedMacPickerFreshPrimary(raw)).toEqual([]);
});

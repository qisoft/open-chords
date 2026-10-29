import { expect, it } from "vitest";

import { installedMacPickerContentsFailure } from "./support/installed-picker-macos-diagnostics.ts";

const evidence =
  "Native macOS picker contents failure: status=complete sheet_exists=false window_exists=true before_input=true os_error=-1728";

it("retains fixed captured-reference evidence from the original contents refusal", () => {
  expect(installedMacPickerContentsFailure(`/private/path\n${evidence}\nprivate content`)).toEqual([
    evidence,
  ]);
});

it("does not fall back to older evidence after a malformed final observation", () => {
  for (const suffix of [" /private/path", "\nNative macOS picker contents failure: private"]) {
    expect(installedMacPickerContentsFailure(evidence + suffix)).toEqual([]);
  }
});

it("rejects private strings and invalid states in every evidence field", () => {
  for (const [from, to] of [
    ["status=complete", "status=/private"],
    ["sheet_exists=false", "sheet_exists=/private"],
    ["window_exists=true", "window_exists=/private"],
    ["before_input=true", "before_input=unknown"],
    ["os_error=-1728", "os_error=/private"],
    ["os_error=-1728", "os_error=100000"],
  ] as const) {
    expect(installedMacPickerContentsFailure(evidence.replace(from, to))).toEqual([]);
  }
});

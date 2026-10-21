import { expect, it } from "vitest";

import {
  installedMacSaveExpansionDiagnostic,
  installedMacSaveExpansionSucceeded,
  installedMacSaveExpandedReady,
  installedMacSaveCollapseSucceeded,
} from "./support/installed-macos-save-expansion.ts";

const evidence = {
  trusted: true,
  complete: true,
  foreground: true,
  guardMask: 255,
  lastError: 0,
  firstErrorAttribute: "none",
  firstErrorDurationMs: 0,
  stage: "complete",
  pressed: true,
  expanded: true,
  initialValue: 0,
  finalValue: 1,
  windows: 1,
  sheets: 1,
  visited: 10,
  unsupported: 0,
  disclosures: 1,
  saveButtons: 1,
  cancelButtons: 1,
};
it("accepts only native guarded press and observed expansion, without directory or Save claims", () => {
  const stdout = JSON.stringify(evidence);
  expect(installedMacSaveExpansionSucceeded(stdout)).toBe(true);
  expect(installedMacSaveExpansionDiagnostic(stdout, null, 1)).toContain(
    "pressed=true expanded=true initialValue=0 finalValue=1",
  );
});
it.each([
  { trusted: false },
  { complete: false },
  { foreground: false },
  { guardMask: 254 },
  { lastError: -25202 },
  { firstErrorAttribute: "AXValue" },
  { stage: "expansion" },
  { pressed: false },
  { expanded: false },
  { initialValue: 1 },
  { finalValue: 0 },
  { windows: 2 },
  { sheets: 2 },
  { disclosures: 2 },
  { saveButtons: 0 },
  { cancelButtons: 2 },
  { visited: 0 },
])("refuses incomplete/ambiguous/unexpanded evidence %j", (change) => {
  expect(installedMacSaveExpansionSucceeded(JSON.stringify({ ...evidence, ...change }))).toBe(
    false,
  );
});
it.each([
  { path: "/private/path" },
  { firstErrorAttribute: "/private/error" },
  { lastError: -32769 },
  { visited: 257 },
  { guardMask: 256 },
  { unsupported: 1000 },
  { finalValue: 2 },
  { stage: "/private/state" },
  { pressed: "true" },
])("redacts malformed/private native evidence %j", (change) => {
  const stdout = JSON.stringify({ ...evidence, ...change });
  expect(installedMacSaveExpansionSucceeded(stdout)).toBe(false);
  expect(installedMacSaveExpansionDiagnostic(stdout, null, 1)).toBe(
    "Native macOS Save expansion: invalid_evidence",
  );
});
it("rejects oversized or malformed output and never leaks native process errors", () => {
  for (const stdout of ["/private/error", "x".repeat(4097)]) {
    expect(installedMacSaveExpansionSucceeded(stdout)).toBe(false);
    expect(installedMacSaveExpansionDiagnostic(stdout, null, 1)).toBe(
      "Native macOS Save expansion: invalid_evidence",
    );
  }
  const output = installedMacSaveExpansionDiagnostic(
    "/private/output",
    { code: 1, killed: true, signal: "SIGTERM", message: "/private/command" },
    7001,
  );
  expect(output).toContain("killed=true exit_code=1 exit_signal=SIGTERM");
  expect(output).not.toContain("private");
});

it("requires a separate guarded native 1-to-0 collapse and rejects no-op/restoration failures", () => {
  const collapsed = { ...evidence, expanded: false, initialValue: 1, finalValue: 0 };
  expect(installedMacSaveCollapseSucceeded(JSON.stringify(collapsed))).toBe(true);
  expect(installedMacSaveExpansionSucceeded(JSON.stringify(collapsed))).toBe(false);
  expect(installedMacSaveCollapseSucceeded(JSON.stringify(evidence))).toBe(false);
  for (const change of [
    { initialValue: 0 },
    { finalValue: 1 },
    { pressed: false },
    { guardMask: 254 },
    { complete: false },
    { lastError: -25204 },
  ]) {
    expect(installedMacSaveCollapseSucceeded(JSON.stringify({ ...collapsed, ...change }))).toBe(
      false,
    );
  }
});

it("bounds native read timing and never forwards private duration text", () => {
  for (const firstErrorDurationMs of [-1, 1000000, 0.5, "/private/path"]) {
    const output = JSON.stringify({ ...evidence, firstErrorDurationMs });
    expect(installedMacSaveExpansionSucceeded(output)).toBe(false);
    expect(installedMacSaveExpansionDiagnostic(output, null, 1)).toBe(
      "Native macOS Save expansion: invalid_evidence",
    );
  }
});

it("accepts guarded retained expansion without toggling and keeps original transition strict", () => {
  const output = JSON.stringify({ ...evidence, pressed: false, initialValue: 1, finalValue: 1 });
  expect(installedMacSaveExpandedReady(output)).toBe(true);
  expect(installedMacSaveExpansionSucceeded(output)).toBe(false);
  expect(installedMacSaveExpandedReady(JSON.stringify(evidence))).toBe(true);
});
it.each([
  { guardMask: 254 },
  { initialValue: -1 },
  { finalValue: 0 },
  { pressed: true },
  { complete: false },
  { foreground: false },
  { lastError: -25204 },
  { disclosures: 2 },
])("rejects ambiguous or incomplete retained expansion %j", (change) => {
  expect(
    installedMacSaveExpandedReady(
      JSON.stringify({ ...evidence, pressed: false, initialValue: 1, finalValue: 1, ...change }),
    ),
  ).toBe(false);
});

import { expect, it } from "vitest";

import {
  installedMacAxProbeDiagnostic,
  installedMacAxActionSucceeded,
  MAC_AX_COUNT_FIELDS,
} from "./support/installed-picker-macos-ax-diagnostics.ts";

const evidence = {
  trusted: false,
  complete: false,
  lastError: -25211,
  dismissalLastError: 0,
  pressDurationMs: 0,
  pressSheetState: "not_checked",
  pressFollowupError: 0,
  firstOtherError: 0,
  firstOtherAttribute: "none",
  verified: false,
  foreground: false,
  guardMask: 0,
  stage: "verification",
  action: { requested: "none", pressed: false, dismissed: false },
  counts: Object.fromEntries(MAC_AX_COUNT_FIELDS.map((key) => [key, 0])),
};

it("preserves exact native AX counts and permission failures without raw data", () => {
  const output = installedMacAxProbeDiagnostic(JSON.stringify(evidence), null, 10);
  expect(output).toContain("trusted=false complete=false last_error=-25211");
  expect(output).toContain("dismissal_last_error=0");
  expect(output).toContain(
    "press_duration_ms=0 press_sheet_state=not_checked press_followup_error=0",
  );
  for (const key of MAC_AX_COUNT_FIELDS) expect(output).toContain(`${key}=0`);
});

it.each([
  { ...evidence, path: "/private/fixture" },
  { ...evidence, counts: { ...evidence.counts, url: "file:///private/fixture" } },
  { ...evidence, counts: { ...evidence.counts, visited: 1000 } },
  { ...evidence, counts: { ...evidence.counts, visited: -1 } },
  { ...evidence, counts: {} },
  { ...evidence, lastError: "/private/error" },
  { ...evidence, dismissalLastError: "/private/error" },
  { ...evidence, dismissalLastError: -32769 },
  { ...evidence, pressDurationMs: 1000000 },
  { ...evidence, pressSheetState: "/private/sheet" },
  { ...evidence, pressFollowupError: "/private/error" },
  { ...evidence, complete: "private" },
])("rejects malformed or additional native evidence", (value) => {
  expect(installedMacAxProbeDiagnostic(JSON.stringify(value), null, 1)).toBe(
    "Native macOS AX probe: invalid_evidence",
  );
});

it("rejects oversized and non-JSON output and strips process command/error text", () => {
  for (const value of ["/private/error", "x".repeat(4097)]) {
    expect(installedMacAxProbeDiagnostic(value, null, 1)).toBe(
      "Native macOS AX probe: invalid_evidence",
    );
  }
  const result = installedMacAxProbeDiagnostic(
    "file:///private/fixture",
    { code: 1, killed: true, signal: "SIGTERM", message: "/private/command" },
    5000,
  );
  expect(result).toContain("killed=true");
  expect(result).not.toContain("private");
});

it("requires exact unique selected-file evidence, guarded native press and actual dismissal", () => {
  const successful = {
    ...evidence,
    trusted: true,
    complete: true,
    lastError: 0,
    verified: true,
    foreground: true,
    guardMask: 255,
    stage: "complete",
    action: { requested: "open", pressed: true, dismissed: true },
    counts: {
      ...evidence.counts,
      selectedLeaves: 1,
      leafMatches: 1,
      selectedExactUrls: 1,
      buttons: 1,
    },
  };
  expect(installedMacAxActionSucceeded(JSON.stringify(successful), "open")).toBe(true);
  expect(
    installedMacAxActionSucceeded(
      JSON.stringify({ ...successful, dismissalLastError: -25204 }),
      "open",
    ),
  ).toBe(true);
  const refused = [
    ...["invalid_sheet", "detached_sheet", "attached_sheet", "unknown"].map((pressSheetState) => ({
      ...successful,
      lastError: -25204,
      stage: "press",
      pressDurationMs: 150,
      pressSheetState,
      action: { ...successful.action, pressed: false, dismissed: false },
    })),
    { ...successful, trusted: false },
    { ...successful, complete: false },
    { ...successful, verified: false },
    { ...successful, foreground: false },
    { ...successful, guardMask: 254 },
    { ...successful, lastError: -25200 },
    { ...successful, lastError: -25204, dismissalLastError: -25204 },
    {
      ...successful,
      stage: "dismissal",
      dismissalLastError: -25204,
      action: { ...successful.action, dismissed: false },
    },
    { ...successful, firstOtherError: -25200 },
    { ...successful, stage: "guard" },
    { ...successful, action: { ...successful.action, pressed: false } },
    { ...successful, action: { ...successful.action, dismissed: false } },
    ...["selectedLeaves", "leafMatches", "selectedExactUrls", "buttons"].map((key) => ({
      ...successful,
      counts: { ...successful.counts, [key]: 2 },
    })),
    ...["otherErrors", "cannotComplete", "apiDisabled"].map((key) => ({
      ...successful,
      counts: { ...successful.counts, [key]: 1 },
    })),
  ];
  for (const candidate of refused)
    expect(installedMacAxActionSucceeded(JSON.stringify(candidate), "open")).toBe(false);
  expect(installedMacAxActionSucceeded(JSON.stringify(successful), "cancel_open_existing")).toBe(
    false,
  );
  expect(installedMacAxActionSucceeded("/private/invalid", "open")).toBe(false);
});

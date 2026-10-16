import { expect, it } from "vitest";

import {
  installedMacAxProbeDiagnostic,
  MAC_AX_COUNT_FIELDS,
} from "./support/installed-picker-macos-ax-diagnostics.ts";

const evidence = {
  trusted: false,
  complete: false,
  lastError: -25211,
  counts: Object.fromEntries(MAC_AX_COUNT_FIELDS.map((key) => [key, 0])),
};

it("preserves exact native AX counts and permission failures without raw data", () => {
  const output = installedMacAxProbeDiagnostic(JSON.stringify(evidence), null, 10);
  expect(output).toContain("trusted=false complete=false last_error=-25211");
  for (const key of MAC_AX_COUNT_FIELDS) expect(output).toContain(`${key}=0`);
});

it.each([
  { ...evidence, path: "/private/fixture" },
  { ...evidence, counts: { ...evidence.counts, url: "file:///private/fixture" } },
  { ...evidence, counts: { ...evidence.counts, visited: 1000 } },
  { ...evidence, counts: { ...evidence.counts, visited: -1 } },
  { ...evidence, counts: {} },
  { ...evidence, lastError: "/private/error" },
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

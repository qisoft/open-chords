import { expect, it } from "vitest";

import { windowsUiaLoadDiagnostic } from "./support/installed-windows-uia-load-evidence.ts";

const evidence = {
  available: true,
  identityMatches: true,
  bytesMatch: true,
  clientMs: 22000,
  typesMs: 10,
  totalMs: 22010,
};
it("reports only bounded load timings and identity comparisons", () => {
  expect(windowsUiaLoadDiagnostic("name", JSON.stringify(evidence))).toBe(
    "Native UIAutomation load: mode=name available=true identity_matches=true bytes_match=true client_ms=22000 types_ms=10 total_ms=22010",
  );
});
it.each([
  { ...evidence, totalMs: 0 },
  { ...evidence, clientMs: -1 },
  { ...evidence, clientMs: 100001, totalMs: 100011 },
  { ...evidence, clientMs: 0.5 },
  { ...evidence, bytesMatch: "private" },
  { ...evidence, path: "C:\\private\\client.dll" },
])("rejects inconsistent, unbounded or private evidence: %j", (value) => {
  expect(() => windowsUiaLoadDiagnostic("path", JSON.stringify(value))).toThrow(
    "Native UIAutomation load evidence invalid",
  );
});
it.each(["private exception", "x".repeat(1025)])(
  "redacts malformed or excessive output",
  (stdout) => {
    expect(() => windowsUiaLoadDiagnostic("path", stdout)).toThrow(
      "Native UIAutomation load evidence invalid",
    );
  },
);

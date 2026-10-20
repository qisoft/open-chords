import { expect, it } from "vitest";

import { windowsUiaLoadDiagnostic } from "./support/installed-windows-uia-load-evidence.ts";

const evidence = {
  available: true,
  identityMatches: true,
  bytesMatch: true,
  moduleMs: 100,
  runtimeMs: 1,
  pathMs: 22000,
  availabilityMs: 2,
  verificationMs: 10,
  clientMs: 22000,
  typesMs: 10,
  totalMs: 22010,
};
it("reports only bounded load timings and identity comparisons", () => {
  expect(windowsUiaLoadDiagnostic("name", JSON.stringify(evidence), 45000)).toBe(
    "Native UIAutomation load: mode=name available=true identity_matches=true bytes_match=true client_ms=22000 types_ms=10 total_ms=22010 module_ms=100 runtime_ms=1 path_ms=22000 availability_ms=2 verification_ms=10 process_ms=45000",
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
  expect(() => windowsUiaLoadDiagnostic("path", JSON.stringify(value), 45000)).toThrow(
    "Native UIAutomation load evidence invalid",
  );
});
it.each(["private exception", "x".repeat(1025)])(
  "redacts malformed or excessive output",
  (stdout) => {
    expect(() => windowsUiaLoadDiagnostic("path", stdout, 45000)).toThrow(
      "Native UIAutomation load evidence invalid",
    );
  },
);

it.each([NaN, Infinity, -1, 1000000])("rejects invalid host process timing: %s", (processMs) => {
  expect(() => windowsUiaLoadDiagnostic("name", JSON.stringify(evidence), processMs)).toThrow(
    "Native UIAutomation load evidence invalid",
  );
});
it.each(["moduleMs", "runtimeMs", "pathMs", "availabilityMs", "verificationMs"])(
  "bounds the %s phase",
  (key) => {
    expect(() =>
      windowsUiaLoadDiagnostic("path", JSON.stringify({ ...evidence, [key]: 100001 }), 45000),
    ).toThrow("Native UIAutomation load evidence invalid");
  },
);

it("reports explicit module import cost separately from preparation and loading", () => {
  expect(windowsUiaLoadDiagnostic("modules", JSON.stringify(evidence), 45000)).toContain(
    "mode=modules",
  );
  expect(windowsUiaLoadDiagnostic("modules", JSON.stringify(evidence), 45000)).toContain(
    "module_ms=100",
  );
});

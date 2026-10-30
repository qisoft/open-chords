import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

import { expect, it } from "vitest";

const source = readFileSync("tests/support/installed-picker-macos.jxa", "utf8");
const start = source.indexOf("  function reportFreshControls(");
const end = source.indexOf("  function requireCancelTarget(", start);
const functions = source.slice(start, end);

function probe(change = "", freshFailure = false, phase: "activate" | "filename" = "activate") {
  const lines: string[] = [];
  const result: unknown = runInNewContext(
    `
    var deadline = Date.now() + 10000, primaryAction = 'Save', nativeInputStarted = false;
    var freshButton = (name) => ({ role: () => 'AXButton', name: () => name, enabled: () => true });
    var elements = [freshButton('Save'), freshButton('Cancel')];
    var fresh = { entireContents: () => { ${freshFailure ? "throw { errorNumber: -1728, message: '/private/error' };" : "return elements;"} } };
    var process = { windows: () => [{ sheets: () => [fresh] }] };
    var candidate = { capturedAt: Date.now(), sheet: { exists: () => false }, button: { exists: () => true } };
    ${functions}
    ${change}
    reportGuardSnapshot(process, candidate, '${phase}');
  `,
    { console: { log: (line: string) => lines.push(line) } },
    { timeout: 1000 },
  );
  return { result, output: lines.join("\n") };
}

it("classifies a fresh unique Save/Cancel without accepting the vanished-sheet/live-button guard", () => {
  const result = probe();
  expect(result.result).toBe(false);
  expect(result.output).toContain("sheet_exists=false button_exists=true");
  expect(result.output).toContain(
    "status=complete before_input=true elements=2 primary=1 cancel=1 os_error=none",
  );
});
it("redacts fresh read errors without changing the original guard decision", () => {
  const result = probe("", true);
  expect(result.result).toBe(false);
  expect(result.output).toContain(
    "status=error before_input=true elements=0 primary=0 cancel=0 os_error=-1728",
  );
  expect(result.output).not.toContain("private");
  expect(probe("candidate.button.exists = () => false;", true).result).toBe(true);
});
it("bounds the inventory before reading any oversized collection", () => {
  const result = probe("elements = Array(257).fill({});");
  expect(result.result).toBe(false);
  expect(result.output).toContain("status=bound before_input=true elements=257 primary=0 cancel=0");
});
it("does not treat post-input fresh evidence as pre-input", () => {
  expect(probe("nativeInputStarted = true;").output).toContain("before_input=false");
});

it("observes filename-failure references without changing stale-reference eligibility", () => {
  const result = probe("", false, "filename");
  expect(result.result).toBe(false);
  expect(result.output).toContain("phase=filename status=complete");
  expect(result.output).toContain("sheet_exists=false button_exists=true windows=1 sheets=1");
  expect(result.output).toContain("before_input=true elements=2 primary=1 cancel=1");
});

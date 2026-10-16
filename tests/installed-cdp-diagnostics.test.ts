import { expect, it } from "vitest";

import { installedCdpExceptionDiagnostic } from "./support/installed-cdp-diagnostics.ts";

it.each([
  "Error",
  "TypeError",
  "ReferenceError",
  "SyntaxError",
  "RangeError",
  "EvalError",
  "URIError",
])("retains only bounded CDP exception metadata for %s", (className) => {
  const diagnostic = installedCdpExceptionDiagnostic({
    lineNumber: 3,
    columnNumber: 42,
    url: "file:///private/fixture",
    exception: {
      className,
      description: "private content\n at private/path",
      objectId: "private-id",
    },
    stackTrace: { private: true },
  });
  expect(diagnostic).toBe(
    `Installed CDP exception: class=${className} line=3 column=42 category=unknown`,
  );
  expect(diagnostic).not.toContain("private");
});
it("classifies only exact fixed error messages without returning their stacks", () => {
  const diagnostic = installedCdpExceptionDiagnostic({
    lineNumber: -1,
    columnNumber: 1000000,
    exception: {
      className: "TypeError",
      description:
        "TypeError: Cannot read properties of null (reading 'dataset')\n at /private/file",
    },
  });
  expect(diagnostic).toBe(
    "Installed CDP exception: class=TypeError line=unknown column=unknown category=null_dataset",
  );
  for (const details of [
    null,
    {
      exception: {
        className: "private",
        description: "Error: Installed Choose recording button was unavailable /private",
      },
    },
    { lineNumber: NaN, columnNumber: "private" },
  ]) {
    expect(installedCdpExceptionDiagnostic(details)).toBe(
      "Installed CDP exception: class=unknown line=unknown column=unknown category=unknown",
    );
  }
});

it("keeps the bounded renderer readiness failure category without a stack", () => {
  expect(
    installedCdpExceptionDiagnostic({
      exception: {
        className: "Error",
        description: "Error: Installed renderer prerequisites unavailable\n at /private/file",
      },
    }),
  ).toBe(
    "Installed CDP exception: class=Error line=unknown column=unknown category=renderer_unavailable",
  );
});

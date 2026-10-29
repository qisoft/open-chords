import { expect, it } from "vitest";

import { installedExportResponseDiagnostic } from "./support/installed-export-response-diagnostic.ts";

it("retains a fixed desktop refusal code and retryability without private response details", () => {
  expect(
    installedExportResponseDiagnostic({
      response: {
        type: "desktop.error",
        code: "internal_error",
        retryable: false,
        message: "C:\\private\\output.json",
        requestId: "private-id",
      },
      private: "private content",
    }),
  ).toBe(
    "Installed native export response: type=desktop.error code=internal_error retryable=false",
  );
});

it("does not echo unknown or malformed fields", () => {
  for (const result of [
    null,
    {},
    { response: null },
    { response: "private" },
    { response: { type: "/private", code: "/private", retryable: "/private" } },
  ]) {
    expect(installedExportResponseDiagnostic(result)).toBe(
      "Installed native export response: type=unknown code=unknown retryable=unknown",
    );
  }
});

it("retains the successful response type without echoing Receipts or output locations", () => {
  expect(
    installedExportResponseDiagnostic({
      response: { type: "exports.result", receipts: [{ outputLocation: "/private" }] },
    }),
  ).toBe("Installed native export response: type=exports.result code=unknown retryable=unknown");
});

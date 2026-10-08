import { expect, it } from "vitest";

import { installedExportExitDiagnostic } from "./support/installed-export-process.ts";

it("reports only bounded process status without captured private details", () => {
  const error = {
    code: 1,
    killed: false,
    signal: null,
    message: "/private/path",
    stderr: "private token",
    stdout: "private content",
  };
  expect(installedExportExitDiagnostic(error, 123.4)).toBe(
    "Installed export process failure: duration_ms=123 killed=false exit_code=1 exit_signal=none",
  );
  expect(
    installedExportExitDiagnostic({ code: "private", signal: "private", killed: true }, 120001),
  ).toBe(
    "Installed export process failure: duration_ms=120001 killed=true exit_code=none exit_signal=none",
  );
  expect(installedExportExitDiagnostic({ signal: "SIGTERM", killed: true }, 120100)).toContain(
    "killed=true exit_code=none exit_signal=SIGTERM",
  );
});

import { expect, it } from "vitest";

import {
  installedExportExitDiagnostic,
  runInstalledExportProcess,
} from "./support/installed-export-process.ts";

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

it("redacts the actual child-process rejection while retaining fixed proof stages", async () => {
  let failure: unknown;
  try {
    await runInstalledExportProcess(
      process.execPath,
      [
        "-e",
        `
      process.stderr.write("/private/provider-token\\n");
      process.stderr.write("Export disk proof stage: retry_saving duration_ms=123\\n");
      process.stderr.write("Export disk proof stage: private-content duration_ms=123\\n");
      process.stdout.write("private stdout");
      process.exit(7);
    `,
      ],
      {},
    );
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  if (!(failure instanceof Error)) throw new Error("fixture_child_did_not_fail");
  expect(failure.message).toContain("exit_code=7");
  expect(failure.message).toContain("retry_saving duration_ms=123");
  for (const forbidden of [
    process.execPath,
    "/private",
    "provider-token",
    "private-content",
    "private stdout",
  ]) {
    expect(failure.message).not.toContain(forbidden);
  }
  expect(Object.hasOwn(failure, "cause")).toBe(false);
  expect(Object.hasOwn(failure, "stderr")).toBe(false);
});

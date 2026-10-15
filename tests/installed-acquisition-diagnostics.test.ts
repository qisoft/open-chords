import { expect, it } from "vitest";

import {
  installedAcquisitionFailureDiagnostic,
  runInstalledAcquisitionProcess,
} from "./support/installed-acquisition-process.ts";

it("keeps bounded exact acquisition stages and numeric status without private output", () => {
  const diagnostic = installedAcquisitionFailureDiagnostic(
    {
      code: "PRIVATE",
      signal: "PRIVATE",
      killed: true,
      stderr:
        "private path\nAcquisition proof stage: jobs_invalid_media duration_ms=123\nAcquisition proof stage: private\nNative destroy phase: revoke\nNative destroy revoke probe: ancestor=5 step=security_write\nNative destroy revoke probe: ancestor=6 step=private\n",
      stdout: "private stdout",
      message: "private command",
    },
    450001,
  );
  expect(diagnostic).toBe(
    "Installed acquisition process failure: duration_ms=450001 killed=true exit_code=none exit_signal=none\nAcquisition proof stage: jobs_invalid_media duration_ms=123\nNative destroy phase: revoke\nNative destroy revoke probe: ancestor=5 step=security_write",
  );
  expect(
    installedAcquisitionFailureDiagnostic(
      { stderr: "Acquisition proof stage: jobs\n" + "x".repeat(65536) },
      1,
    ),
  ).not.toContain("Acquisition proof stage");
});

it("redacts the actual child rejection without retaining its cause", async () => {
  let failure: unknown;
  try {
    await runInstalledAcquisitionProcess(
      process.execPath,
      [
        "-e",
        `process.stderr.write("private token\\nAcquisition proof stage: jobs_closing duration_ms=123\\n"); process.stdout.write("private output"); process.exit(7);`,
      ],
      {},
      5000,
    );
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  if (!(failure instanceof Error)) throw new Error("fixture_child_did_not_fail");
  expect(failure.message).toContain("exit_code=7");
  expect(failure.message).toContain("Acquisition proof stage: jobs_closing duration_ms=123");
  expect(failure.message).not.toContain("private");
  expect(failure.cause).toBeUndefined();
});

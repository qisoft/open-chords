import { expect, it } from "vitest";

import { projectionProofFailureCode } from "../apps/desktop/src/main/packaged-projection-proof-diagnostic.ts";
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
      process.stderr.write("Export projection proof stage: save_archive\\n");
      process.stderr.write("Archive proof stage: import_started\\n");
      process.stderr.write("Archive proof stage: rejecting_hash\\n");
      process.stderr.write("Archive proof stage: /private/archive\\n");
      process.stderr.write("Packaged archive proof failure: code=archive_proof_import_failed\\n");
      process.stderr.write("Packaged export proof failure: code=EPERM\\n");
      process.stderr.write("Packaged archive proof failure: code=/private/exception\\n");
      process.stderr.write("Export disk proof source delta: added=1 removed=0 changed=2 library=1 location=0 network=0 export_pending=0 chromium_preferences=1 chromium_storage=0 chromium_cache=1 other=0\\n");
      process.stderr.write("Export disk proof source delta: added=1 removed=0 changed=2 library=1 location=0 network=0 export_pending=0 chromium_preferences=1 chromium_storage=0 chromium_cache=1 other=0 /private/delta\\n");
      process.stderr.write("Export disk proof source delta: added=10000 removed=0 changed=2 library=1 location=0 network=0 export_pending=0 chromium_preferences=1 chromium_storage=0 chromium_cache=1 other=0\\n");
      process.stderr.write("Export disk proof stage: retry_saving duration_ms=123\\n");
      process.stderr.write("Export disk proof stage: private-content duration_ms=123\\n");
      process.stderr.write("Export recovery proof stage: published_pending duration_ms=456\\n");
      process.stderr.write("Export recovery proof stage: private-content duration_ms=456\\n");
      process.stderr.write("Export recovery proof stage: refused_changed_output duration_ms=789\\n");
      process.stderr.write("Export recovery proof stage: replay_journal_written duration_ms=800\\n");
      process.stderr.write("Export recovery proof stage: replay_verification_refused duration_ms=900\\n");
      process.stderr.write("Export recovery proof stage: replay_private_path duration_ms=900\\n");
      process.stderr.write("Export disk proof stage: retry_check_source_tree_refused duration_ms=910\\n");
      process.stderr.write("Export disk proof failure: code=export_disk_proof_retry_not_durable duration_ms=911\\n");
      process.stderr.write("Export disk proof failure: code=/private/error duration_ms=912\\n");
      process.stderr.write("Export recovery proof stage: replay_check_receipt_refused duration_ms=913\\n");
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
  expect(failure.message).toContain("Export projection proof stage: save_archive");
  expect(failure.message).toContain("Archive proof stage: import_started");
  expect(failure.message).toContain("Archive proof stage: rejecting_hash");
  expect(failure.message).toContain(
    "Packaged archive proof failure: code=archive_proof_import_failed",
  );
  expect(failure.message).toContain("Packaged export proof failure: code=EPERM");
  expect(failure.message).toContain("retry_saving duration_ms=123");
  expect(failure.message).toContain("published_pending duration_ms=456");
  expect(failure.message).toContain("refused_changed_output duration_ms=789");
  expect(failure.message).toContain("replay_journal_written duration_ms=800");
  expect(failure.message).toContain("replay_verification_refused duration_ms=900");
  expect(failure.message).toContain(
    "Export disk proof source delta: added=1 removed=0 changed=2 library=1 location=0 network=0 export_pending=0 chromium_preferences=1 chromium_storage=0 chromium_cache=1 other=0",
  );
  expect(failure.message).not.toContain("/private/delta");
  expect(failure.message).not.toContain("added=10000");
  expect(failure.message).toContain("retry_check_source_tree_refused duration_ms=910");
  expect(failure.message).toContain("code=export_disk_proof_retry_not_durable duration_ms=911");
  expect(failure.message).toContain("replay_check_receipt_refused duration_ms=913");
  for (const forbidden of [
    process.execPath,
    "/private",
    "provider-token",
    "private-content",
    "private stdout",
    "replay_private_path",
  ]) {
    expect(failure.message).not.toContain(forbidden);
  }
  expect(Object.hasOwn(failure, "cause")).toBe(false);
  expect(Object.hasOwn(failure, "stderr")).toBe(false);
});

it("classifies only exact synthetic proof and filesystem failure codes", () => {
  expect(projectionProofFailureCode(new Error("archive_proof_import_failed"))).toBe(
    "archive_proof_import_failed",
  );
  expect(
    projectionProofFailureCode(Object.assign(new Error("private file"), { code: "EPERM" })),
  ).toBe("EPERM");
  for (const cause of [
    new Error("/private/file"),
    new Error("archive_proof_import_failed /private"),
    { code: "/private" },
    null,
  ]) {
    expect(projectionProofFailureCode(cause)).toBe("unknown");
  }
});

it("retains all nested export failure stages and rejects private or unrecognized additions", async () => {
  const stages = [
    "rejected_stale_revision",
    "rejected_protected_target",
    "rejected_directory_target",
    "rejected_missing_parent",
    "cancelled_existing_target_unchanged",
  ];
  let failure: unknown;
  try {
    await runInstalledExportProcess(
      process.execPath,
      [
        "-e",
        `
      for (const stage of ${JSON.stringify(stages)}) {
        process.stderr.write('Export proof stage: ' + stage + '\\n');
        process.stderr.write('Export proof stage: ' + stage + ' /private/token\\n');
      }
      process.stderr.write('Export proof stage: rejected_private_case\\n');
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
  for (const stage of stages) expect(failure.message).toContain(`Export proof stage: ${stage}`);
  expect(failure.message).not.toContain("/private");
  expect(failure.message).not.toContain("private_case");
});

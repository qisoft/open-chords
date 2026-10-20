import { execFile as runNativeFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

import { expect } from "@playwright/test";
import { z } from "zod";

import {
  installedMacSaveExpansionDiagnostic,
  installedMacSaveExpansionSucceeded,
  installedMacSaveCollapseSucceeded,
} from "./installed-macos-save-expansion.ts";
import {
  installedMacSaveFieldDiagnostic,
  installedMacSaveResultVerified,
  installedMacSaveDirectoryPreparationVerified,
  type MacSaveFormat,
} from "./installed-macos-save-field-probe.ts";
import {
  installedMacAxActionSucceeded,
  installedMacAxSnapshotRefreshAllowed,
  installedMacSelectedDirectoryVerified,
  installedMacAxProbeDiagnostic,
} from "./installed-picker-macos-ax-diagnostics.ts";
import {
  installedMacPickerDiagnostic,
  installedMacPickerRefreshDiagnostic,
  installedMacSaveControlsDiagnostic,
} from "./installed-picker-macos-diagnostics.ts";

const executeNativeFile = promisify(runNativeFile);

export function installedMacPickerDriver(
  scenario:
    | "cancel"
    | "cancel_save"
    | "cancel_save_edited"
    | "cancel_save_edited_expanded"
    | "cancel_save_restored"
    | "cancel_save_directory"
    | "cancel_save_directory_expanded"
    | "open"
    | "cancel_open_existing",
  selectedPath: string | undefined,
  environment: () => NodeJS.ProcessEnv,
  saveFormat?: MacSaveFormat,
  budgetMs = 100000,
) {
  return async (applicationPid: number) => {
    if (!Number.isFinite(budgetMs) || budgetMs <= 0 || budgetMs > 100000)
      throw new Error("Native macOS picker driver budget unavailable");
    const started = performance.now();
    const remainingBudget = () => {
      const remaining = Math.floor(budgetMs - (performance.now() - started));
      if (remaining <= 0) throw new Error("Native macOS picker driver deadline exceeded");
      return remaining;
    };
    const directoryScenario =
      scenario === "cancel_save_directory" || scenario === "cancel_save_directory_expanded";
    const saves =
      scenario === "cancel_save" ||
      scenario === "cancel_save_edited" ||
      scenario === "cancel_save_edited_expanded" ||
      scenario === "cancel_save_restored" ||
      directoryScenario;
    let stdout: string;
    let nativeStderr = "";
    try {
      ({ stdout, stderr: nativeStderr } = await executeNativeFile(
        "/usr/bin/osascript",
        [
          "-l",
          "JavaScript",
          join(process.cwd(), "tests/support/installed-picker-macos.jxa"),
          String(applicationPid),
          scenario === "cancel_save_directory_expanded"
            ? "prepare_save_directory_expanded"
            : directoryScenario
              ? "prepare_save_directory"
              : scenario,
          ...(saves
            ? [saveFormat ?? "", ...(directoryScenario ? [selectedPath ?? ""] : [])]
            : selectedPath === undefined
              ? []
              : [selectedPath]),
        ],
        { env: environment(), timeout: remainingBudget(), maxBuffer: 65536 },
      ));
    } catch (error) {
      const stderr =
        typeof error === "object" &&
        error !== null &&
        "stderr" in error &&
        typeof error.stderr === "string"
          ? error.stderr
          : "";
      // Raw exec errors contain private paths/output; retaining cause defeats redaction.
      // eslint-disable-next-line preserve-caught-error
      throw new Error(installedMacPickerDiagnostic(error, stderr, performance.now() - started));
    }
    const refresh = installedMacPickerRefreshDiagnostic(nativeStderr);
    if (refresh) process.stdout.write(`${refresh}\n`);
    const controls = installedMacSaveControlsDiagnostic(nativeStderr);
    if (controls) process.stdout.write(`${controls}\n`);
    let prepared: unknown;
    try {
      prepared = JSON.parse(stdout.trim());
    } catch {
      throw new Error("Native macOS picker returned invalid preparation evidence");
    }

    const readNativeAx = async (
      requested?: "open" | "cancel_open_existing" | "directory_snapshot",
    ) => {
      if (selectedPath === undefined) throw new Error("Native macOS picker target unavailable");
      const phaseStarted = performance.now();
      for (let attempt = 0; attempt < 2; attempt++) {
        const probeBudget = Math.floor(
          Math.min(7000 - (performance.now() - phaseStarted), remainingBudget()),
        );
        if (probeBudget <= 0) throw new Error("Native macOS AX probe deadline exceeded");
        const probeStarted = performance.now();
        let output: string;
        try {
          ({ stdout: output } = await executeNativeFile(
            join(process.cwd(), "build/test-support/macos-picker-ax-probe"),
            [
              String(applicationPid),
              selectedPath,
              ...(requested === undefined ? [] : [requested]),
              ...(requested === "directory_snapshot" ? [saveFormat ?? ""] : []),
            ],
            { env: environment(), timeout: probeBudget, maxBuffer: 4096 },
          ));
        } catch (error) {
          // Raw exec errors contain private paths/output; retaining cause defeats redaction.
          // eslint-disable-next-line preserve-caught-error
          throw new Error(
            installedMacAxProbeDiagnostic("", error, performance.now() - probeStarted),
          );
        }
        const diagnostic = installedMacAxProbeDiagnostic(
          output,
          null,
          performance.now() - probeStarted,
        );
        const refused =
          diagnostic === "Native macOS AX probe: invalid_evidence" ||
          (requested === "directory_snapshot"
            ? !installedMacSelectedDirectoryVerified(output)
            : requested !== undefined && !installedMacAxActionSucceeded(output, requested));
        if (!refused) return diagnostic;
        if (
          attempt === 0 &&
          (requested === "open" || requested === "cancel_open_existing") &&
          installedMacAxSnapshotRefreshAllowed(output, requested)
        ) {
          process.stdout.write("Native macOS AX snapshot refresh: attempt=1 before_action=true\n");
          continue;
        }
        throw new Error(diagnostic);
      }
      throw new Error("Native macOS AX probe unavailable");
    };

    let evidence: unknown;
    if (directoryScenario) {
      if (
        saveFormat === undefined ||
        !installedMacSaveDirectoryPreparationVerified(prepared, saveFormat)
      )
        throw new Error("Native macOS Save directory preparation unavailable");
      process.stdout.write("Native macOS Save directory preparation: verified=true\n");
      if (scenario === "cancel_save_directory_expanded") {
        const expansionStarted = performance.now();
        let expansion: string;
        try {
          ({ stdout: expansion } = await executeNativeFile(
            join(process.cwd(), "build/test-support/macos-save-expand"),
            [String(applicationPid)],
            { env: environment(), timeout: Math.min(7000, remainingBudget()), maxBuffer: 4096 },
          ));
        } catch (error) {
          // Raw native errors expose private command/output; retain only fixed diagnostics.
          // eslint-disable-next-line preserve-caught-error
          throw new Error(
            installedMacSaveExpansionDiagnostic("", error, performance.now() - expansionStarted),
          );
        }
        const diagnostic = installedMacSaveExpansionDiagnostic(
          expansion,
          null,
          performance.now() - expansionStarted,
        );
        if (!installedMacSaveExpansionSucceeded(expansion)) throw new Error(diagnostic);
        process.stdout.write(`${diagnostic}\n`);
      }
      // Read-only observations do not authorize Save or imply a verified directory.
      process.stdout.write(`Native macOS Save directory snapshot: ${await readNativeAx()}\n`);
      if (scenario === "cancel_save_directory_expanded") {
        process.stdout.write(
          `Native macOS selected directory verification: ${await readNativeAx("directory_snapshot")}\n`,
        );
        const collapseStarted = performance.now();
        let collapse: string;
        try {
          ({ stdout: collapse } = await executeNativeFile(
            join(process.cwd(), "build/test-support/macos-save-expand"),
            [String(applicationPid), "--collapse"],
            { env: environment(), timeout: Math.min(7000, remainingBudget()), maxBuffer: 4096 },
          ));
        } catch (error) {
          // Raw native errors expose private command/output; retain fixed evidence only.
          // eslint-disable-next-line preserve-caught-error
          throw new Error(
            installedMacSaveExpansionDiagnostic("", error, performance.now() - collapseStarted),
          );
        }
        const diagnostic = installedMacSaveExpansionDiagnostic(
          collapse,
          null,
          performance.now() - collapseStarted,
        );
        if (!installedMacSaveCollapseSucceeded(collapse)) throw new Error(diagnostic);
        process.stdout.write(`${diagnostic}\n`);
      }
      await installedMacPickerDriver(
        scenario === "cancel_save_directory_expanded"
          ? "cancel_save_restored"
          : "cancel_save_edited",
        undefined,
        environment,
        saveFormat,
        remainingBudget(),
      )(applicationPid);
      evidence = { action: scenario, nativePress: true, dialogDismissed: true };
    } else if (saves) {
      if (
        saveFormat === undefined ||
        !installedMacSaveResultVerified(prepared, saveFormat, scenario)
      )
        throw new Error("Native macOS picker returned invalid preparation evidence");
      process.stdout.write(
        `${installedMacSaveFieldDiagnostic(prepared.saveFieldProbe, saveFormat)}\n`,
      );
      process.stdout.write(
        `Native macOS Save filename: format=${saveFormat} default_verified=true input_verified=${scenario !== "cancel_save"} directory_navigation_verified=false\n`,
      );
      evidence = { action: scenario, nativePress: true, dialogDismissed: true };
    } else if (scenario === "cancel") {
      evidence = prepared;
    } else {
      const preparation = z.strictObject({
        prepared: z.literal(true),
        nativePress: z.literal(false),
        navigationDismissed: z.literal(true),
      });
      if (!preparation.safeParse(prepared).success)
        throw new Error("Native macOS picker returned invalid preparation evidence");
      await readNativeAx(scenario);
      evidence = { action: scenario, filenameSet: true, nativePress: true, dialogDismissed: true };
    }
    expect(evidence).toEqual(
      scenario === "cancel" || saves
        ? { action: scenario, nativePress: true, dialogDismissed: true }
        : { action: scenario, filenameSet: true, nativePress: true, dialogDismissed: true },
    );
  };
}

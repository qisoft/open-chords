import { execFile as runNativeFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

import { expect } from "@playwright/test";
import { z } from "zod";

import {
  installedMacSaveExpansionDiagnostic,
  installedMacSaveExpansionSucceeded,
  installedMacSaveExpandedReady,
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
  installedMacSaveFilenameVerified,
  installedMacJsonSaveSucceeded,
  installedMacTextSaveSucceeded,
  installedMacPdfSaveSucceeded,
  installedMacArchiveSaveSucceeded,
  installedMacReplaceContextObserved,
  installedMacReplacementCancelled,
  installedMacJsonReplacementConfirmed,
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
    | "observe_replace_json"
    | "cancel_replace_json"
    | "replace_json"
    | "save_json"
    | "save_lrc"
    | "save_chordpro"
    | "save_pdf"
    | "save_archive"
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
    const textSave = scenario === "save_lrc" || scenario === "save_chordpro";
    const pdfSave = scenario === "save_pdf";
    const archiveSave = scenario === "save_archive";
    const cancelReplace = scenario === "cancel_replace_json";
    const replaceJson = scenario === "replace_json";
    const observeReplace = scenario === "observe_replace_json" || cancelReplace || replaceJson;
    const nativeSave =
      scenario === "save_json" || textSave || pdfSave || archiveSave || observeReplace;
    const expandedDirectory = scenario === "cancel_save_directory_expanded" || nativeSave;
    if (textSave && (saveFormat !== scenario.slice(5) || selectedPath === undefined))
      throw new Error("Native macOS text Save target unavailable");
    if (
      (scenario === "save_json" || observeReplace) &&
      (saveFormat !== "json" || selectedPath === undefined)
    )
      throw new Error("Native macOS JSON Save target unavailable");
    if (pdfSave && (saveFormat !== "pdf" || selectedPath === undefined))
      throw new Error("Native macOS PDF Save target unavailable");
    if (archiveSave && (saveFormat !== "archive" || selectedPath === undefined))
      throw new Error("Native macOS archive Save target unavailable");
    const directoryScenario = scenario === "cancel_save_directory" || expandedDirectory;
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
          nativeSave
            ? "prepare_save_directory_retained"
            : expandedDirectory
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
      verifyFilename = false,
      saveExport = false,
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
              ...(saveExport
                ? [
                    replaceJson
                      ? "--replace-json"
                      : cancelReplace
                        ? "--cancel-replace-json"
                        : observeReplace
                          ? "--observe-replace-json"
                          : archiveSave
                            ? "--save-new-archive"
                            : pdfSave
                              ? "--save-new-pdf"
                              : textSave
                                ? "--save-new-text"
                                : "--save-new-json",
                  ]
                : verifyFilename
                  ? ["--verify-filename"]
                  : []),
            ],
            {
              env: environment(),
              timeout: probeBudget,
              maxBuffer: observeReplace && saveExport ? 8192 : 4096,
            },
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
          (saveExport
            ? !(replaceJson
                ? installedMacJsonReplacementConfirmed(output)
                : cancelReplace
                  ? installedMacReplacementCancelled(output)
                  : observeReplace
                    ? installedMacReplaceContextObserved(output)
                    : textSave
                      ? installedMacTextSaveSucceeded(
                          output,
                          scenario === "save_lrc" ? "lrc" : "chordpro",
                        )
                      : pdfSave
                        ? installedMacPdfSaveSucceeded(output)
                        : archiveSave
                          ? installedMacArchiveSaveSucceeded(output)
                          : installedMacJsonSaveSucceeded(output))
            : requested === "directory_snapshot"
              ? !(verifyFilename
                  ? installedMacSaveFilenameVerified(output)
                  : installedMacSelectedDirectoryVerified(output))
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
      if (expandedDirectory) {
        const expansionStarted = performance.now();
        let expansion: string;
        try {
          ({ stdout: expansion } = await executeNativeFile(
            join(process.cwd(), "build/test-support/macos-save-expand"),
            [String(applicationPid), ...(nativeSave ? ["--ensure-expanded"] : [])],
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
        if (
          !(nativeSave
            ? installedMacSaveExpandedReady(expansion)
            : installedMacSaveExpansionSucceeded(expansion))
        )
          throw new Error(diagnostic);
        process.stdout.write(`${diagnostic}\n`);
      }
      // Read-only observations do not authorize Save or imply a verified directory.
      process.stdout.write(`Native macOS Save directory snapshot: ${await readNativeAx()}\n`);
      if (expandedDirectory) {
        process.stdout.write(
          `Native macOS selected directory verification: ${await readNativeAx("directory_snapshot")}\n`,
        );
        process.stdout.write(
          `Native macOS Save filename verification: ${await readNativeAx("directory_snapshot", true)}\n`,
        );
        if (nativeSave) {
          process.stdout.write(
            `Native macOS ${saveFormat} ${replaceJson ? "replacement Replace" : cancelReplace ? "replacement Cancel" : observeReplace ? "replacement context" : "Save"}: ${await readNativeAx("directory_snapshot", false, true)}\n`,
          );
        } else {
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
      }
      if (!nativeSave)
        await installedMacPickerDriver(
          expandedDirectory ? "cancel_save_restored" : "cancel_save_edited",
          undefined,
          environment,
          saveFormat,
          remainingBudget(),
        )(applicationPid);
      evidence = {
        action: scenario,
        nativePress: true,
        dialogDismissed: replaceJson || !observeReplace,
      };
    } else if (saves) {
      if (
        scenario !== "cancel_save" &&
        scenario !== "cancel_save_edited" &&
        scenario !== "cancel_save_edited_expanded" &&
        scenario !== "cancel_save_restored"
      )
        throw new Error("Native macOS Save preparation scenario unavailable");
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
        ? { action: scenario, nativePress: true, dialogDismissed: replaceJson || !observeReplace }
        : { action: scenario, filenameSet: true, nativePress: true, dialogDismissed: true },
    );
  };
}

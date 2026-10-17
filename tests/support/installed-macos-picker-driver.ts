import { execFile as runNativeFile } from "node:child_process";
import { join } from "node:path";

import { expect } from "@playwright/test";
import { z } from "zod";

import {
  installedMacSaveFieldDiagnostic,
  installedMacSaveResultVerified,
  type MacSaveFormat,
} from "./installed-macos-save-field-probe.ts";
import {
  installedMacAxActionSucceeded,
  installedMacAxProbeDiagnostic,
} from "./installed-picker-macos-ax-diagnostics.ts";
import { installedMacPickerDiagnostic } from "./installed-picker-macos-diagnostics.ts";

export function installedMacPickerDriver(
  scenario: "cancel" | "cancel_save" | "cancel_save_edited" | "open" | "cancel_open_existing",
  selectedPath: string | undefined,
  environment: () => NodeJS.ProcessEnv,
  saveFormat?: MacSaveFormat,
) {
  return async (applicationPid: number) => {
    const saves = scenario === "cancel_save" || scenario === "cancel_save_edited";
    const started = performance.now();
    const evidence = await new Promise<unknown>((resolve, reject) => {
      runNativeFile(
        "/usr/bin/osascript",
        [
          "-l",
          "JavaScript",
          join(process.cwd(), "tests/support/installed-picker-macos.jxa"),
          String(applicationPid),
          scenario,
          ...(saves ? [saveFormat ?? ""] : selectedPath === undefined ? [] : [selectedPath]),
        ],
        { env: environment(), timeout: 100000, maxBuffer: 65536 },
        (error, stdout, stderr) => {
          if (error) {
            reject(
              new Error(installedMacPickerDiagnostic(error, stderr, performance.now() - started)),
            );
            return;
          }
          try {
            const prepared: unknown = JSON.parse(stdout.trim());
            if (saves) {
              if (
                saveFormat === undefined ||
                !installedMacSaveResultVerified(prepared, saveFormat, scenario)
              )
                throw new Error("Save filename verification unavailable");
              const save = prepared;
              const diagnostic = installedMacSaveFieldDiagnostic(save.saveFieldProbe, saveFormat);
              process.stdout.write(`${diagnostic}\n`);
              process.stdout.write(
                `Native macOS Save filename: format=${saveFormat} default_verified=true input_verified=${scenario === "cancel_save_edited"}\n`,
              );
              resolve({ action: scenario, nativePress: true, dialogDismissed: true });
              return;
            }
            if (scenario === "cancel") {
              resolve(prepared);
              return;
            }
            z.strictObject({
              prepared: z.literal(true),
              nativePress: z.literal(false),
              navigationDismissed: z.literal(true),
            }).parse(prepared);
          } catch {
            reject(new Error("Native macOS picker returned invalid preparation evidence"));
            return;
          }
          if (selectedPath === undefined) {
            reject(new Error("Native macOS picker target unavailable"));
            return;
          }
          const remaining = Math.floor(100000 - (performance.now() - started));
          if (remaining <= 0) {
            reject(new Error("Native macOS picker driver deadline exceeded"));
            return;
          }
          const verifierStarted = performance.now();
          runNativeFile(
            join(process.cwd(), "build/test-support/macos-picker-ax-probe"),
            [String(applicationPid), selectedPath, scenario],
            {
              env: environment(),
              timeout: Math.min(7000, remaining),
              maxBuffer: 4096,
            },
            (verifierError, verifierOutput) => {
              if (verifierError || !installedMacAxActionSucceeded(verifierOutput, scenario)) {
                reject(
                  new Error(
                    installedMacAxProbeDiagnostic(
                      verifierOutput,
                      verifierError,
                      performance.now() - verifierStarted,
                    ),
                  ),
                );
                return;
              }
              resolve({
                action: scenario,
                filenameSet: true,
                nativePress: true,
                dialogDismissed: true,
              });
            },
          );
        },
      );
    });
    expect(evidence).toEqual(
      scenario === "cancel" || saves
        ? { action: scenario, nativePress: true, dialogDismissed: true }
        : { action: scenario, filenameSet: true, nativePress: true, dialogDismissed: true },
    );
  };
}

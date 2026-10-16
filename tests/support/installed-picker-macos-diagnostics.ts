import { installedExportExitDiagnostic } from "./installed-export-process.ts";

export function installedMacPickerDiagnostic(error: unknown, stderr: string, durationMs: number) {
  const probes = stderr
    .slice(-65536)
    .split(/\r?\n/u)
    .filter((line) =>
      /^Native macOS picker failure: stage=(?:processes|windows|sheets|elements|selection|action|dismissal|deadline) elapsed_ms=[0-9]{1,6} processes=[0-9]{1,2} windows=[0-9]{1,2} sheets=[0-9]{1,2} elements=[0-9]{1,3} cancel=[0-9]{1,3} open=[0-9]{1,3} os_error=(?:unknown|-?[0-9]{1,5})$/u.test(
        line,
      ),
    )
    .slice(-1);
  return [
    installedExportExitDiagnostic(error, durationMs).replace(
      "Installed export process",
      "Native macOS picker",
    ),
    ...probes,
  ].join("\n");
}

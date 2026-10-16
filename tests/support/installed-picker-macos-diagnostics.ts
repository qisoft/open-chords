import { installedExportExitDiagnostic } from "./installed-export-process.ts";

export function installedMacPickerDiagnostic(error: unknown, stderr: string, durationMs: number) {
  const probes = stderr
    .slice(-65536)
    .split(/\r?\n/u)
    .filter((line) =>
      /^Native macOS picker failure: stage=(?:processes|windows|sheets|elements|selection|navigation|path_entry|navigation_dismissal|selected_file|action|dismissal|deadline) elapsed_ms=[0-9]{1,6} processes=[0-9]{1,2} windows=[0-9]{1,2} sheets=[0-9]{1,2} elements=[0-9]{1,3} cancel=[0-9]{1,3} open=[0-9]{1,3} navigation_sheets=[0-9]{1,2} path_fields=[0-9]{1,3} selected_rows=[0-9]{1,3} selected_urls=[0-9]{1,3} selected_matches=[0-9]{1,3} os_error=(?:unknown|-?[0-9]{1,5})$/u.test(
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

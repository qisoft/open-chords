import { installedExportExitDiagnostic } from "./installed-export-process.ts";

export function installedSaveDriverDiagnostic(error: unknown, stderr: string, durationMs: number) {
  const spawnCode =
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    ["ENOENT", "EACCES", "EPERM", "ENOEXEC", "EINVAL"].includes(error.code)
      ? error.code
      : "none";
  const output = stderr.slice(0, 16384);
  const category = /\bPSSecurityException\b/.test(output)
    ? "powershell_policy"
    : /\bParserError\b/.test(output)
      ? "powershell_parser"
      : "unknown";
  const started = output.split(/\r?\n/).includes("Native Save driver stage: started");
  const counters = output
    .split(/\r?\n/)
    .find((line) =>
      /^native_save_failed stage=(?:setup|discovery|default_filename|filename_set|native_input) windows=[0-9]{1,9} elements=[0-9]{1,9} filenames=[0-9]{1,9} actions=[0-9]{1,9}$/.test(
        line,
      ),
    );
  return [
    installedExportExitDiagnostic(error, durationMs).replace(
      "Installed export process",
      "Native Save driver",
    ),
    `Native Save driver failure: started=${started} category=${category} spawn_code=${spawnCode}`,
    ...(counters ? [counters] : []),
  ].join("\n");
}

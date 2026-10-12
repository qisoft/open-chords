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
  const output = stderr.slice(-65536);
  const category = /\bPSSecurityException\b/.test(output)
    ? "powershell_policy"
    : /\bParserError\b/.test(output)
      ? "powershell_parser"
      : "unknown";
  const started = output.split(/\r?\n/).includes("Native Save driver stage: started");
  const probes = output
    .split(/\r?\n/)
    .filter((line) =>
      /^Native Save driver probe: (?:assemblies|compile|root|ready|windows_query|windows_read|window_properties|elements_query|controls_query|controls_read|pattern|value_read|value_set|native_input|action_clicked) duration_ms=[0-9]{1,9} windows=[0-9]{1,9} elements=[0-9]{1,9} filenames=[0-9]{1,9} actions=[0-9]{1,9}$/.test(
        line,
      ),
    )
    .slice(-16);
  const counters = output
    .split(/\r?\n/)
    .find((line) =>
      /^native_save_failed stage=(?:setup|discovery|default_filename|filename_set|native_input) windows=[0-9]{1,9} elements=[0-9]{1,9} filenames=[0-9]{1,9} actions=[0-9]{1,9}$/.test(
        line,
      ),
    );
  const windowProbes = output
    .split(/\r?\n/)
    .filter((line) =>
      /^Native Save window probe: owned=[0-9]{1,3} expected_titles=[0-9]{1,3} save_as_titles=[0-9]{1,3} dialogs=[0-9]{1,3} truncated=(?:true|false)$/.test(
        line,
      ),
    )
    .slice(-3);
  const controlProbes = output
    .split(/\r?\n/)
    .filter((line) =>
      /^Native Save control probe: edits=[0-9]{1,3} buttons=[0-9]{1,3} file_labels=[0-9]{1,3} action_labels=[0-9]{1,3} visible_enabled=[0-9]{1,3} eligible_file_labels=[0-9]{1,3} value_pattern_file_labels=[0-9]{1,3} readonly_file_labels=[0-9]{1,3} writable_file_descendants=[0-9]{1,3} writable_labeled_files=[0-9]{1,3} eligible_action_labels=[0-9]{1,3}$/.test(
        line,
      ),
    )
    .slice(-3);
  const candidates = output
    .split(/\r?\n/)
    .filter((line) =>
      /^Native Save candidate probe: type=[0-9]{1,6} id=(?:[0-9]{1,6}|FileNameControlHost|FileNameControl|none) name=(?:filename|filename_plain|default|empty|other) value=(?:unsupported|default|empty|other) readonly=(?:true|false|none) eligible=(?:true|false)$/.test(
        line,
      ),
    )
    .slice(0, 64);
  const children = output
    .split(/\r?\n/)
    .filter(
      (line) =>
        /^Native Save child probe: id=(?:-1|[0-9]{1,6}) class=(?:edit|combo|static|other) text=(?:default|empty|other|unavailable) eligible=(?:true|false)$/.test(
          line,
        ) || /^Native Save child scan: visited=[0-9]{1,3} truncated=(?:true|false)$/.test(line),
    )
    .slice(0, 129);
  return [
    installedExportExitDiagnostic(error, durationMs).replace(
      "Installed export process",
      "Native Save driver",
    ),
    `Native Save driver failure: started=${started} category=${category} spawn_code=${spawnCode}`,
    ...probes,
    ...windowProbes,
    ...controlProbes,
    ...candidates,
    ...children,
    ...(counters ? [counters] : []),
  ].join("\n");
}

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
      /^native_save_failed code=(?:unknown|filename_unavailable|filename_pattern_unavailable|filename_ambiguous|default_filename_invalid|filename_readonly|filename_not_set|action_ambiguous|target_missing|action_bounds|deadline|window_bound|element_bound|filename_dialog_unavailable|filename_scan_ambiguous|input_refused|input_not_delivered|filename_target_changed|filename_read_unavailable|input_architecture_unsupported|filename_input_bound|filename_bounds_unavailable|filename_focus_refused|filename_input_not_delivered|input_target_unavailable|input_foreground_refused|input_point_refused|input_cursor_refused|dialog_not_dismissed) stage=(?:setup|discovery|default_filename|filename_set|native_input) windows=[0-9]{1,9} elements=[0-9]{1,9} filenames=[0-9]{1,9} actions=[0-9]{1,9} fallback_misses=[0-9]{1,6}$/.test(
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
  const defaultProbe = output
    .split(/\r?\n/)
    .find((line) =>
      /^Native Save default probe: value=(?:expected|basename|double_dot|double_extension|empty|other)$/.test(
        line,
      ),
    );
  const pointProbe = output
    .split(/\r?\n/)
    .find((line) =>
      /^Native Save point probe: inside_dialog=(?:true|false) hit=(?:none|owned_other|foreign) awareness=(?:-1|0|1|2)$/.test(
        line,
      ),
    );
  const clickProbes = output
    .split(/\r?\n/)
    .filter((line) =>
      /^Native Save click probe: control_known=(?:true|false) hit_control=(?:true|false) hit_child=(?:true|false) cursor_match=(?:true|false)$/.test(
        line,
      ),
    )
    .slice(-3);
  const dismissalProbes = output
    .split(/\r?\n/)
    .filter((line) =>
      /^Native Save dismissal probe: exists=true visible=(?:true|false) enabled=(?:true|false) owned=(?:true|false)$/.test(
        line,
      ),
    )
    .slice(-3);
  const responseProbes = output
    .split(/\r?\n/)
    .filter((line) =>
      /^Native Save response probe: dialog_responsive=(?:true|false|unknown) control_responsive=(?:true|false|unknown) focus_control=(?:true|false|unknown) capture_control=(?:true|false|unknown) left_down=(?:true|false) foreground_dialog=(?:true|false)$/.test(
        line,
      ),
    )
    .slice(-3);
  const foregroundProbes = output
    .split(/\r?\n/)
    .filter((line) =>
      /^Native Save foreground probe: phase=(?:before_input|after_input|dismissal) kind=(?:none|dialog|application|owned_other|driver|foreign) class=(?:none|dialog|other) visible=(?:true|false) enabled=(?:true|false)$/.test(
        line,
      ),
    )
    .slice(-3);
  const activationProbes = output
    .split(/\r?\n/)
    .filter((line) =>
      /^Native Save activation probe: phase=(?:after_input|dismissal) process=(?:none|application|driver|console|terminal|shell|runner|other|unavailable) elapsed_ms=[0-9]{1,9}$/.test(
        line,
      ),
    )
    .slice(-3);
  const pointerProbes = output
    .split(/\r?\n/)
    .filter((line) =>
      /^Native Save pointer probe: phase=(?:before_input|after_input|dismissal) cursor_match=(?:true|false) point_root=(?:none|dialog|owned_other|foreign) hit_control=(?:true|false) foreground_at_point=(?:true|false) left_down=(?:true|false) modifier_mask=(?:[0-9]|1[0-5])$/.test(
        line,
      ),
    )
    .slice(-3);
  const inputTargets = output
    .split(/\r?\n/)
    .filter((line) =>
      /^Native Save input target probe: phase=(?:after_input|dismissal) class=(?:none|button|edit|other) id=(?:none|cancel|primary|filename|other) child=(?:true|false) owned=(?:true|false) thread_known=(?:true|false) active_dialog=(?:true|false|unknown) focus_control=(?:true|false|unknown) capture_control=(?:true|false|unknown)$/.test(
        line,
      ),
    )
    .slice(-3);
  const filenameReads = output
    .split(/\r?\n/)
    .filter((line) =>
      /^Native Save filename read probe: completed=(?:true|false) length_bound=(?:true|false|unknown) duration_ms=[0-9]{1,6} dialog_exists=(?:true|false) field_exists=(?:true|false) field_child=(?:true|false)$/.test(
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
    ...(counters ? [counters] : []),
    ...filenameReads,
    ...probes,
    ...windowProbes,
    ...dismissalProbes,
    ...responseProbes,
    ...foregroundProbes,
    ...activationProbes,
    ...pointerProbes,
    ...clickProbes,
    ...inputTargets,
    ...controlProbes,
    ...candidates,
    ...children,
    ...(defaultProbe ? [defaultProbe] : []),
    ...(pointProbe ? [pointProbe] : []),
  ].join("\n");
}

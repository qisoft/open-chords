import { installedExportExitDiagnostic } from "./installed-export-process.ts";
import { installedMacSaveFieldDiagnostic } from "./installed-macos-save-field-probe.ts";

export function installedMacPickerDiagnostic(error: unknown, stderr: string, durationMs: number) {
  const reads = stderr
    .slice(-65536)
    .split(/\r?\n/u)
    .filter((line) =>
      /^Native macOS picker attribute: stage=(?:processes|windows|sheets|elements|selection|navigation|path_entry|navigation_dismissal|selected_file|action|dismissal|deadline) attribute=(?:unixId|frontmost|role|name|enabled|focused|value|subrole) os_error=(?:unknown|-?[0-9]{1,5})$/u.test(
        line,
      ),
    )
    .slice(-3);
  const refusal = stderr
    .slice(-65536)
    .split(/\r?\n/u)
    .filter((line) =>
      /^Native macOS picker refusal: reason=(?:filename_input_focus_failed|filename_input_readback_failed|default_filename_unavailable|default_filename_invalid|navigation_parent_changed|navigation_role_changed|navigation_not_dismissed|prepared_target_changed|action_target_changed|other)$/u.test(
        line,
      ),
    )
    .slice(-1);
  const guards = stderr
    .slice(-65536)
    .split(/\r?\n/u)
    .filter((line) => {
      const match =
        /^Native macOS picker guard: phase=(?:activate|before_input|after_probe) mask=([0-9]{1,3}) unknown_mask=([0-9]{1,3})$/u.exec(
          line,
        );
      return match !== null && Number(match[1]) <= 255 && Number(match[2]) <= 255;
    })
    .slice(-3);
  const guardSnapshots = stderr
    .slice(-65536)
    .split(/\r?\n/u)
    .filter((line) =>
      /^Native macOS picker guard snapshot: phase=(?:activate|before_input|after_probe) status=(?:complete|deadline|bound|error) age_ms=[0-9]{1,6} sheet_exists=(?:true|false|unknown) button_exists=(?:true|false|unknown) windows=(?:[0-9]|1[0-7]) sheets=(?:[0-9]|1[0-7]) os_error=(?:none|unknown|-?[0-9]{1,5})$/u.test(
        line,
      ),
    )
    .slice(-1);
  const probes = stderr
    .slice(-65536)
    .split(/\r?\n/u)
    .filter((line) =>
      /^Native macOS picker failure: stage=(?:processes|windows|sheets|elements|selection|navigation|path_entry|navigation_dismissal|selected_file|action|dismissal|deadline) elapsed_ms=[0-9]{1,6} processes=[0-9]{1,2} windows=[0-9]{1,2} sheets=[0-9]{1,2} elements=[0-9]{1,3} cancel=[0-9]{1,3} open=[0-9]{1,3} navigation_sheets=[0-9]{1,2} path_fields=[0-9]{1,3} selected_rows=[0-9]{1,3} selected_urls=[0-9]{1,3} selected_matches=[0-9]{1,3} selection_step=(?:none|elements|elements_bound|selected_attribute|ambiguous|row_elements|row_bound|url|verify|unverified) os_error=(?:unknown|-?[0-9]{1,5})$/u.test(
        line,
      ),
    )
    .slice(-1);
  const selection = stderr
    .slice(-65536)
    .split(/\r?\n/u)
    .filter(
      (line) =>
        line === "Native macOS selection unavailable: fixed_probe_failure" ||
        /^Native macOS selection probe: step=(?:elements|selected|role|url|relationships|selected_query|columns|complete|bound) os_error=(?:none|unknown|-?[0-9]{1,5}) elements=[0-9]{1,3} complete=[01] selected_boolean=[0-9]{1,3} selected_number=[0-9]{1,3} selected_string=[0-9]{1,3} selected_row=[0-9]{1,3} selected_cell=[0-9]{1,3} selected_image=[0-9]{1,3} selected_other=[0-9]{1,3} url_strings=[0-9]{1,3} url_matches=[0-9]{1,3} selected_children=[0-9]{1,3} selected_rows=[0-9]{1,3} containers=[0-9]{1,3} relationship_arrays=[0-9]{1,3} relationship_other=[0-9]{1,3} selected_filter=[0-9]{1,3} filter_errors=[0-9]{1,3} url_other=[0-9]{1,3} column_children=[0-9]{1,3} target_names=[0-9]{1,3} target_values=[0-9]{1,3} filename_strings=[0-9]{1,3} filename_matches=[0-9]{1,3}$/u.test(
          line,
        ),
    )
    .slice(-1);
  const target = stderr
    .slice(-65536)
    .split(/\r?\n/u)
    .filter((line) =>
      /^Native macOS target probe: role=(?:none|row|cell|column|text_field|static_text|button|popup|path_control|other|ambiguous) matches=[0-9]{1,3} path_values=[0-9]{1,3} directory_values=[0-9]{1,3} url_values=[0-9]{1,3} path_attributes=[0-9]{1,3} document_matches=[0-9]{1,3}$/u.test(
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
    ...selection,
    ...target,
    ...guards,
    ...guardSnapshots,
    ...(installedMacSaveControlsDiagnostic(stderr)
      ? [installedMacSaveControlsDiagnostic(stderr)]
      : []),
    ...(installedMacPickerRefreshDiagnostic(stderr)
      ? [installedMacPickerRefreshDiagnostic(stderr)]
      : []),
    ...reads,
    ...refusal,
    ...installedMacSaveInitialDisclosure(stderr),
    ...installedMacSaveFailureFields(stderr),
  ].join("\n");
}

export function installedMacPickerRefreshDiagnostic(stderr: string) {
  return stderr
    .slice(-65536)
    .split(/\r?\n/u)
    .find(
      (line) =>
        line === "Native macOS picker refresh: reason=stale_reference attempt=1 before_input=true",
    );
}

export function installedMacSaveControlsDiagnostic(stderr: string) {
  return stderr
    .slice(-65536)
    .split(/\r?\n/u)
    .filter((line) => {
      const match =
        /^Native macOS Save controls probe: elements=([0-9]{1,3}) skipped_content=([0-9]{1,3}) complete=(?:true|false)$/u.exec(
          line,
        );
      return match !== null && Number(match[1]) <= 256 && Number(match[2]) <= Number(match[1]);
    })
    .at(-1);
}

export function installedMacSaveFailureFields(stderr: string): string[] {
  const prefix = "Native macOS Save field evidence: ";
  const line = stderr
    .slice(-65536)
    .split(/\r?\n/u)
    .filter((entry) => entry.startsWith(prefix))
    .at(-1);
  if (!line || line.length > 4096) return [];
  try {
    const value: unknown = JSON.parse(line.slice(prefix.length));
    if (
      typeof value !== "object" ||
      value === null ||
      !("format" in value) ||
      (value.format !== "json" &&
        value.format !== "lrc" &&
        value.format !== "chordpro" &&
        value.format !== "pdf" &&
        value.format !== "archive")
    )
      return [];
    const diagnostic = installedMacSaveFieldDiagnostic(value, value.format);
    return diagnostic.endsWith("invalid_evidence") ? [] : [diagnostic];
  } catch {
    return [];
  }
}

export function installedMacSaveInitialDisclosure(stderr: string): string[] {
  const entries = stderr
    .slice(-65536)
    .split(/\r?\n/u)
    .filter((line) => {
      const match =
        /^Native macOS Save initial disclosure: controls=([0-9]{1,3}) disclosures=([0-9]{1,3}) zero=([0-9]{1,3}) one=([0-9]{1,3}) unknown=([0-9]{1,3})$/u.exec(
          line,
        );
      return (
        match !== null &&
        Number(match[1]) <= 256 &&
        Number(match[2]) <= Number(match[1]) &&
        Number(match[3]) + Number(match[4]) + Number(match[5]) === Number(match[2])
      );
    });
  return entries.slice(-1);
}

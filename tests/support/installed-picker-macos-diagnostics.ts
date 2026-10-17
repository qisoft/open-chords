import { installedExportExitDiagnostic } from "./installed-export-process.ts";

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
      /^Native macOS picker refusal: reason=(?:default_filename_unavailable|default_filename_invalid|navigation_parent_changed|navigation_role_changed|navigation_not_dismissed|prepared_target_changed|action_target_changed|other)$/u.test(
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
    ...reads,
    ...refusal,
  ].join("\n");
}

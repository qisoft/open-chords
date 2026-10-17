import { z } from "zod";

import { installedExportExitDiagnostic } from "./installed-export-process.ts";

export const MAC_AX_COUNT_FIELDS = [
  "windows",
  "sheets",
  "visited",
  "selectedRoots",
  "selectedRows",
  "selectedCells",
  "selectedColumns",
  "urlStrings",
  "urlObjects",
  "exactUrls",
  "exactFilenames",
  "basenameMatches",
  "unsupported",
  "cannotComplete",
  "apiDisabled",
  "otherErrors",
  "selectedUrls",
  "selectedExactUrls",
  "selectedLeaves",
  "leafMatches",
  "buttons",
] as const;

const evidenceSchema = z.strictObject({
  trusted: z.boolean(),
  complete: z.boolean(),
  lastError: z.number().int().min(-32768).max(32767),
  dismissalLastError: z.number().int().min(-32768).max(32767),
  pressDurationMs: z.number().int().min(0).max(999999),
  pressSheetState: z.enum([
    "not_checked",
    "invalid_sheet",
    "attached_sheet",
    "detached_sheet",
    "unknown",
  ]),
  pressFollowupError: z.number().int().min(-32768).max(32767),
  firstOtherError: z.number().int().min(-32768).max(32767),
  firstOtherAttribute: z.enum([
    "none",
    "AXWindows",
    "AXRole",
    "AXChildren",
    "AXSelected",
    "AXTitle",
    "AXValue",
    "AXFilename",
    "AXURL",
    "AXSelectedChildren",
    "AXSelectedRows",
    "AXSelectedCells",
    "AXSelectedColumns",
    "AXColumns",
    "AXEnabled",
  ]),
  verified: z.boolean(),
  foreground: z.boolean(),
  guardMask: z.number().int().min(0).max(255),
  stage: z.enum([
    "arguments",
    "discovery",
    "selection",
    "verification",
    "guard",
    "press",
    "dismissal",
    "complete",
  ]),
  action: z.strictObject({
    requested: z.enum(["none", "open", "cancel_open_existing"]),
    pressed: z.boolean(),
    dismissed: z.boolean(),
  }),
  counts: z.record(z.enum(MAC_AX_COUNT_FIELDS), z.number().int().min(0).max(999)),
});

export function installedMacAxProbeDiagnostic(stdout: string, error: unknown, durationMs: number) {
  if (error)
    return installedExportExitDiagnostic(error, durationMs).replace(
      "Installed export process",
      "Native macOS AX probe",
    );
  try {
    if (stdout.length > 4096) return "Native macOS AX probe: invalid_evidence";
    const evidence = evidenceSchema.safeParse(JSON.parse(stdout));
    if (!evidence.success) return "Native macOS AX probe: invalid_evidence";
    const {
      trusted,
      complete,
      lastError,
      dismissalLastError,
      pressDurationMs,
      pressSheetState,
      pressFollowupError,
      counts,
      firstOtherError,
      firstOtherAttribute,
      verified,
      foreground,
      guardMask,
      stage,
      action,
    } = evidence.data;
    return [
      "Native macOS AX probe:",
      `trusted=${trusted}`,
      `complete=${complete}`,
      `last_error=${lastError}`,
      `dismissal_last_error=${dismissalLastError}`,
      `press_duration_ms=${pressDurationMs}`,
      `press_sheet_state=${pressSheetState}`,
      `press_followup_error=${pressFollowupError}`,
      `other_error=${firstOtherError}`,
      `other_attribute=${firstOtherAttribute}`,
      `verified=${verified}`,
      `foreground=${foreground}`,
      `guard_mask=${guardMask}`,
      `stage=${stage}`,
      `action=${action.requested}`,
      `pressed=${action.pressed}`,
      `dismissed=${action.dismissed}`,
      ...MAC_AX_COUNT_FIELDS.map((key) => `${key}=${counts[key]}`),
    ].join(" ");
  } catch {
    return "Native macOS AX probe: invalid_evidence";
  }
}

export function installedMacAxActionSucceeded(
  stdout: string,
  requested: "open" | "cancel_open_existing",
) {
  try {
    if (stdout.length > 4096) return false;
    const parsed = evidenceSchema.safeParse(JSON.parse(stdout));
    if (!parsed.success) return false;
    const value = parsed.data;
    return (
      value.lastError === 0 &&
      value.firstOtherError === 0 &&
      value.firstOtherAttribute === "none" &&
      value.trusted &&
      value.complete &&
      value.verified &&
      value.foreground &&
      value.guardMask === 255 &&
      value.stage === "complete" &&
      value.action.requested === requested &&
      value.action.pressed &&
      value.action.dismissed &&
      value.counts.selectedLeaves === 1 &&
      value.counts.leafMatches === 1 &&
      value.counts.selectedExactUrls === 1 &&
      value.counts.buttons === 1 &&
      value.counts.otherErrors === 0 &&
      value.counts.cannotComplete === 0 &&
      value.counts.apiDisabled === 0
    );
  } catch {
    return false;
  }
}

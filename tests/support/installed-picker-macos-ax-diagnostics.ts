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
  "valuePathMatches",
  "filenamePathMatches",
  "documentPathMatches",
  "pathControls",
  "popupControls",
  "disclosures",
  "expandedDisclosures",
  "collapsedDisclosures",
  "pathControlMatches",
  "popupPathMatches",
  "enabledDisclosures",
  "zeroValueDisclosures",
  "oneValueDisclosures",
  "unknownValueDisclosures",
  "disclosureActions",
  "pressableDisclosures",
] as const;

const AX_ATTRIBUTE_KEYS = [
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
  "AXDocument",
  "AXExpanded",
  "AXActions",
] as const;

const AX_ROLE_KEYS = [
  "none",
  "AXSheet",
  "AXBrowser",
  "AXScrollArea",
  "AXSplitGroup",
  "AXGroup",
  "AXList",
  "AXOutline",
  "AXTable",
  "AXColumn",
  "AXRow",
  "AXCell",
  "AXImage",
  "AXStaticText",
  "AXTextField",
  "AXButton",
  "AXPopUpButton",
  "AXDisclosureTriangle",
  "other",
] as const;

const AX_ORIGIN_KEYS = [
  "none",
  "discovery",
  "sheet",
  "AXChildren",
  "AXColumns",
  "AXSelectedChildren",
  "AXSelectedRows",
  "AXSelectedCells",
  "AXSelectedColumns",
  "selected_verification",
  "guard",
] as const;

const evidenceSchema = z.strictObject({
  firstExactURL: z.strictObject({
    role: z.enum(AX_ROLE_KEYS),
    parentRole: z.enum(AX_ROLE_KEYS),
    origin: z.enum(AX_ORIGIN_KEYS),
    selected: z.enum(["true", "false", "unknown"]),
    directory: z.boolean(),
    kind: z.enum(["none", "native", "string"]),
  }),
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
  firstOtherSelectedReference: z.boolean(),
  firstOtherSelectedBranch: z.boolean(),
  firstOtherError: z.number().int().min(-32768).max(32767),
  firstOtherAttribute: z.enum(AX_ATTRIBUTE_KEYS),
  firstOtherStage: z.enum(["none", "discovery", "selection", "verification", "guard"]),
  firstOtherOrigin: z.enum(AX_ORIGIN_KEYS),
  firstOtherParentRole: z.enum(AX_ROLE_KEYS),
  firstOtherVisited: z.number().int().min(0).max(256),
  firstCannotCompleteAttribute: z.enum(AX_ATTRIBUTE_KEYS),
  firstCannotCompleteStage: z.enum(["none", "discovery", "selection", "verification", "guard"]),
  firstCannotCompleteDurationMs: z.number().int().min(0).max(999999),
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
      firstOtherSelectedReference,
      firstOtherSelectedBranch,
      firstOtherAttribute,
      firstOtherStage,
      firstOtherVisited,
      firstOtherOrigin,
      firstOtherParentRole,
      firstExactURL,
      firstCannotCompleteAttribute,
      firstCannotCompleteStage,
      firstCannotCompleteDurationMs,
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
      `other_selected_reference=${firstOtherSelectedReference}`,
      `other_selected_branch=${firstOtherSelectedBranch}`,
      `other_attribute=${firstOtherAttribute}`,
      `other_stage=${firstOtherStage}`,
      `other_visited=${firstOtherVisited}`,
      `other_origin=${firstOtherOrigin}`,
      `other_parent_role=${firstOtherParentRole}`,
      ...Object.entries(firstExactURL).map(([key, value]) => `exact_url_${key}=${value}`),
      `cannot_complete_attribute=${firstCannotCompleteAttribute}`,
      `cannot_complete_stage=${firstCannotCompleteStage}`,
      `cannot_complete_duration_ms=${firstCannotCompleteDurationMs}`,
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

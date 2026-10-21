import { z } from "zod";

import { installedExportExitDiagnostic } from "./installed-export-process.ts";

export const MAC_AX_COUNT_FIELDS = [
  "saveButtons",
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
  "AXParent",
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
  "exact_url_parent_chain",
  "guard",
] as const;

const evidenceSchema = z.strictObject({
  staleSnapshot: z.strictObject({
    eligible: z.boolean(),
    traversalComplete: z.boolean(),
    candidates: z.number().int().min(0).max(256),
    allVanished: z.boolean(),
    onlyInvalidChildErrors: z.boolean(),
  }),
  invalidChildParent: z.strictObject({
    status: z.enum(["not_checked", "complete", "deadline", "error", "invalid_value", "bound"]),
    role: z.enum(AX_ROLE_KEYS),
    pidMatches: z.boolean(),
    selectedReference: z.boolean(),
    children: z.number().int().min(0).max(257),
    containsFailedReference: z.enum(["true", "false", "unknown"]),
    attribute: z.enum(["none", "pid", "AXRole", "AXChildren"]),
    error: z.number().int().min(-32768).max(32767),
  }),
  saveTargetAbsent: z.boolean().default(false),
  saveFilename: z
    .strictObject({
      status: z.enum([
        "not_checked",
        "complete",
        "deadline",
        "error",
        "invalid_candidate",
        "bound",
      ]),
      fields: z.number().int().min(0).max(256),
      matches: z.number().int().min(0).max(256),
      absentValues: z.number().int().min(0).max(256),
      enabled: z.boolean(),
      labelMatched: z.boolean(),
      fieldAttached: z.boolean(),
      labelAttached: z.boolean(),
      visited: z.number().int().min(0).max(32),
      verified: z.boolean(),
      error: z.number().int().min(-32768).max(32767),
      attribute: z.enum([
        "none",
        "AXValue",
        "AXRole",
        "AXEnabled",
        "AXTitleUIElement",
        "AXParent",
        "pid",
      ]),
    })
    .refine((value) => value.matches + value.absentValues <= value.fields)
    .default({
      status: "not_checked",
      fields: 0,
      matches: 0,
      absentValues: 0,
      enabled: false,
      labelMatched: false,
      fieldAttached: false,
      labelAttached: false,
      visited: 0,
      verified: false,
      error: 0,
      attribute: "none",
    }),
  saveTargetContext: z
    .strictObject({
      status: z.enum(["not_checked", "complete", "deadline", "error"]),
      fields: z.number().int().min(0).max(256),
      valueMatches: z.number().int().min(0).max(256),
      enabledMatches: z.number().int().min(0).max(256),
      labelMatches: z.number().int().min(0).max(256),
      descriptionMatches: z.number().int().min(0).max(256),
      linkedLabelMatches: z.number().int().min(0).max(256),
      linkedLabelRole: z.enum(["none", "static_text", "other"]),
      error: z.number().int().min(-32768).max(32767),
      attribute: z.enum([
        "none",
        "AXValue",
        "AXEnabled",
        "AXTitle",
        "AXDescription",
        "AXTitleUIElement",
        "AXRole",
        "pid",
      ]),
    })
    .refine(
      (value) =>
        value.valueMatches <= value.fields &&
        value.enabledMatches <= value.valueMatches &&
        value.labelMatches <= value.valueMatches &&
        value.descriptionMatches <= value.valueMatches &&
        value.linkedLabelMatches <= value.valueMatches,
    )
    .default({
      status: "not_checked",
      fields: 0,
      valueMatches: 0,
      enabledMatches: 0,
      labelMatches: 0,
      descriptionMatches: 0,
      linkedLabelMatches: 0,
      linkedLabelRole: "none",
      error: 0,
      attribute: "none",
    }),
  selectedDirectory: z
    .strictObject({
      fields: z.number().int().min(0).max(256),
      uniqueUrls: z.number().int().min(0).max(256),
      terminalUrls: z.number().int().min(0).max(256),
      terminalMatches: z.number().int().min(0).max(1),
      validShape: z.boolean(),
    })
    .refine(
      (value) =>
        value.fields >= value.uniqueUrls &&
        value.uniqueUrls >= value.terminalUrls &&
        value.terminalUrls >= value.terminalMatches &&
        (!value.validShape || value.fields > 0),
    ),
  parentChain: z
    .strictObject({
      status: z.enum([
        "not_checked",
        "bound",
        "deadline",
        "missing_parent",
        "unreadable_parent",
        "invalid_parent",
        "cycle",
        "unreadable_role",
        "captured_sheet",
      ]),
      visited: z.number().int().min(0).max(16),
      selected: z.number().int().min(0).max(16),
      unknownSelected: z.number().int().min(0).max(16),
      roleMask: z.number().int().min(0).max(63),
      nodes: z
        .array(
          z.strictObject({
            role: z.enum(AX_ROLE_KEYS),
            selectedReference: z.boolean(),
            selectedState: z.enum(["true", "false", "unknown", "not_read"]),
          }),
        )
        .max(16),
    })
    .refine(
      (value) =>
        value.selected + value.unknownSelected <= value.visited &&
        value.nodes.length === value.visited &&
        value.nodes.filter((node) => node.selectedState === "true").length === value.selected &&
        value.nodes.filter((node) => node.selectedState === "unknown").length ===
          value.unknownSelected,
    ),
  firstExactURL: z.strictObject({
    role: z.enum(AX_ROLE_KEYS),
    parentRole: z.enum(AX_ROLE_KEYS),
    origin: z.enum(AX_ORIGIN_KEYS),
    selected: z.enum(["true", "false", "unknown"]),
    directory: z.boolean(),
    kind: z.enum(["none", "native", "string"]),
    titleCategory: z.enum([
      "unavailable",
      "target_path",
      "target_basename",
      "save_as",
      "where",
      "search",
      "empty",
      "other",
    ]),
    valueCategory: z.enum([
      "unavailable",
      "target_path",
      "target_basename",
      "save_as",
      "where",
      "search",
      "empty",
      "other",
    ]),
    traversalRoleMask: z.number().int().min(0).max(63),
    traversalDepth: z.number().int().min(0).max(256),
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
  firstOtherStage: z.enum([
    "none",
    "discovery",
    "selection",
    "parent_chain",
    "verification",
    "guard",
  ]),
  firstOtherOrigin: z.enum(AX_ORIGIN_KEYS),
  firstOtherParentRole: z.enum(AX_ROLE_KEYS),
  firstOtherVisited: z.number().int().min(0).max(256),
  firstCannotCompleteAttribute: z.enum(AX_ATTRIBUTE_KEYS),
  firstCannotCompleteStage: z.enum([
    "none",
    "discovery",
    "selection",
    "parent_chain",
    "verification",
    "guard",
  ]),
  firstCannotCompleteDurationMs: z.number().int().min(0).max(999999),
  directoryVerified: z.boolean(),
  verified: z.boolean(),
  foreground: z.boolean(),
  guardMask: z.number().int().min(0).max(255),
  stage: z.enum([
    "arguments",
    "discovery",
    "selection",
    "verification",
    "parent_chain",
    "guard",
    "press",
    "dismissal",
    "complete",
    "directory_complete",
  ]),
  action: z.strictObject({
    requested: z.enum([
      "none",
      "open",
      "cancel_open_existing",
      "directory_snapshot",
      "save_new_json",
      "save_new_lrc",
      "save_new_chordpro",
    ]),
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
      selectedDirectory,
      saveTargetContext,
      saveFilename,
      saveTargetAbsent,
      staleSnapshot,
      invalidChildParent,
      parentChain,
      firstCannotCompleteAttribute,
      firstCannotCompleteStage,
      firstCannotCompleteDurationMs,
      directoryVerified,
      verified,
      foreground,
      guardMask,
      stage,
      action,
    } = evidence.data;
    const { nodes: parentNodes, ...parentSummary } = parentChain;
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
      ...Object.entries(staleSnapshot).map(([key, value]) => `stale_snapshot_${key}=${value}`),
      ...Object.entries(invalidChildParent).map(
        ([key, value]) => `invalid_child_parent_${key}=${value}`,
      ),
      `save_target_absent=${saveTargetAbsent}`,
      ...Object.entries(saveFilename).map(([key, value]) => `save_filename_${key}=${value}`),
      ...Object.entries(saveTargetContext).map(([key, value]) => `save_target_${key}=${value}`),
      ...Object.entries(selectedDirectory).map(
        ([key, value]) => `selected_directory_${key}=${value}`,
      ),
      ...Object.entries(parentSummary).map(([key, value]) => `parent_chain_${key}=${value}`),
      ...parentNodes.flatMap((node, index) => [
        `parent_chain_node_${index}_role=${node.role}`,
        `parent_chain_node_${index}_selected_reference=${node.selectedReference}`,
        `parent_chain_node_${index}_selected_state=${node.selectedState}`,
      ]),
      ...Object.entries(firstExactURL).map(([key, value]) => `exact_url_${key}=${value}`),
      `cannot_complete_attribute=${firstCannotCompleteAttribute}`,
      `cannot_complete_stage=${firstCannotCompleteStage}`,
      `cannot_complete_duration_ms=${firstCannotCompleteDurationMs}`,
      `directory_verified=${directoryVerified}`,
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

// Read-only selected terminal directory proof; never an input/action authorization.
export function installedMacSelectedDirectoryVerified(stdout: string) {
  try {
    if (stdout.length > 4096) return false;
    const parsed = evidenceSchema.safeParse(JSON.parse(stdout));
    if (!parsed.success) return false;
    const value = parsed.data;
    return (
      directoryEvidenceVerified(value) &&
      value.stage === "directory_complete" &&
      value.action.requested === "directory_snapshot" &&
      !value.action.pressed &&
      !value.action.dismissed
    );
  } catch {
    return false;
  }
}

function directoryEvidenceVerified(value: z.infer<typeof evidenceSchema>) {
  return (
    value.trusted &&
    value.complete &&
    value.directoryVerified &&
    value.foreground &&
    value.guardMask === 255 &&
    value.firstOtherError === 0 &&
    value.firstOtherAttribute === "none" &&
    value.counts.otherErrors === 0 &&
    value.counts.cannotComplete === 0 &&
    value.counts.apiDisabled === 0 &&
    value.counts.windows === 1 &&
    value.counts.sheets === 1 &&
    value.counts.buttons === 1 &&
    value.counts.saveButtons === 1 &&
    value.selectedDirectory.validShape &&
    value.selectedDirectory.fields === value.counts.selectedRoots &&
    value.selectedDirectory.uniqueUrls === value.counts.selectedRoots &&
    value.selectedDirectory.fields > 0 &&
    value.selectedDirectory.terminalUrls === 1 &&
    value.selectedDirectory.terminalMatches === 1 &&
    value.counts.exactUrls === 1 &&
    value.counts.urlStrings === 0 &&
    value.counts.urlObjects === value.selectedDirectory.fields &&
    value.firstExactURL.role === "AXTextField" &&
    value.firstExactURL.origin === "AXChildren" &&
    value.firstExactURL.parentRole === "AXGroup" &&
    value.firstExactURL.kind === "native" &&
    value.firstExactURL.directory &&
    value.parentChain.status === "captured_sheet" &&
    value.parentChain.nodes[0]?.role === "AXGroup" &&
    value.parentChain.nodes[0]?.selectedReference &&
    value.parentChain.nodes.at(-1)?.role === "AXSheet"
  );
}

// A fresh complete snapshot may be taken once before any native action; this never accepts the failed snapshot.
export function installedMacAxSnapshotRefreshAllowed(
  stdout: string,
  requested: "open" | "cancel_open_existing",
) {
  try {
    if (stdout.length > 4096) return false;
    const parsed = evidenceSchema.safeParse(JSON.parse(stdout));
    if (!parsed.success) return false;
    const value = parsed.data;
    return (
      value.trusted &&
      !value.complete &&
      !value.verified &&
      !value.directoryVerified &&
      value.stage === "verification" &&
      value.guardMask === 0 &&
      value.pressDurationMs === 0 &&
      value.pressSheetState === "not_checked" &&
      value.action.requested === requested &&
      !value.action.pressed &&
      !value.action.dismissed &&
      value.staleSnapshot.eligible &&
      value.staleSnapshot.traversalComplete &&
      value.staleSnapshot.candidates > 0 &&
      value.staleSnapshot.allVanished &&
      value.staleSnapshot.onlyInvalidChildErrors &&
      value.firstOtherError === -25202 &&
      value.firstOtherAttribute === "AXRole" &&
      value.firstOtherStage === "selection" &&
      value.firstOtherOrigin === "AXChildren" &&
      value.firstOtherParentRole === "AXScrollArea" &&
      !value.firstOtherSelectedReference &&
      !value.firstOtherSelectedBranch &&
      value.invalidChildParent.status === "complete" &&
      value.invalidChildParent.role === "AXScrollArea" &&
      value.invalidChildParent.pidMatches &&
      !value.invalidChildParent.selectedReference &&
      value.invalidChildParent.containsFailedReference === "false" &&
      value.invalidChildParent.attribute === "none" &&
      value.invalidChildParent.error === 0 &&
      value.firstOtherVisited > 0 &&
      value.firstOtherVisited <= value.counts.visited &&
      value.counts.visited <= 256 &&
      value.staleSnapshot.candidates <= value.counts.visited &&
      value.counts.selectedRoots > 0 &&
      value.counts.selectedRoots <= 256 &&
      value.counts.otherErrors >= value.staleSnapshot.candidates &&
      value.counts.cannotComplete === 0 &&
      value.counts.apiDisabled === 0 &&
      value.counts.windows === 1 &&
      value.counts.sheets === 1 &&
      value.counts.buttons === 1 &&
      value.counts.selectedLeaves === 1 &&
      value.counts.leafMatches === 1 &&
      value.counts.selectedExactUrls === 1
    );
  } catch {
    return false;
  }
}

// Read-only field/label binding to the captured sheet; does not authorize Save.
export function installedMacSaveFilenameVerified(stdout: string) {
  if (!installedMacSelectedDirectoryVerified(stdout)) return false;
  try {
    const parsed = evidenceSchema.safeParse(JSON.parse(stdout));
    if (!parsed.success) return false;
    const value = parsed.data.saveFilename;
    return filenameEvidenceVerified(value);
  } catch {
    return false;
  }
}

function filenameEvidenceVerified(value: z.infer<typeof evidenceSchema>["saveFilename"]) {
  return (
    value.status === "complete" &&
    value.verified &&
    value.fields > 0 &&
    value.matches === 1 &&
    value.enabled &&
    value.labelMatched &&
    value.fieldAttached &&
    value.labelAttached &&
    value.visited > 0 &&
    value.error === 0 &&
    value.attribute === "none"
  );
}
export function installedMacJsonSaveSucceeded(stdout: string) {
  return nativeSaveSucceeded(stdout, "json");
}
export function installedMacTextSaveSucceeded(stdout: string, format: "lrc" | "chordpro") {
  return nativeSaveSucceeded(stdout, format);
}
function nativeSaveSucceeded(stdout: string, format: "json" | "lrc" | "chordpro") {
  if (stdout.length > 4096) return false;
  try {
    const parsed = evidenceSchema.safeParse(JSON.parse(stdout));
    if (!parsed.success) return false;
    const value = parsed.data;
    return (
      directoryEvidenceVerified(value) &&
      filenameEvidenceVerified(value.saveFilename) &&
      value.saveTargetAbsent &&
      value.lastError === 0 &&
      value.stage === "complete" &&
      value.action.requested === `save_new_${format}` &&
      value.action.pressed &&
      value.action.dismissed
    );
  } catch {
    return false;
  }
}

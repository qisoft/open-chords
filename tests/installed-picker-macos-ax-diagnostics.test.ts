import { expect, it } from "vitest";

import {
  installedMacAxProbeDiagnostic,
  installedMacAxActionSucceeded,
  installedMacAxSnapshotRefreshAllowed,
  installedMacSelectedDirectoryVerified,
  installedMacSaveFilenameVerified,
  installedMacJsonSaveSucceeded,
  installedMacTextSaveSucceeded,
  installedMacPdfSaveSucceeded,
  installedMacArchiveSaveSucceeded,
  installedMacReplaceContextObserved,
  installedMacReplacementCancelled,
  installedMacJsonReplacementConfirmed,
  MAC_AX_COUNT_FIELDS,
} from "./support/installed-picker-macos-ax-diagnostics.ts";

const evidence = {
  trusted: false,
  complete: false,
  lastError: -25211,
  dismissalLastError: 0,
  pressDurationMs: 0,
  pressSheetState: "not_checked",
  pressFollowupError: 0,
  firstOtherError: 0,
  firstOtherSelectedReference: false,
  firstOtherSelectedBranch: false,
  firstOtherAttribute: "none",
  firstOtherStage: "none",
  firstOtherVisited: 0,
  firstOtherOrigin: "none",
  firstOtherParentRole: "none",
  staleSnapshot: {
    eligible: false,
    traversalComplete: false,
    candidates: 0,
    allVanished: false,
    onlyInvalidChildErrors: false,
  },
  invalidChildParent: {
    status: "not_checked",
    role: "none",
    pidMatches: false,
    selectedReference: false,
    children: 0,
    containsFailedReference: "unknown",
    attribute: "none",
    error: 0,
  },
  selectedDirectory: {
    fields: 0,
    uniqueUrls: 0,
    terminalUrls: 0,
    terminalMatches: 0,
    validShape: false,
  },
  parentChain: {
    status: "not_checked",
    visited: 0,
    selected: 0,
    unknownSelected: 0,
    roleMask: 0,
    nodes: [],
  },
  firstExactURL: {
    role: "none",
    parentRole: "none",
    origin: "none",
    selected: "unknown",
    directory: false,
    kind: "none",
    titleCategory: "unavailable",
    valueCategory: "unavailable",
    traversalRoleMask: 0,
    traversalDepth: 0,
  },
  firstCannotCompleteAttribute: "none",
  firstCannotCompleteStage: "none",
  firstCannotCompleteDurationMs: 0,
  directoryVerified: false,
  verified: false,
  foreground: false,
  guardMask: 0,
  stage: "verification",
  action: { requested: "none", pressed: false, dismissed: false },
  counts: Object.fromEntries(MAC_AX_COUNT_FIELDS.map((key) => [key, 0])),
};

it("preserves exact native AX counts and permission failures without raw data", () => {
  const output = installedMacAxProbeDiagnostic(JSON.stringify(evidence), null, 10);
  expect(output).toContain("trusted=false complete=false last_error=-25211");
  expect(output).toContain("dismissal_last_error=0");
  expect(output).toContain(
    "press_duration_ms=0 press_sheet_state=not_checked press_followup_error=0",
  );
  for (const key of MAC_AX_COUNT_FIELDS) expect(output).toContain(`${key}=0`);
});

it("reports bounded read-only directory attributes without authorizing an action", () => {
  const observation = {
    ...evidence,
    trusted: true,
    complete: true,
    lastError: 0,
    counts: {
      ...evidence.counts,
      valuePathMatches: 1,
      documentPathMatches: 1,
      popupControls: 1,
      popupPathMatches: 1,
      disclosures: 1,
      collapsedDisclosures: 1,
      enabledDisclosures: 1,
      zeroValueDisclosures: 1,
      disclosureActions: 1,
      pressableDisclosures: 1,
    },
  };
  const stdout = JSON.stringify(observation);
  expect(installedMacAxProbeDiagnostic(stdout, null, 1)).toContain("valuePathMatches=1");
  expect(installedMacAxProbeDiagnostic(stdout, null, 1)).toContain("documentPathMatches=1");
  expect(installedMacAxProbeDiagnostic(stdout, null, 1)).toContain("collapsedDisclosures=1");
  expect(installedMacAxActionSucceeded(stdout, "open")).toBe(false);
  expect(installedMacAxActionSucceeded(stdout, "cancel_open_existing")).toBe(false);
});

it.each([
  "enabledDisclosures",
  "zeroValueDisclosures",
  "oneValueDisclosures",
  "unknownValueDisclosures",
  "disclosureActions",
  "pressableDisclosures",
])("rejects private, negative, unbounded or missing %s observations", (key) => {
  for (const value of ["/private/disclosure", -1, 1000, null, undefined]) {
    const observation = { ...evidence, counts: { ...evidence.counts, [key]: value } };
    expect(installedMacAxProbeDiagnostic(JSON.stringify(observation), null, 1)).toBe(
      "Native macOS AX probe: invalid_evidence",
    );
  }
});

it("retains fixed AXActions failures without raw action names or authorizing an action", () => {
  const observation = {
    ...evidence,
    firstOtherError: -25200,
    firstOtherAttribute: "AXActions",
    firstOtherStage: "selection",
    counts: { ...evidence.counts, otherErrors: 1 },
  };
  const stdout = JSON.stringify(observation);
  expect(installedMacAxProbeDiagnostic(stdout, null, 1)).toContain("other_attribute=AXActions");
  expect(installedMacAxActionSucceeded(stdout, "open")).toBe(false);
  expect(
    installedMacAxProbeDiagnostic(
      JSON.stringify({ ...observation, actions: ["/private/action"] }),
      null,
      1,
    ),
  ).toBe("Native macOS AX probe: invalid_evidence");
});

it.each([
  { ...evidence, path: "/private/fixture" },
  { ...evidence, counts: { ...evidence.counts, url: "file:///private/fixture" } },
  { ...evidence, counts: { ...evidence.counts, visited: 1000 } },
  { ...evidence, counts: { ...evidence.counts, visited: -1 } },
  { ...evidence, counts: {} },
  { ...evidence, lastError: "/private/error" },
  { ...evidence, dismissalLastError: "/private/error" },
  { ...evidence, dismissalLastError: -32769 },
  { ...evidence, pressDurationMs: 1000000 },
  { ...evidence, pressSheetState: "/private/sheet" },
  { ...evidence, pressFollowupError: "/private/error" },
  { ...evidence, firstCannotCompleteAttribute: "/private/attribute" },
  { ...evidence, firstOtherStage: "/private/stage" },
  { ...evidence, firstOtherVisited: 257 },
  { ...evidence, firstCannotCompleteStage: "/private/stage" },
  { ...evidence, firstCannotCompleteDurationMs: 1000000 },
  { ...evidence, complete: "private" },
])("rejects malformed or additional native evidence", (value) => {
  expect(installedMacAxProbeDiagnostic(JSON.stringify(value), null, 1)).toBe(
    "Native macOS AX probe: invalid_evidence",
  );
});

it("rejects oversized and non-JSON output and strips process command/error text", () => {
  for (const value of ["/private/error", "x".repeat(4097)]) {
    expect(installedMacAxProbeDiagnostic(value, null, 1)).toBe(
      "Native macOS AX probe: invalid_evidence",
    );
  }
  const result = installedMacAxProbeDiagnostic(
    "file:///private/fixture",
    { code: 1, killed: true, signal: "SIGTERM", message: "/private/command" },
    5000,
  );
  expect(result).toContain("killed=true");
  expect(result).not.toContain("private");
});

it("retains the fixed first cannotComplete read classification without accepting failed selection", () => {
  const failed = {
    ...evidence,
    firstCannotCompleteAttribute: "AXURL",
    firstCannotCompleteStage: "selection",
    firstCannotCompleteDurationMs: 151,
    counts: { ...evidence.counts, cannotComplete: 1 },
  };
  const output = installedMacAxProbeDiagnostic(JSON.stringify(failed), null, 1);
  expect(output).toContain(
    "cannot_complete_attribute=AXURL cannot_complete_stage=selection cannot_complete_duration_ms=151",
  );
  expect(installedMacAxActionSucceeded(JSON.stringify(failed), "open")).toBe(false);
});

it.each([
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
])("retains only fixed failed-element origin %s", (origin) => {
  const observed = { ...evidence, firstOtherOrigin: origin, firstOtherError: -25202 };
  const stdout = JSON.stringify(observed);
  expect(installedMacAxProbeDiagnostic(stdout, null, 1)).toContain(`other_origin=${origin}`);
  expect(installedMacAxActionSucceeded(stdout, "open")).toBe(false);
  expect(
    installedMacAxProbeDiagnostic(
      JSON.stringify({ ...observed, firstOtherOrigin: "/private/node" }),
      null,
      1,
    ),
  ).toBe("Native macOS AX probe: invalid_evidence");
});

it("requires exact unique selected-file evidence, guarded native press and actual dismissal", () => {
  const successful = {
    ...evidence,
    trusted: true,
    complete: true,
    lastError: 0,
    verified: true,
    foreground: true,
    guardMask: 255,
    stage: "complete",
    action: { requested: "open", pressed: true, dismissed: true },
    counts: {
      ...evidence.counts,
      selectedLeaves: 1,
      leafMatches: 1,
      selectedExactUrls: 1,
      buttons: 1,
    },
  };
  expect(installedMacAxActionSucceeded(JSON.stringify(successful), "open")).toBe(true);
  expect(
    installedMacAxActionSucceeded(
      JSON.stringify({ ...successful, dismissalLastError: -25204 }),
      "open",
    ),
  ).toBe(true);
  const refused = [
    ...["invalid_sheet", "detached_sheet", "attached_sheet", "unknown"].map((pressSheetState) => ({
      ...successful,
      lastError: -25204,
      stage: "press",
      pressDurationMs: 150,
      pressSheetState,
      action: { ...successful.action, pressed: false, dismissed: false },
    })),
    { ...successful, trusted: false },
    { ...successful, complete: false },
    { ...successful, verified: false },
    { ...successful, foreground: false },
    { ...successful, guardMask: 254 },
    { ...successful, lastError: -25200 },
    { ...successful, lastError: -25204, dismissalLastError: -25204 },
    {
      ...successful,
      stage: "dismissal",
      dismissalLastError: -25204,
      action: { ...successful.action, dismissed: false },
    },
    { ...successful, firstOtherError: -25200 },
    { ...successful, stage: "guard" },
    { ...successful, action: { ...successful.action, pressed: false } },
    { ...successful, action: { ...successful.action, dismissed: false } },
    ...["selectedLeaves", "leafMatches", "selectedExactUrls", "buttons"].map((key) => ({
      ...successful,
      counts: { ...successful.counts, [key]: 2 },
    })),
    ...["otherErrors", "cannotComplete", "apiDisabled"].map((key) => ({
      ...successful,
      counts: { ...successful.counts, [key]: 1 },
    })),
  ];
  for (const candidate of refused)
    expect(installedMacAxActionSucceeded(JSON.stringify(candidate), "open")).toBe(false);
  expect(installedMacAxActionSucceeded(JSON.stringify(successful), "cancel_open_existing")).toBe(
    false,
  );
  expect(installedMacAxActionSucceeded("/private/invalid", "open")).toBe(false);
});

it.each(["none", "AXBrowser", "AXColumn", "AXRow", "AXImage", "other"])(
  "retains only fixed parent role %s without accepting failed verification",
  (role) => {
    const observed = {
      ...evidence,
      firstOtherError: -25202,
      firstOtherOrigin: "AXChildren",
      firstOtherParentRole: role,
    };
    const stdout = JSON.stringify(observed);
    expect(installedMacAxProbeDiagnostic(stdout, null, 1)).toContain(`other_parent_role=${role}`);
    expect(installedMacAxActionSucceeded(stdout, "open")).toBe(false);
    expect(installedMacAxActionSucceeded(stdout, "cancel_open_existing")).toBe(false);
    expect(
      installedMacAxProbeDiagnostic(
        JSON.stringify({ ...observed, firstOtherParentRole: "/private/role" }),
        null,
        1,
      ),
    ).toBe("Native macOS AX probe: invalid_evidence");
  },
);

it("reports categorical exact URL provenance without granting directory or action verification", () => {
  const observed = {
    ...evidence,
    trusted: true,
    firstExactURL: {
      role: "AXImage",
      parentRole: "AXRow",
      origin: "AXChildren",
      selected: "unknown",
      directory: true,
      kind: "native",
      titleCategory: "other",
      valueCategory: "target_basename",
      traversalRoleMask: 8,
      traversalDepth: 3,
    },
    counts: { ...evidence.counts, exactUrls: 1 },
  };
  const stdout = JSON.stringify(observed);
  expect(installedMacAxProbeDiagnostic(stdout, null, 1)).toContain("exact_url_role=AXImage");
  expect(installedMacAxProbeDiagnostic(stdout, null, 1)).toContain("exact_url_parentRole=AXRow");
  expect(installedMacAxProbeDiagnostic(stdout, null, 1)).toContain("exact_url_directory=true");
  expect(installedMacAxActionSucceeded(stdout, "open")).toBe(false);
  for (const change of [
    { role: "/private/role" },
    { parentRole: "/private/parent" },
    { origin: "/private/path" },
    { selected: "private" },
    { directory: "/private/path" },
    { kind: "/private/value" },
    { path: "/private/target" },
  ]) {
    expect(
      installedMacAxProbeDiagnostic(
        JSON.stringify({ ...observed, firstExactURL: { ...observed.firstExactURL, ...change } }),
        null,
        1,
      ),
    ).toBe("Native macOS AX probe: invalid_evidence");
  }
});

it("reports only boolean selection provenance for a failed native read", () => {
  const observed = {
    ...evidence,
    firstOtherError: -25202,
    firstOtherSelectedReference: false,
    firstOtherSelectedBranch: true,
  };
  expect(installedMacAxProbeDiagnostic(JSON.stringify(observed), null, 1)).toContain(
    "other_selected_branch=true",
  );
  expect(installedMacAxActionSucceeded(JSON.stringify(observed), "open")).toBe(false);
  for (const change of [
    { firstOtherSelectedReference: "/private/reference" },
    { firstOtherSelectedBranch: "/private/branch" },
  ]) {
    expect(installedMacAxProbeDiagnostic(JSON.stringify({ ...observed, ...change }), null, 1)).toBe(
      "Native macOS AX probe: invalid_evidence",
    );
  }
});

it("bounds exact-field context and rejects all private labels without authorizing an action", () => {
  const observed = {
    ...evidence,
    firstExactURL: {
      ...evidence.firstExactURL,
      titleCategory: "where",
      valueCategory: "target_basename",
      traversalRoleMask: 9,
      traversalDepth: 4,
    },
  };
  const stdout = JSON.stringify(observed);
  expect(installedMacAxProbeDiagnostic(stdout, null, 1)).toContain("exact_url_titleCategory=where");
  expect(installedMacAxProbeDiagnostic(stdout, null, 1)).toContain("exact_url_traversalRoleMask=9");
  expect(installedMacAxActionSucceeded(stdout, "open")).toBe(false);
  for (const change of [
    { titleCategory: "/private/title" },
    { valueCategory: "/private/value" },
    { traversalRoleMask: 64 },
    { traversalRoleMask: -1 },
    { traversalDepth: 257 },
    { traversalDepth: 0.5 },
  ]) {
    expect(
      installedMacAxProbeDiagnostic(
        JSON.stringify({ ...observed, firstExactURL: { ...observed.firstExactURL, ...change } }),
        null,
        1,
      ),
    ).toBe("Native macOS AX probe: invalid_evidence");
  }
});

it("reports bounded actual-parent observations without granting directory or action proof", () => {
  const observed = {
    ...evidence,
    firstOtherAttribute: "AXParent",
    firstOtherStage: "parent_chain",
    firstOtherOrigin: "exact_url_parent_chain",
    parentChain: {
      status: "captured_sheet",
      visited: 8,
      selected: 1,
      unknownSelected: 4,
      roleMask: 15,
      nodes: Array.from({ length: 8 }, (_, index) => ({
        role: "AXGroup",
        selectedReference: index === 1,
        selectedState: index === 0 ? "true" : index < 4 ? "false" : "unknown",
      })),
    },
  };
  const stdout = JSON.stringify(observed);
  expect(installedMacAxProbeDiagnostic(stdout, null, 1)).toContain(
    "parent_chain_status=captured_sheet",
  );
  expect(installedMacAxProbeDiagnostic(stdout, null, 1)).toContain("parent_chain_selected=1");
  expect(installedMacAxActionSucceeded(stdout, "open")).toBe(false);
  for (const change of [
    { status: "/private/status" },
    { visited: 17 },
    { roleMask: 64 },
    { selected: 9 },
    { unknownSelected: 8 },
    { path: "/private/path" },
  ]) {
    expect(
      installedMacAxProbeDiagnostic(
        JSON.stringify({ ...observed, parentChain: { ...observed.parentChain, ...change } }),
        null,
        1,
      ),
    ).toBe("Native macOS AX probe: invalid_evidence");
  }
});

it("distinguishes absent and unreadable parent diagnostics without authorizing an action", () => {
  for (const status of ["missing_parent", "unreadable_parent"]) {
    const stdout = JSON.stringify({
      ...evidence,
      parentChain: { ...evidence.parentChain, status },
    });
    expect(installedMacAxProbeDiagnostic(stdout, null, 1)).toContain(
      `parent_chain_status=${status}`,
    );
    expect(installedMacAxActionSucceeded(stdout, "open")).toBe(false);
  }
});

it("keeps selected relationship membership independent of the AXSelected value", () => {
  const node = { role: "AXBrowser", selectedReference: true, selectedState: "unknown" };
  const parentChain = {
    status: "captured_sheet",
    visited: 1,
    selected: 0,
    unknownSelected: 1,
    roleMask: 1,
    nodes: [node],
  };
  const stdout = JSON.stringify({ ...evidence, parentChain });
  expect(installedMacAxProbeDiagnostic(stdout, null, 1)).toContain(
    "parent_chain_node_0_role=AXBrowser",
  );
  expect(installedMacAxProbeDiagnostic(stdout, null, 1)).toContain(
    "parent_chain_node_0_selected_reference=true",
  );
  expect(installedMacAxProbeDiagnostic(stdout, null, 1)).toContain(
    "parent_chain_node_0_selected_state=unknown",
  );
  expect(installedMacAxActionSucceeded(stdout, "open")).toBe(false);
  for (const change of [
    { nodes: [{ ...node, role: "/private/role" }] },
    { nodes: [{ ...node, selectedReference: "private" }] },
    { nodes: [{ ...node, selectedState: "private" }] },
    { nodes: [{ ...node, path: "/private/path" }] },
    { nodes: [] },
    { nodes: Array(17).fill(node) },
    { selected: 1 },
    { unknownSelected: 0 },
  ]) {
    expect(
      installedMacAxProbeDiagnostic(
        JSON.stringify({ ...evidence, parentChain: { ...parentChain, ...change } }),
        null,
        1,
      ),
    ).toBe("Native macOS AX probe: invalid_evidence");
  }
});

it("reports unattempted selected reads after an unreadable parent role", () => {
  const stdout = JSON.stringify({
    ...evidence,
    parentChain: {
      status: "unreadable_role",
      visited: 1,
      selected: 0,
      unknownSelected: 0,
      roleMask: 0,
      nodes: [{ role: "other", selectedReference: true, selectedState: "not_read" }],
    },
  });
  expect(installedMacAxProbeDiagnostic(stdout, null, 1)).toContain(
    "parent_chain_node_0_selected_state=not_read",
  );
});

it("keeps the maximum ancestor chain within the existing diagnostic byte limit", () => {
  const stdout = JSON.stringify({
    ...evidence,
    parentChain: {
      status: "bound",
      visited: 16,
      selected: 0,
      unknownSelected: 16,
      roleMask: 1,
      nodes: Array.from({ length: 16 }, () => ({
        role: "AXBrowser",
        selectedReference: false,
        selectedState: "unknown",
      })),
    },
  });
  expect(stdout.length).toBeLessThanOrEqual(4096);
  expect(installedMacAxProbeDiagnostic(stdout, null, 1)).toContain(
    "parent_chain_node_15_role=AXBrowser",
  );
});

it("reports selected-parent directory URL observations without granting action proof", () => {
  const observed = {
    fields: 8,
    uniqueUrls: 8,
    terminalUrls: 1,
    terminalMatches: 1,
    validShape: true,
  };
  const stdout = JSON.stringify({ ...evidence, selectedDirectory: observed });
  const diagnostic = installedMacAxProbeDiagnostic(stdout, null, 1);
  expect(diagnostic).toContain("selected_directory_fields=8");
  expect(diagnostic).toContain("selected_directory_terminalMatches=1");
  expect(diagnostic).toContain("selected_directory_validShape=true");
  expect(installedMacAxActionSucceeded(stdout, "open")).toBe(false);
  for (const change of [
    { fields: 257 },
    { fields: 7 },
    { uniqueUrls: 0 },
    { terminalUrls: 0 },
    { terminalMatches: 2 },
    { validShape: "private" },
    { path: "/private/path" },
    { fields: 0, uniqueUrls: 0, terminalUrls: 0, terminalMatches: 0 },
  ]) {
    expect(
      installedMacAxProbeDiagnostic(
        JSON.stringify({ ...evidence, selectedDirectory: { ...observed, ...change } }),
        null,
        1,
      ),
    ).toBe("Native macOS AX probe: invalid_evidence");
  }
});

const directorySnapshot = {
  ...evidence,
  trusted: true,
  complete: true,
  lastError: -25212,
  directoryVerified: true,
  foreground: true,
  guardMask: 255,
  stage: "directory_complete",
  verified: false,
  action: { requested: "directory_snapshot", pressed: false, dismissed: false },
  counts: {
    ...evidence.counts,
    windows: 1,
    sheets: 1,
    buttons: 1,
    saveButtons: 1,
    selectedRoots: 8,
    urlObjects: 8,
    exactUrls: 1,
  },
  selectedDirectory: {
    fields: 8,
    uniqueUrls: 8,
    terminalUrls: 1,
    terminalMatches: 1,
    validShape: true,
  },
  firstExactURL: {
    ...evidence.firstExactURL,
    role: "AXTextField",
    parentRole: "AXGroup",
    origin: "AXChildren",
    kind: "native",
    directory: true,
  },
  parentChain: {
    status: "captured_sheet",
    visited: 2,
    selected: 0,
    unknownSelected: 2,
    roleMask: 8,
    nodes: [
      { role: "AXGroup", selectedReference: true, selectedState: "unknown" },
      { role: "AXSheet", selectedReference: false, selectedState: "unknown" },
    ],
  },
};

it("requires independent native selected-directory proof and never accepts it as an Open action", () => {
  const stdout = JSON.stringify(directorySnapshot);
  expect(installedMacSelectedDirectoryVerified(stdout)).toBe(true);
  expect(installedMacAxActionSucceeded(stdout, "open")).toBe(false);
  expect(installedMacAxActionSucceeded(stdout, "cancel_open_existing")).toBe(false);
  expect(installedMacAxProbeDiagnostic(stdout, null, 1)).toContain("directory_verified=true");
});
it.each([
  { trusted: false },
  { complete: false },
  { directoryVerified: false },
  { foreground: false },
  { guardMask: 254 },
  { stage: "press" },
  { action: { requested: "directory_snapshot", pressed: true, dismissed: false } },
  { action: { requested: "none", pressed: false, dismissed: false } },
  { counts: { ...directorySnapshot.counts, selectedRoots: 9 } },
  { counts: { ...directorySnapshot.counts, urlStrings: 1 } },
  { counts: { ...directorySnapshot.counts, urlObjects: 7 } },
  { counts: { ...directorySnapshot.counts, windows: 2 } },
  { counts: { ...directorySnapshot.counts, saveButtons: 2 } },
  { counts: { ...directorySnapshot.counts, cannotComplete: 1 } },
  { counts: { ...directorySnapshot.counts, otherErrors: 1 } },
  { counts: { ...directorySnapshot.counts, apiDisabled: 1 } },
  { firstOtherError: -25202 },
  { firstOtherAttribute: "AXURL" },
  { selectedDirectory: { ...directorySnapshot.selectedDirectory, terminalMatches: 0 } },
  { selectedDirectory: { ...directorySnapshot.selectedDirectory, terminalUrls: 2 } },
  { selectedDirectory: { ...directorySnapshot.selectedDirectory, validShape: false } },
  { firstExactURL: { ...directorySnapshot.firstExactURL, kind: "string" } },
  { firstExactURL: { ...directorySnapshot.firstExactURL, directory: false } },
  { firstExactURL: { ...directorySnapshot.firstExactURL, origin: "AXSelectedChildren" } },
  { parentChain: { ...directorySnapshot.parentChain, status: "bound" } },
  {
    parentChain: {
      ...directorySnapshot.parentChain,
      nodes: [
        { role: "AXGroup", selectedReference: false, selectedState: "unknown" },
        directorySnapshot.parentChain.nodes[1],
      ],
    },
  },
  {
    parentChain: {
      ...directorySnapshot.parentChain,
      nodes: [
        directorySnapshot.parentChain.nodes[0],
        { role: "AXGroup", selectedReference: false, selectedState: "unknown" },
      ],
    },
  },
  { path: "/private/path" },
])("refuses incomplete, ambiguous or action-bearing directory evidence %j", (change) => {
  expect(
    installedMacSelectedDirectoryVerified(JSON.stringify({ ...directorySnapshot, ...change })),
  ).toBe(false);
});
it("refuses malformed or oversized selected-directory evidence", () => {
  for (const input of ["private", "x".repeat(4097), JSON.stringify(evidence)])
    expect(installedMacSelectedDirectoryVerified(input)).toBe(false);
});

it("reports bounded invalid-child parent observations without authorizing an action", () => {
  const parent = {
    status: "complete",
    role: "AXScrollArea",
    pidMatches: true,
    selectedReference: false,
    children: 5,
    containsFailedReference: "false",
    attribute: "none",
    error: 0,
  };
  const stdout = JSON.stringify({ ...evidence, invalidChildParent: parent });
  expect(installedMacAxProbeDiagnostic(stdout, null, 1)).toContain(
    "invalid_child_parent_containsFailedReference=false",
  );
  expect(installedMacAxActionSucceeded(stdout, "open")).toBe(false);
  for (const change of [
    { status: "/private/status" },
    { role: "/private/role" },
    { pidMatches: "private" },
    { children: 258 },
    { containsFailedReference: "/private/reference" },
    { attribute: "/private/attribute" },
    { error: -32769 },
    { path: "/private/path" },
  ])
    expect(
      installedMacAxProbeDiagnostic(
        JSON.stringify({ ...evidence, invalidChildParent: { ...parent, ...change } }),
        null,
        1,
      ),
    ).toBe("Native macOS AX probe: invalid_evidence");
});

const vanished = {
  ...evidence,
  trusted: true,
  complete: false,
  firstOtherVisited: 52,
  firstOtherError: -25202,
  firstOtherAttribute: "AXRole",
  firstOtherStage: "selection",
  firstOtherOrigin: "AXChildren",
  firstOtherParentRole: "AXScrollArea",
  action: { requested: "open", pressed: false, dismissed: false },
  invalidChildParent: {
    status: "complete",
    role: "AXScrollArea",
    pidMatches: true,
    selectedReference: false,
    children: 14,
    containsFailedReference: "false",
    attribute: "none",
    error: 0,
  },
  staleSnapshot: {
    eligible: true,
    traversalComplete: true,
    candidates: 2,
    allVanished: true,
    onlyInvalidChildErrors: true,
  },
  counts: {
    ...evidence.counts,
    windows: 1,
    sheets: 1,
    buttons: 1,
    visited: 110,
    selectedRoots: 9,
    otherErrors: 16,
    selectedLeaves: 1,
    leafMatches: 1,
    selectedExactUrls: 1,
  },
};
it("permits only a new snapshot and never accepts a stale snapshot as an action", () => {
  const stdout = JSON.stringify(vanished);
  expect(installedMacAxSnapshotRefreshAllowed(stdout, "open")).toBe(true);
  expect(installedMacAxSnapshotRefreshAllowed(stdout, "cancel_open_existing")).toBe(false);
  expect(installedMacAxActionSucceeded(stdout, "open")).toBe(false);
});
it.each([
  { trusted: false },
  { complete: true },
  { verified: true },
  { directoryVerified: true },
  { stage: "press" },
  { guardMask: 255 },
  { pressDurationMs: 1 },
  { pressSheetState: "invalid_sheet" },
  { action: { requested: "open", pressed: true, dismissed: false } },
  { action: { requested: "open", pressed: false, dismissed: true } },
  { action: { requested: "none", pressed: false, dismissed: false } },
  { firstOtherError: -25204 },
  { firstOtherSelectedReference: true },
  { firstOtherSelectedBranch: true },
  { firstOtherOrigin: "AXSelectedChildren" },
  { firstOtherParentRole: "AXGroup" },
  { staleSnapshot: { ...vanished.staleSnapshot, candidates: 0 } },
  { staleSnapshot: { ...vanished.staleSnapshot, traversalComplete: false } },
  { counts: { ...vanished.counts, visited: 257 } },
  { firstOtherVisited: 0 },
  { staleSnapshot: { ...vanished.staleSnapshot, allVanished: false } },
  { staleSnapshot: { ...vanished.staleSnapshot, onlyInvalidChildErrors: false } },
  { staleSnapshot: { ...vanished.staleSnapshot, eligible: false } },
  { invalidChildParent: { ...vanished.invalidChildParent, containsFailedReference: "true" } },
  { invalidChildParent: { ...vanished.invalidChildParent, containsFailedReference: "unknown" } },
  { invalidChildParent: { ...vanished.invalidChildParent, status: "error" } },
  { invalidChildParent: { ...vanished.invalidChildParent, selectedReference: true } },
  { invalidChildParent: { ...vanished.invalidChildParent, pidMatches: false } },
  { counts: { ...vanished.counts, cannotComplete: 1 } },
  { counts: { ...vanished.counts, apiDisabled: 1 } },
  { counts: { ...vanished.counts, selectedLeaves: 2 } },
  { counts: { ...vanished.counts, leafMatches: 0 } },
  { counts: { ...vanished.counts, buttons: 2 } },
  { counts: { ...vanished.counts, otherErrors: 0 } },
  { staleSnapshot: { ...vanished.staleSnapshot, candidates: 257 } },
  { privatePath: "/private/path" },
])(
  "refuses snapshot refresh for live, selected, unverified or action-bearing evidence %j",
  (change) => {
    expect(
      installedMacAxSnapshotRefreshAllowed(JSON.stringify({ ...vanished, ...change }), "open"),
    ).toBe(false);
  },
);

const saveTargetObservation = {
  status: "complete",
  fields: 3,
  valueMatches: 1,
  enabledMatches: 1,
  labelMatches: 1,
  descriptionMatches: 1,
  linkedLabelMatches: 1,
  linkedLabelRole: "static_text",
  error: 0,
  attribute: "none",
};
it("reports fixed Save candidate context without authorizing a native action", () => {
  const output = JSON.stringify({ ...evidence, saveTargetContext: saveTargetObservation });
  expect(installedMacAxProbeDiagnostic(output, null, 5)).toContain("save_target_valueMatches=1");
  expect(installedMacAxActionSucceeded(output, "open")).toBe(false);
  expect(installedMacSelectedDirectoryVerified(output)).toBe(false);
});
it.each([
  { fields: 257 },
  { valueMatches: 4 },
  { enabledMatches: 2 },
  { labelMatches: 2 },
  { descriptionMatches: 2 },
  { linkedLabelMatches: 2 },
  { linkedLabelRole: "/private/label" },
  { status: "/private/status" },
  { attribute: "/private/attribute" },
  { rawValue: "/private/filename" },
])("refuses malformed or private Save context %j", (change) => {
  const output = JSON.stringify({
    ...evidence,
    saveTargetContext: { ...saveTargetObservation, ...change },
  });
  expect(installedMacAxProbeDiagnostic(output, null, 5)).toBe(
    "Native macOS AX probe: invalid_evidence",
  );
});

it("retains fixed linked-label PID failure evidence without a raw identifier", () => {
  const output = JSON.stringify({
    ...evidence,
    saveTargetContext: {
      ...saveTargetObservation,
      status: "error",
      error: -25202,
      attribute: "pid",
    },
  });
  const diagnostic = installedMacAxProbeDiagnostic(output, null, 5);
  expect(diagnostic).toContain("save_target_attribute=pid");
  expect(diagnostic).toContain("save_target_error=-25202");
  expect(installedMacAxActionSucceeded(output, "open")).toBe(false);
});

const filenameProof = {
  status: "complete",
  fields: 11,
  matches: 1,
  absentValues: 1,
  enabled: true,
  labelMatched: true,
  fieldAttached: true,
  labelAttached: true,
  visited: 4,
  verified: true,
  error: 0,
  attribute: "none",
};
it("requires independent filename/linked-label attachment evidence without authorizing Open", () => {
  const output = JSON.stringify({ ...directorySnapshot, saveFilename: filenameProof });
  expect(installedMacSaveFilenameVerified(output)).toBe(true);
  expect(installedMacAxActionSucceeded(output, "open")).toBe(false);
  expect(installedMacSaveFilenameVerified(JSON.stringify(directorySnapshot))).toBe(false);
});
it.each([
  { status: "deadline" },
  { status: "error" },
  { fields: 0 },
  { matches: 0 },
  { matches: 2 },
  { absentValues: -1 },
  { absentValues: 11 },
  { enabled: false },
  { labelMatched: false },
  { fieldAttached: false },
  { labelAttached: false },
  { visited: 0 },
  { visited: 33 },
  { verified: false },
  { error: -25202 },
  { attribute: "pid" },
  { path: "/private/value" },
])("rejects incomplete, ambiguous or private filename proof %j", (change) => {
  const output = JSON.stringify({
    ...directorySnapshot,
    saveFilename: { ...filenameProof, ...change },
  });
  expect(installedMacSaveFilenameVerified(output)).toBe(false);
});
it("rejects filename proof when the selected-directory guard is absent", () => {
  expect(
    installedMacSaveFilenameVerified(
      JSON.stringify({ ...directorySnapshot, guardMask: 254, saveFilename: filenameProof }),
    ),
  ).toBe(false);
});

const jsonSave = {
  ...directorySnapshot,
  lastError: 0,
  saveFilename: filenameProof,
  saveTargetAbsent: true,
  stage: "complete",
  action: { requested: "save_new_json", pressed: true, dismissed: true },
};
it("requires fresh directory, filename, absent-target and completed native Save evidence", () => {
  expect(installedMacJsonSaveSucceeded(JSON.stringify(jsonSave))).toBe(true);
  expect(installedMacSelectedDirectoryVerified(JSON.stringify(jsonSave))).toBe(false);
  expect(installedMacAxActionSucceeded(JSON.stringify(jsonSave), "open")).toBe(false);
  expect(
    installedMacJsonSaveSucceeded(
      JSON.stringify({ ...directorySnapshot, saveFilename: filenameProof }),
    ),
  ).toBe(false);
});
it.each([
  { saveTargetAbsent: false },
  { guardMask: 254 },
  { directoryVerified: false },
  { foreground: false },
  { complete: false },
  { lastError: -25204 },
  { stage: "press" },
  { action: { requested: "save_new_json", pressed: false, dismissed: true } },
  { action: { requested: "save_new_json", pressed: true, dismissed: false } },
  { saveFilename: { ...filenameProof, labelAttached: false } },
  { saveFilename: { ...filenameProof, matches: 2 } },
])("refuses incomplete native JSON Save evidence %j", (change) => {
  expect(installedMacJsonSaveSucceeded(JSON.stringify({ ...jsonSave, ...change }))).toBe(false);
});

it.each(["lrc", "chordpro"] as const)(
  "accepts only the requested text Save format %s with all original proof requirements",
  (format) => {
    const output = JSON.stringify({
      ...jsonSave,
      action: { requested: `save_new_${format}`, pressed: true, dismissed: true },
    });
    expect(installedMacTextSaveSucceeded(output, format)).toBe(true);
    expect(installedMacJsonSaveSucceeded(output)).toBe(false);
    expect(installedMacTextSaveSucceeded(output, format === "lrc" ? "chordpro" : "lrc")).toBe(
      false,
    );
    expect(
      installedMacTextSaveSucceeded(
        JSON.stringify({
          ...jsonSave,
          saveTargetAbsent: false,
          action: { requested: `save_new_${format}`, pressed: true, dismissed: true },
        }),
        format,
      ),
    ).toBe(false);
  },
);

const pdfSave = {
  ...jsonSave,
  action: { requested: "save_new_pdf", pressed: true, dismissed: true },
};
it("accepts PDF Save only with the same directory, filename, guard and absent-target proofs", () => {
  const output = JSON.stringify(pdfSave);
  expect(installedMacPdfSaveSucceeded(output)).toBe(true);
  expect(installedMacJsonSaveSucceeded(output)).toBe(false);
  expect(installedMacTextSaveSucceeded(output, "lrc")).toBe(false);
  expect(installedMacAxActionSucceeded(output, "open")).toBe(false);
  expect(installedMacPdfSaveSucceeded(JSON.stringify(jsonSave))).toBe(false);
});
it.each([
  { saveTargetAbsent: false },
  { guardMask: 254 },
  { directoryVerified: false },
  { foreground: false },
  { complete: false },
  { lastError: -25204 },
  { stage: "press" },
  { action: { requested: "save_new_pdf", pressed: false, dismissed: true } },
  { action: { requested: "save_new_pdf", pressed: true, dismissed: false } },
  { saveFilename: { ...filenameProof, labelAttached: false } },
  { saveFilename: { ...filenameProof, fieldAttached: false } },
  { saveFilename: { ...filenameProof, matches: 2 } },
])("refuses incomplete PDF Save evidence %j", (change) => {
  expect(installedMacPdfSaveSucceeded(JSON.stringify({ ...pdfSave, ...change }))).toBe(false);
});

const archiveSave = {
  ...jsonSave,
  action: { requested: "save_new_archive", pressed: true, dismissed: true },
};
it("accepts archive Save only with all independent native proofs", () => {
  const output = JSON.stringify(archiveSave);
  expect(installedMacArchiveSaveSucceeded(output)).toBe(true);
  expect(installedMacJsonSaveSucceeded(output)).toBe(false);
  expect(installedMacPdfSaveSucceeded(output)).toBe(false);
  expect(installedMacTextSaveSucceeded(output, "lrc")).toBe(false);
  expect(installedMacAxActionSucceeded(output, "open")).toBe(false);
  expect(installedMacArchiveSaveSucceeded(JSON.stringify(pdfSave))).toBe(false);
});
it.each([
  { saveTargetAbsent: false },
  { guardMask: 254 },
  { directoryVerified: false },
  { foreground: false },
  { complete: false },
  { lastError: -25204 },
  { stage: "press" },
  { action: { requested: "save_new_archive", pressed: false, dismissed: true } },
  { action: { requested: "save_new_archive", pressed: true, dismissed: false } },
  { saveFilename: { ...filenameProof, labelAttached: false } },
  { saveFilename: { ...filenameProof, fieldAttached: false } },
  { saveFilename: { ...filenameProof, matches: 2 } },
])("refuses incomplete archive Save evidence %j", (change) => {
  expect(installedMacArchiveSaveSucceeded(JSON.stringify({ ...archiveSave, ...change }))).toBe(
    false,
  );
});

const replacementObservation = {
  ...directorySnapshot,
  lastError: 0,
  saveFilename: filenameProof,
  saveTargetExistingFixture: true,
  saveTargetAbsent: false,
  stage: "replace_observed",
  action: { requested: "observe_replace_json", pressed: true, dismissed: false },
  replaceContext: {
    status: "complete",
    visited: 20,
    windows: 1,
    sheets: 2,
    dialogs: 0,
    buttons: 4,
    cancel: 2,
    replace: 1,
    save: 1,
    other: 14,
    foreground: true,
    error: 0,
    modalCandidates: 1,
    modalStatus: "complete",
    modalError: 0,
    modalVisited: 6,
    modalButtons: 2,
    modalCancel: 1,
    modalReplace: 1,
    modalEnabledCancel: 1,
    modalEnabledReplace: 1,
    modalBindingStatus: "complete",
    modalBindingParent: "sheet",
    modalBindingMatches: 1,
    modalBindingSheetAttached: true,
    modalBindingForeground: true,
    modalBindingError: 0,
    modalBindingAttribute: "none",
  },
};
it("accepts only bounded replacement observation and never reports a completed Save", () => {
  const output = JSON.stringify(replacementObservation);
  expect(installedMacReplaceContextObserved(output)).toBe(true);
  expect(installedMacJsonSaveSucceeded(output)).toBe(false);
  expect(installedMacAxProbeDiagnostic(output, null, 1)).toContain("replace_context_replace=1");
});
it.each([
  { saveTargetExistingFixture: false },
  { saveTargetAbsent: true },
  { guardMask: 254 },
  { directoryVerified: false },
  { saveFilename: { ...filenameProof, labelAttached: false } },
  { action: { requested: "observe_replace_json", pressed: false, dismissed: false } },
  { action: { requested: "observe_replace_json", pressed: true, dismissed: true } },
  { replaceContext: { ...replacementObservation.replaceContext, status: "deadline" } },
  { replaceContext: { ...replacementObservation.replaceContext, foreground: false } },
  { replaceContext: { ...replacementObservation.replaceContext, windows: 0 } },
  { replaceContext: { ...replacementObservation.replaceContext, visited: 257 } },
  { replaceContext: { ...replacementObservation.replaceContext, error: -25202 } },
  {
    replaceContext: {
      ...replacementObservation.replaceContext,
      title: "private existing native export target fixture",
    },
  },
  { replaceContext: { ...replacementObservation.replaceContext, status: "/private/path" } },
])("refuses incomplete or private replacement context %j", (change) => {
  const output = JSON.stringify({ ...replacementObservation, ...change });
  expect(installedMacReplaceContextObserved(output)).toBe(false);
});

it.each([
  { ...replacementObservation.replaceContext, title: "private fixture" },
  { ...replacementObservation.replaceContext, status: "/private/path" },
  { ...replacementObservation.replaceContext, url: "https://private.invalid/token" },
])("redacts invalid private replacement observations", (replaceContext) => {
  expect(
    installedMacAxProbeDiagnostic(
      JSON.stringify({ ...replacementObservation, replaceContext }),
      null,
      1,
    ),
  ).toBe("Native macOS AX probe: invalid_evidence");
});

it("retains failed Save refusal even when replacement context was observed", () => {
  const output = JSON.stringify({
    ...replacementObservation,
    lastError: -25205,
    stage: "press",
    pressDurationMs: 90,
    pressSheetState: "attached_sheet",
    action: { requested: "observe_replace_json", pressed: false, dismissed: false },
  });
  expect(installedMacReplaceContextObserved(output)).toBe(false);
  const diagnostic = installedMacAxProbeDiagnostic(output, null, 100);
  expect(diagnostic).toContain("last_error=-25205");
  expect(diagnostic).toContain("replace_context_status=complete");
  expect(diagnostic).toContain("replace_context_replace=1");
  expect(diagnostic).toContain("pressed=false");
});

it.each([
  { attribute: "pid", role: "unknown", parentRole: "sheet", pidState: "foreign" },
  { attribute: "AXTitle", role: "button", parentRole: "other", pidState: "same" },
])(
  "distinguishes first replacement read failure categories without accepting the failed action %j",
  (firstFailure) => {
    const output = JSON.stringify({
      ...replacementObservation,
      lastError: -25205,
      stage: "press",
      action: { requested: "observe_replace_json", pressed: false, dismissed: false },
      replaceContext: {
        ...replacementObservation.replaceContext,
        status: "error",
        error: -25201,
        ...firstFailure,
        saveActionStatus: "success",
        savePressAction: "present",
        saveActionError: 0,
      },
    });
    expect(installedMacReplaceContextObserved(output)).toBe(false);
    const diagnostic = installedMacAxProbeDiagnostic(output, null, 100);
    expect(diagnostic).toContain(`replace_context_attribute=${firstFailure.attribute}`);
    expect(diagnostic).toContain(`replace_context_role=${firstFailure.role}`);
    expect(diagnostic).toContain(`replace_context_parentRole=${firstFailure.parentRole}`);
    expect(diagnostic).toContain(`replace_context_pidState=${firstFailure.pidState}`);
    expect(diagnostic).toContain("replace_context_savePressAction=present");
    expect(diagnostic).toContain("last_error=-25205");
  },
);
it.each([
  { attribute: "/private/path" },
  { role: "private title" },
  { parentRole: "https://private.invalid/token" },
  { pidState: "42" },
  { saveActionStatus: "private" },
  { savePressAction: "private" },
  { saveActionError: 32768 },
])("redacts unbounded or private replacement failure detail %j", (change) => {
  const output = JSON.stringify({
    ...replacementObservation,
    replaceContext: { ...replacementObservation.replaceContext, ...change },
  });
  expect(installedMacAxProbeDiagnostic(output, null, 100)).toBe(
    "Native macOS AX probe: invalid_evidence",
  );
  expect(installedMacReplaceContextObserved(output)).toBe(false);
});

it("preserves replacement diagnostics and acceptance through the scoped 8 KiB boundary", () => {
  const raw = JSON.stringify(replacementObservation);
  expect(raw.length).toBeLessThan(4096);
  for (const size of [4097, 4878, 8192]) {
    const output = raw.padEnd(size, " ");
    expect(installedMacReplaceContextObserved(output)).toBe(true);
    expect(installedMacAxProbeDiagnostic(output, null, 1)).toContain("action=observe_replace_json");
    expect(installedMacJsonSaveSucceeded(output)).toBe(false);
  }
  const oversized = raw.padEnd(8193, " ");
  expect(installedMacReplaceContextObserved(oversized)).toBe(false);
  expect(installedMacAxProbeDiagnostic(oversized, null, 1)).toBe(
    "Native macOS AX probe: invalid_evidence",
  );
});
it("retains the 4 KiB diagnostic limit for ordinary Save and snapshot evidence", () => {
  for (const ordinaryEvidence of [directorySnapshot, jsonSave]) {
    const output = JSON.stringify(ordinaryEvidence).padEnd(4097, " ");
    expect(installedMacAxProbeDiagnostic(output, null, 1)).toBe(
      "Native macOS AX probe: invalid_evidence",
    );
  }
});
it("still rejects private evidence inside the larger replacement limit", () => {
  const output = JSON.stringify({ ...replacementObservation, privatePath: "/private/path" }).padEnd(
    4878,
    " ",
  );
  expect(installedMacReplaceContextObserved(output)).toBe(false);
  expect(installedMacAxProbeDiagnostic(output, null, 1)).toBe(
    "Native macOS AX probe: invalid_evidence",
  );
});

it("accepts a bounded 16-node replacement ancestry without truncating diagnostic evidence", () => {
  const originalNodes = replacementObservation.parentChain.nodes;
  const output = JSON.stringify({
    ...replacementObservation,
    firstFailureParent: replacementObservation.invalidChildParent,
    saveTargetContext: {
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
    },
    parentChain: {
      ...replacementObservation.parentChain,
      visited: 16,
      unknownSelected: 16,
      nodes: [
        originalNodes[0],
        ...Array.from({ length: 14 }, () => ({
          role: "AXGroup",
          selectedReference: false,
          selectedState: "unknown",
        })),
        originalNodes.at(-1),
      ],
    },
    replaceContext: {
      ...replacementObservation.replaceContext,
      attribute: "none",
      role: "unknown",
      parentRole: "none",
      pidState: "not_checked",
      saveActionStatus: "success",
      savePressAction: "present",
      saveActionError: 0,
    },
  });
  expect(output.length).toBeGreaterThan(4096);
  expect(output.length).toBeLessThanOrEqual(8192);
  expect(installedMacReplaceContextObserved(output)).toBe(true);
  expect(installedMacAxProbeDiagnostic(output, null, 1)).toContain(
    "parent_chain_node_15_role=AXSheet",
  );
});

it.each(["web_area", "button", "other", "unavailable"])(
  "retains foreign-PID refusal while categorizing its diagnostic role as %s",
  (foreignRole) => {
    const output = JSON.stringify({
      ...replacementObservation,
      lastError: -25205,
      stage: "press",
      action: { requested: "observe_replace_json", pressed: false, dismissed: false },
      replaceContext: {
        ...replacementObservation.replaceContext,
        status: "error",
        error: -25201,
        attribute: "pid",
        role: "unknown",
        parentRole: "other",
        pidState: "foreign",
        foreignRole,
        foreignRoleError: foreignRole === "unavailable" ? -25202 : 0,
      },
    });
    expect(installedMacReplaceContextObserved(output)).toBe(false);
    const diagnostic = installedMacAxProbeDiagnostic(output, null, 100);
    expect(diagnostic).toContain("replace_context_pidState=foreign");
    expect(diagnostic).toContain(`replace_context_foreignRole=${foreignRole}`);
    expect(diagnostic).toContain("replace_context_error=-25201");
    expect(diagnostic).toContain("last_error=-25205");
  },
);
it.each([{ foreignRole: "/private/path" }, { foreignRoleError: 32768 }, { foreignPid: 1234 }])(
  "rejects private or unbounded foreign-node details %j",
  (change) => {
    const output = JSON.stringify({
      ...replacementObservation,
      replaceContext: { ...replacementObservation.replaceContext, ...change },
    });
    expect(installedMacAxProbeDiagnostic(output, null, 1)).toBe(
      "Native macOS AX probe: invalid_evidence",
    );
    expect(installedMacReplaceContextObserved(output)).toBe(false);
  },
);

it.each([
  { foreignRole: "static_text", parentRole: "group", sheetBranch: true },
  { foreignRole: "scroll_area", parentRole: "split_group", sheetBranch: false },
])(
  "records fixed foreign-node role and captured-sheet encounter categories without accepting it %j",
  (detail) => {
    const output = JSON.stringify({
      ...replacementObservation,
      lastError: -25205,
      stage: "press",
      action: { requested: "observe_replace_json", pressed: false, dismissed: false },
      replaceContext: {
        ...replacementObservation.replaceContext,
        status: "error",
        error: -25201,
        attribute: "pid",
        role: "unknown",
        pidState: "foreign",
        foreignRoleError: 0,
        ...detail,
      },
    });
    expect(installedMacReplaceContextObserved(output)).toBe(false);
    const diagnostic = installedMacAxProbeDiagnostic(output, null, 1);
    expect(diagnostic).toContain(`replace_context_foreignRole=${detail.foreignRole}`);
    expect(diagnostic).toContain(`replace_context_parentRole=${detail.parentRole}`);
    expect(diagnostic).toContain(`replace_context_sheetBranch=${detail.sheetBranch}`);
    expect(diagnostic).toContain("last_error=-25205");
  },
);
it.each([
  { foreignRole: "private title" },
  { parentRole: "/private/path" },
  { sheetBranch: "private" },
])("rejects private role or invalid captured-sheet detail %j", (detail) => {
  const output = JSON.stringify({
    ...replacementObservation,
    replaceContext: { ...replacementObservation.replaceContext, ...detail },
  });
  expect(installedMacAxProbeDiagnostic(output, null, 1)).toBe(
    "Native macOS AX probe: invalid_evidence",
  );
  expect(installedMacReplaceContextObserved(output)).toBe(false);
});

it.each([
  {
    foreignChildrenStatus: "complete",
    foreignChildren: 0,
    modalStatus: "complete",
    modalCancel: 1,
    modalReplace: 1,
    modalEnabledCancel: 1,
    modalEnabledReplace: 1,
  },
  {
    foreignChildrenStatus: "unsupported",
    foreignChildren: 0,
    modalStatus: "error",
    modalError: -25201,
    modalAttribute: "pid",
  },
  {
    foreignChildrenStatus: "complete",
    foreignChildren: 1,
    modalStatus: "ambiguous",
    modalCandidates: 2,
  },
])(
  "keeps the original failure fatal while retaining independent leaf/modal observations %j",
  (observation) => {
    const output = JSON.stringify({
      ...replacementObservation,
      lastError: -25205,
      stage: "press",
      action: { requested: "observe_replace_json", pressed: false, dismissed: false },
      replaceContext: {
        ...replacementObservation.replaceContext,
        status: "error",
        error: -25201,
        attribute: "pid",
        pidState: "foreign",
        foreignRole: "splitter",
        foreignRoleError: 0,
        foreignChildrenError: 0,
        modalCandidates: 1,
        modalVisited: 8,
        modalButtons: 2,
        modalError: 0,
        modalAttribute: "none",
        modalRole: "unknown",
        ...observation,
      },
    });
    expect(installedMacReplaceContextObserved(output)).toBe(false);
    const diagnostic = installedMacAxProbeDiagnostic(output, null, 1);
    expect(diagnostic).toContain(
      `replace_context_foreignChildrenStatus=${observation.foreignChildrenStatus}`,
    );
    expect(diagnostic).toContain(`replace_context_modalStatus=${observation.modalStatus}`);
    expect(diagnostic).toContain("replace_context_pidState=foreign");
    expect(diagnostic).toContain("last_error=-25205");
  },
);
it.each([
  { foreignChildren: 258 },
  { foreignChildrenStatus: "private" },
  { foreignChildrenError: -32769 },
  { modalVisited: 65 },
  { modalEnabledReplace: 65 },
  { modalRole: "private title" },
  { modalAttribute: "/private/path" },
  { modalTitle: "private text" },
])("rejects unbounded or private independent observations %j", (observation) => {
  const output = JSON.stringify({
    ...replacementObservation,
    replaceContext: { ...replacementObservation.replaceContext, ...observation },
  });
  expect(installedMacAxProbeDiagnostic(output, null, 1)).toBe(
    "Native macOS AX probe: invalid_evidence",
  );
  expect(installedMacReplaceContextObserved(output)).toBe(false);
});

it.each([
  {
    pressTimeoutError: 0,
    pressActionCalled: true,
    attachmentStatus: "complete",
    attachmentAttempts: 3,
    attachmentCandidates: 1,
  },
  {
    pressTimeoutError: -25205,
    pressActionCalled: false,
    attachmentStatus: "absent",
    attachmentAttempts: 32,
    attachmentCandidates: 0,
  },
  {
    pressTimeoutError: 0,
    pressActionCalled: true,
    attachmentStatus: "error",
    attachmentAttempts: 1,
    attachmentCandidates: 0,
  },
])(
  "retains the original Save refusal while reporting dispatch and bounded attachment diagnostics %j",
  ({ pressTimeoutError, pressActionCalled, ...attachment }) => {
    const output = JSON.stringify({
      ...replacementObservation,
      lastError: -25205,
      stage: "press",
      pressTimeoutError,
      pressActionCalled,
      action: { requested: "observe_replace_json", pressed: false, dismissed: false },
      replaceContext: {
        ...replacementObservation.replaceContext,
        status: "error",
        error: -25201,
        attribute: "pid",
        pidState: "foreign",
        foreignRole: "splitter",
        sheetBranch: true,
        attachmentVisited: 48,
        attachmentError: 0,
        attachmentAttribute: "none",
        attachmentSource: "none",
        capturedSheetAttached: true,
        modalStatus: "complete",
        modalCancel: 1,
        modalReplace: 1,
        ...attachment,
      },
    });
    expect(installedMacReplaceContextObserved(output)).toBe(false);
    const diagnostic = installedMacAxProbeDiagnostic(output, null, 1);
    expect(diagnostic).toContain(`press_timeout_error=${pressTimeoutError}`);
    expect(diagnostic).toContain(`press_action_called=${pressActionCalled}`);
    expect(diagnostic).toContain(`replace_context_attachmentStatus=${attachment.attachmentStatus}`);
    expect(diagnostic).toContain("last_error=-25205");
  },
);
it.each([
  { attachmentAttempts: 33 },
  { attachmentVisited: 257 },
  { attachmentCandidates: 129 },
  { attachmentSource: "/private/path" },
  { attachmentAttribute: "private" },
  { attachmentError: 32768 },
  { capturedSheetAttached: "private" },
])("rejects private or unbounded attachment evidence %j", (attachment) => {
  const output = JSON.stringify({
    ...replacementObservation,
    replaceContext: { ...replacementObservation.replaceContext, ...attachment },
  });
  expect(installedMacAxProbeDiagnostic(output, null, 1)).toBe(
    "Native macOS AX probe: invalid_evidence",
  );
});
it.each([{ pressTimeoutError: 32768 }, { pressActionCalled: "private" }])(
  "rejects private or unbounded dispatch detail %j",
  (detail) => {
    expect(
      installedMacAxProbeDiagnostic(
        JSON.stringify({ ...replacementObservation, ...detail }),
        null,
        1,
      ),
    ).toBe("Native macOS AX probe: invalid_evidence");
  },
);

it.each(["sheet", "parent", "other", "unknown"])(
  "reports fresh modal attachment evidence without overriding the original refusal (%s)",
  (modalBindingParent) => {
    const output = JSON.stringify({
      ...replacementObservation,
      lastError: -25205,
      stage: "press",
      action: { requested: "observe_replace_json", pressed: false, dismissed: false },
      replaceContext: {
        ...replacementObservation.replaceContext,
        status: "error",
        error: -25201,
        modalStatus: "complete",
        modalBindingStatus: modalBindingParent === "other" ? "invalid_candidate" : "complete",
        modalBindingParent,
        modalBindingMatches: 1,
        modalBindingSheetAttached: true,
        modalBindingForeground: true,
        modalBindingError: 0,
        modalBindingAttribute: "none",
      },
    });
    expect(installedMacReplaceContextObserved(output)).toBe(false);
    const diagnostic = installedMacAxProbeDiagnostic(output, null, 1);
    expect(diagnostic).toContain(`replace_context_modalBindingParent=${modalBindingParent}`);
    expect(diagnostic).toContain("replace_context_modalBindingMatches=1");
    expect(diagnostic).toContain("last_error=-25205");
  },
);
it.each([
  { modalBindingStatus: "private" },
  { modalBindingParent: "/private/path" },
  { modalBindingMatches: 65 },
  { modalBindingMatches: -1 },
  { modalBindingSheetAttached: "private" },
  { modalBindingForeground: "private" },
  { modalBindingError: 32768 },
  { modalBindingAttribute: "private" },
])("rejects private or unbounded modal binding detail %j", (detail) => {
  const output = JSON.stringify({
    ...replacementObservation,
    replaceContext: { ...replacementObservation.replaceContext, ...detail },
  });
  expect(installedMacAxProbeDiagnostic(output, null, 1)).toBe(
    "Native macOS AX probe: invalid_evidence",
  );
});

const boundModalObservation = {
  ...replacementObservation,
  lastError: -25205,
  stage: "press",
  pressTimeoutError: 0,
  pressActionCalled: true,
  pressSheetState: "attached_sheet",
  pressFollowupError: 0,
  action: { requested: "observe_replace_json", pressed: false, dismissed: false },
  replaceContext: {
    ...replacementObservation.replaceContext,
    status: "error",
    error: -25201,
    attribute: "pid",
    pidState: "foreign",
    parentRole: "split_group",
    sheetBranch: true,
    foreignRole: "splitter",
    foreignRoleError: 0,
    foreignChildren: 0,
    foreignChildrenStatus: "absent",
    foreignChildrenError: -25212,
    modalCandidates: 1,
    modalStatus: "complete",
    modalError: 0,
    modalVisited: 6,
    modalAttribute: "none",
    saveActionStatus: "success",
    savePressAction: "present",
    saveActionError: 0,
    modalButtons: 2,
    modalCancel: 1,
    modalReplace: 1,
    modalEnabledCancel: 1,
    modalEnabledReplace: 1,
    modalBindingStatus: "complete",
    modalBindingParent: "sheet",
    modalBindingMatches: 1,
    modalBindingSheetAttached: true,
    modalBindingForeground: true,
    modalBindingError: 0,
    modalBindingAttribute: "none",
  },
};
it("accepts independently bound modal observation while retaining the refused action", () => {
  const output = JSON.stringify(boundModalObservation);
  expect(installedMacReplaceContextObserved(output)).toBe(true);
  expect(installedMacJsonSaveSucceeded(output)).toBe(false);
  const diagnostic = installedMacAxProbeDiagnostic(output, null, 1);
  expect(diagnostic).toContain("last_error=-25205");
  expect(diagnostic).toContain("pressed=false");
  expect(diagnostic).toContain("replace_context_error=-25201");
});
it.each([
  { modalBindingStatus: "deadline" },
  { modalBindingParent: "parent" },
  { modalBindingParent: "other" },
  { modalBindingMatches: 0 },
  { modalBindingMatches: 2 },
  { modalBindingSheetAttached: false },
  { modalBindingForeground: false },
  { modalBindingError: -25202 },
  { modalBindingAttribute: "AXParent" },
  { modalStatus: "error" },
  { modalError: -25202 },
  { modalVisited: 0 },
  { modalButtons: 3 },
  { modalCancel: 0 },
  { modalReplace: 2 },
  { modalEnabledCancel: 0 },
  { modalEnabledReplace: 0 },
  { modalCandidates: 2 },
  { modalCandidates: 0 },
  { foreignRole: "other" },
  { pidState: "same" },
  { parentRole: "group" },
  { sheetBranch: false },
  { foreignRoleError: -25202 },
  { foreignChildren: 1 },
  { foreignChildrenStatus: "complete" },
  { foreignChildrenError: 0 },
  { status: "deadline" },
  { error: -25202 },
  { attribute: "AXChildren" },
  { windows: 2 },
  { foreground: false },
])("refuses incomplete or different independent modal evidence %j", (change) => {
  expect(
    installedMacReplaceContextObserved(
      JSON.stringify({
        ...boundModalObservation,
        replaceContext: { ...boundModalObservation.replaceContext, ...change },
      }),
    ),
  ).toBe(false);
});
it.each([
  { pressTimeoutError: -25205 },
  { pressActionCalled: false },
  { lastError: -25202 },
  { pressSheetState: "detached_sheet" },
  { pressFollowupError: -25202 },
  { guardMask: 254 },
  { saveTargetExistingFixture: false },
  { saveTargetAbsent: true },
  { directoryVerified: false },
  { saveFilename: { ...filenameProof, labelAttached: false } },
  { action: { requested: "observe_replace_json", pressed: false, dismissed: true } },
])("refuses missing original Save guards for independent observation %j", (change) => {
  expect(
    installedMacReplaceContextObserved(JSON.stringify({ ...boundModalObservation, ...change })),
  ).toBe(false);
});
it("requires complete unique attachment when the initial traversal had no modal candidate", () => {
  const context = {
    ...boundModalObservation.replaceContext,
    modalCandidates: 0,
    attachmentStatus: "complete",
    attachmentCandidates: 1,
    attachmentError: 0,
    capturedSheetAttached: true,
  };
  expect(
    installedMacReplaceContextObserved(
      JSON.stringify({ ...boundModalObservation, replaceContext: context }),
    ),
  ).toBe(true);
  for (const change of [
    { attachmentStatus: "error" },
    { attachmentCandidates: 2 },
    { attachmentError: -25202 },
    { capturedSheetAttached: false },
  ]) {
    expect(
      installedMacReplaceContextObserved(
        JSON.stringify({
          ...boundModalObservation,
          replaceContext: { ...context, ...change },
        }),
      ),
    ).toBe(false);
  }
});
it.each([
  "modalBindingStatus",
  "modalBindingParent",
  "modalBindingMatches",
  "modalBindingSheetAttached",
  "modalBindingForeground",
  "modalBindingError",
  "modalBindingAttribute",
  "modalStatus",
  "modalError",
  "modalAttribute",
  "modalVisited",
  "modalButtons",
  "modalCancel",
  "modalReplace",
  "modalEnabledCancel",
  "modalEnabledReplace",
  "modalCandidates",
  "saveActionStatus",
  "savePressAction",
  "saveActionError",
])("refuses missing independent modal proof field %s", (field) => {
  const context = { ...boundModalObservation.replaceContext, [field]: undefined };
  expect(
    installedMacReplaceContextObserved(
      JSON.stringify({ ...boundModalObservation, replaceContext: context }),
    ),
  ).toBe(false);
});

it.each(["sheet", "parent"])(
  "accepts successful press only with a uniquely bound replacement modal (%s)",
  (modalBindingParent) => {
    expect(
      installedMacReplaceContextObserved(
        JSON.stringify({
          ...replacementObservation,
          replaceContext: { ...replacementObservation.replaceContext, modalBindingParent },
        }),
      ),
    ).toBe(true);
  },
);
it.each([
  { modalCandidates: 0, modalStatus: "not_checked" },
  { modalCandidates: 2 },
  { modalStatus: "error" },
  { modalError: -25202 },
  { modalVisited: 0 },
  { modalButtons: 0 },
  { modalButtons: 3 },
  { modalCancel: 0 },
  { modalReplace: 0 },
  { modalEnabledCancel: 0 },
  { modalEnabledReplace: 0 },
  { modalBindingStatus: "error" },
  { modalBindingParent: "other" },
  { modalBindingMatches: 0 },
  { modalBindingMatches: 2 },
  { modalBindingSheetAttached: false },
  { modalBindingForeground: false },
  { modalBindingError: -25202 },
  { modalBindingAttribute: "AXParent" },
])("refuses a successful press without complete replacement-prompt evidence %j", (change) => {
  expect(
    installedMacReplaceContextObserved(
      JSON.stringify({
        ...replacementObservation,
        replaceContext: { ...replacementObservation.replaceContext, ...change },
      }),
    ),
  ).toBe(false);
});
it.each([
  "modalCandidates",
  "modalStatus",
  "modalError",
  "modalVisited",
  "modalButtons",
  "modalCancel",
  "modalReplace",
  "modalEnabledCancel",
  "modalEnabledReplace",
  "modalBindingStatus",
  "modalBindingParent",
  "modalBindingMatches",
  "modalBindingSheetAttached",
  "modalBindingForeground",
  "modalBindingError",
  "modalBindingAttribute",
])("refuses missing successful-press modal proof field %s", (field) => {
  expect(
    installedMacReplaceContextObserved(
      JSON.stringify({
        ...replacementObservation,
        replaceContext: { ...replacementObservation.replaceContext, [field]: undefined },
      }),
    ),
  ).toBe(false);
});

const replacementCancelled = {
  ...boundModalObservation,
  action: { requested: "cancel_replace_json", pressed: false, dismissed: false },
  replaceContext: {
    ...boundModalObservation.replaceContext,
    cancelStatus: "complete",
    cancelGuardMask: 255,
    cancelPressed: true,
    cancelDismissed: true,
    cancelSheetRetained: true,
    cancelTargetUnchanged: true,
    cancelError: 0,
    cancelChainVisited: 3,
  },
};
it("requires independently bound confirmation Cancel without claiming a completed Save", () => {
  const output = JSON.stringify(replacementCancelled);
  expect(installedMacReplacementCancelled(output)).toBe(true);
  expect(installedMacReplaceContextObserved(output)).toBe(false);
  expect(installedMacJsonSaveSucceeded(output)).toBe(false);
  const diagnostic = installedMacAxProbeDiagnostic(output, null, 1);
  expect(diagnostic).toContain("replace_context_cancelGuardMask=255");
  expect(diagnostic).toContain("replace_context_cancelSheetRetained=true");
  expect(diagnostic).toContain("last_error=-25205");
});
it.each([
  { cancelStatus: "refused" },
  { cancelStatus: "press_error" },
  { cancelStatus: "not_dismissed" },
  { cancelStatus: "target_changed" },
  { cancelGuardMask: 254 },
  { cancelPressed: false },
  { cancelDismissed: false },
  { cancelSheetRetained: false },
  { cancelTargetUnchanged: false },
  { cancelError: -25205 },
  { cancelChainVisited: 1 },
  { modalBindingForeground: false },
  { modalBindingParent: "other" },
  { modalReplace: 0 },
  { modalCandidates: 2 },
])("refuses incomplete or unsafe confirmation Cancel evidence %j", (change) => {
  expect(
    installedMacReplacementCancelled(
      JSON.stringify({
        ...replacementCancelled,
        replaceContext: { ...replacementCancelled.replaceContext, ...change },
      }),
    ),
  ).toBe(false);
});
it.each([
  "cancelStatus",
  "cancelGuardMask",
  "cancelPressed",
  "cancelDismissed",
  "cancelSheetRetained",
  "cancelTargetUnchanged",
  "cancelError",
  "cancelChainVisited",
])("refuses absent confirmation Cancel proof field %s", (field) => {
  expect(
    installedMacReplacementCancelled(
      JSON.stringify({
        ...replacementCancelled,
        replaceContext: { ...replacementCancelled.replaceContext, [field]: undefined },
      }),
    ),
  ).toBe(false);
});
it.each([
  { cancelStatus: "/private/path" },
  { cancelGuardMask: 256 },
  { cancelError: 32768 },
  { cancelChainVisited: 17 },
  { cancelSheetRetained: "private" },
  { cancelTargetUnchanged: "private" },
  { cancelTitle: "private content" },
])("redacts private or unbounded Cancel evidence %j", (change) => {
  const output = JSON.stringify({
    ...replacementCancelled,
    replaceContext: { ...replacementCancelled.replaceContext, ...change },
  });
  expect(installedMacAxProbeDiagnostic(output, null, 1)).toBe(
    "Native macOS AX probe: invalid_evidence",
  );
  expect(installedMacReplacementCancelled(output)).toBe(false);
});
it("does not treat an observation-only request as confirmation cancellation", () => {
  expect(installedMacReplacementCancelled(JSON.stringify(boundModalObservation))).toBe(false);
  expect(
    installedMacReplacementCancelled(
      JSON.stringify({
        ...replacementCancelled,
        action: { requested: "observe_replace_json", pressed: false, dismissed: false },
      }),
    ),
  ).toBe(false);
});
it("bounds explicit Cancel output at 8KiB without expanding ordinary AX limits", () => {
  const output = JSON.stringify(replacementCancelled);
  expect(installedMacReplacementCancelled(output.padEnd(8192, " "))).toBe(true);
  expect(installedMacReplacementCancelled(output.padEnd(8193, " "))).toBe(false);
  expect(installedMacAxProbeDiagnostic(output.padEnd(8193, " "), null, 1)).toBe(
    "Native macOS AX probe: invalid_evidence",
  );
});

it.each([0, 1, 3, 7, 15, 31, 63, 127])(
  "retains partial Cancel guard mask %i without accepting the action",
  (cancelGuardMask) => {
    const output = JSON.stringify({
      ...replacementCancelled,
      replaceContext: {
        ...replacementCancelled.replaceContext,
        cancelStatus: "refused",
        cancelGuardMask,
        cancelPressed: false,
        cancelDismissed: false,
      },
    });
    expect(installedMacReplacementCancelled(output)).toBe(false);
    expect(installedMacAxProbeDiagnostic(output, null, 1)).toContain(
      `replace_context_cancelGuardMask=${cancelGuardMask}`,
    );
  },
);

const jsonReplaced = {
  ...boundModalObservation,
  action: { requested: "replace_json", pressed: false, dismissed: false },
  replaceContext: {
    ...boundModalObservation.replaceContext,
    saveActionStatus: "not_checked",
    savePressAction: "unknown",
    saveActionError: 0,
    replaceStatus: "complete",
    replaceGuardMask: 255,
    replacePressed: true,
    replaceDismissed: true,
    replaceSaveDismissed: true,
    replaceTargetFixtureVerified: true,
    replaceError: 0,
    replaceChainVisited: 2,
  },
};
it("requires independent modal, exact fixture and full Replace guard without claiming Save AXPress success", () => {
  const output = JSON.stringify(jsonReplaced);
  expect(installedMacJsonReplacementConfirmed(output)).toBe(true);
  expect(installedMacJsonSaveSucceeded(output)).toBe(false);
  expect(installedMacReplacementCancelled(output)).toBe(false);
  expect(installedMacReplaceContextObserved(output)).toBe(false);
  const diagnostic = installedMacAxProbeDiagnostic(output, null, 1);
  expect(diagnostic).toContain("replace_context_replaceGuardMask=255");
  expect(diagnostic).toContain("replace_context_replaceSaveDismissed=true");
  expect(diagnostic).toContain("last_error=-25205");
  expect(diagnostic).toContain("pressed=false");
});
it("also accepts an initially successful Save dispatch with the same guarded Replace proof", () => {
  const output = JSON.stringify({
    ...jsonReplaced,
    lastError: 0,
    stage: "replace_observed",
    action: { requested: "replace_json", pressed: true, dismissed: false },
    replaceContext: {
      ...replacementObservation.replaceContext,
      ...jsonReplaced.replaceContext,
      status: "complete",
      error: 0,
    },
  });
  expect(installedMacJsonReplacementConfirmed(output)).toBe(true);
});
it.each([
  { modalBindingParent: "parent" },
  { windows: 2 },
  { replaceStatus: "refused" },
  { replaceStatus: "press_error" },
  { replaceStatus: "not_dismissed" },
  { replaceGuardMask: 254 },
  { replacePressed: false },
  { replaceDismissed: false },
  { replaceSaveDismissed: false },
  { replaceTargetFixtureVerified: false },
  { replaceError: -25205 },
  { replaceChainVisited: 1 },
  { modalBindingParent: "other" },
  { modalBindingSheetAttached: false },
  { modalBindingForeground: false },
  { modalReplace: 0 },
  { modalCandidates: 2 },
  { saveActionStatus: "error" },
  { savePressAction: "present" },
  { saveActionError: -25202 },
])("refuses incomplete or unexpected Replace evidence %j", (change) => {
  expect(
    installedMacJsonReplacementConfirmed(
      JSON.stringify({
        ...jsonReplaced,
        replaceContext: { ...jsonReplaced.replaceContext, ...change },
      }),
    ),
  ).toBe(false);
});
it.each([
  "replaceStatus",
  "replaceGuardMask",
  "replacePressed",
  "replaceDismissed",
  "replaceSaveDismissed",
  "replaceTargetFixtureVerified",
  "replaceError",
  "replaceChainVisited",
])("refuses absent Replace proof field %s", (field) => {
  expect(
    installedMacJsonReplacementConfirmed(
      JSON.stringify({
        ...jsonReplaced,
        replaceContext: { ...jsonReplaced.replaceContext, [field]: undefined },
      }),
    ),
  ).toBe(false);
});
it.each([
  { replaceStatus: "/private/path" },
  { replaceGuardMask: 256 },
  { replaceError: 32768 },
  { replaceChainVisited: 17 },
  { replaceSaveDismissed: "private" },
  { replaceTargetFixtureVerified: "private" },
  { replaceTitle: "private content" },
])("rejects private or unbounded Replace evidence %j", (change) => {
  const output = JSON.stringify({
    ...jsonReplaced,
    replaceContext: { ...jsonReplaced.replaceContext, ...change },
  });
  expect(installedMacAxProbeDiagnostic(output, null, 1)).toBe(
    "Native macOS AX probe: invalid_evidence",
  );
  expect(installedMacJsonReplacementConfirmed(output)).toBe(false);
});
it.each([
  { saveTargetExistingFixture: false },
  { guardMask: 254 },
  { lastError: -25202 },
  { action: { requested: "cancel_replace_json", pressed: false, dismissed: false } },
  { action: { requested: "observe_replace_json", pressed: false, dismissed: false } },
])("never upgrades a different action or missing original guard to Replace %j", (change) => {
  expect(installedMacJsonReplacementConfirmed(JSON.stringify({ ...jsonReplaced, ...change }))).toBe(
    false,
  );
});
it("bounds explicit Replace evidence without changing ordinary AX output limits", () => {
  const output = JSON.stringify(jsonReplaced);
  expect(installedMacJsonReplacementConfirmed(output.padEnd(8192, " "))).toBe(true);
  expect(installedMacJsonReplacementConfirmed(output.padEnd(8193, " "))).toBe(false);
});

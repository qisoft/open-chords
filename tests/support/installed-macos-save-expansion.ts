import { z } from "zod";

import { installedExportExitDiagnostic } from "./installed-export-process.ts";

const schema = z.strictObject({
  trusted: z.boolean(),
  complete: z.boolean(),
  foreground: z.boolean(),
  guardMask: z.number().int().min(0).max(255),
  firstErrorDurationMs: z.number().int().min(0).max(999999),
  lastError: z.number().int().min(-32768).max(32767),
  firstErrorAttribute: z.enum([
    "none",
    "AXWindows",
    "AXRole",
    "AXChildren",
    "AXTitle",
    "AXEnabled",
    "AXValue",
    "AXActions",
    "AXPress",
  ]),
  stage: z.enum([
    "arguments",
    "discovery",
    "discovery_bound",
    "discovery_deadline",
    "guard",
    "press",
    "expansion",
    "complete",
  ]),
  pressed: z.boolean(),
  expanded: z.boolean(),
  initialValue: z.number().int().min(-1).max(1),
  finalValue: z.number().int().min(-1).max(1),
  windows: z.number().int().min(0).max(17),
  sheets: z.number().int().min(0).max(17),
  visited: z.number().int().min(0).max(256),
  unsupported: z.number().int().min(0).max(999),
  disclosures: z.number().int().min(0).max(999),
  saveButtons: z.number().int().min(0).max(999),
  cancelButtons: z.number().int().min(0).max(999),
});
function parse(stdout: string) {
  if (stdout.length > 4096) return undefined;
  try {
    return schema.safeParse(JSON.parse(stdout));
  } catch {
    return undefined;
  }
}
export function installedMacSaveExpansionSucceeded(stdout: string) {
  return disclosureTransitionSucceeded(stdout, false);
}
export function installedMacSaveCollapseSucceeded(stdout: string) {
  return disclosureTransitionSucceeded(stdout, true);
}
export function installedMacSaveExpandedReady(stdout: string) {
  return disclosureTransitionSucceeded(stdout, false, true);
}
function disclosureTransitionSucceeded(stdout: string, collapse: boolean, ensureExpanded = false) {
  const parsed = parse(stdout);
  if (!parsed?.success) return false;
  const value = parsed.data;
  return (
    value.trusted &&
    value.complete &&
    value.foreground &&
    value.guardMask === 255 &&
    value.lastError === 0 &&
    value.firstErrorAttribute === "none" &&
    value.stage === "complete" &&
    (value.pressed || (ensureExpanded && value.initialValue === 1)) &&
    value.expanded === !collapse &&
    (value.initialValue === (collapse ? 1 : 0) ||
      (ensureExpanded && !value.pressed && value.initialValue === 1)) &&
    value.finalValue === (collapse ? 0 : 1) &&
    value.visited >= 4 &&
    value.windows === 1 &&
    value.sheets === 1 &&
    value.disclosures === 1 &&
    value.saveButtons === 1 &&
    value.cancelButtons === 1
  );
}
export function installedMacSaveExpansionDiagnostic(
  stdout: string,
  error: unknown,
  durationMs: number,
) {
  if (error)
    return installedExportExitDiagnostic(error, durationMs).replace(
      "Installed export process",
      "Native macOS Save expansion",
    );
  const parsed = parse(stdout);
  if (!parsed?.success) return "Native macOS Save expansion: invalid_evidence";
  return (
    "Native macOS Save expansion: " +
    Object.entries(parsed.data)
      .map(([key, value]) => `${key}=${value}`)
      .join(" ")
  );
}

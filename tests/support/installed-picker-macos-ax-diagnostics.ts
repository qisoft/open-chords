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
] as const;

const evidenceSchema = z.strictObject({
  trusted: z.boolean(),
  complete: z.boolean(),
  lastError: z.number().int().min(-32768).max(32767),
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
    const { trusted, complete, lastError, counts } = evidence.data;
    return [
      "Native macOS AX probe:",
      `trusted=${trusted}`,
      `complete=${complete}`,
      `last_error=${lastError}`,
      ...MAC_AX_COUNT_FIELDS.map((key) => `${key}=${counts[key]}`),
    ].join(" ");
  } catch {
    return "Native macOS AX probe: invalid_evidence";
  }
}

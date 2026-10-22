import { z } from "zod";

const observations = z.strictObject({
  evalBlocked: z.boolean(),
  inlineScriptBlocked: z.boolean(),
  documentUrl: z.enum(["app_index", "app_other", "about_blank", "other"]),
  isTopFrame: z.boolean(),
  topDocumentUrl: z.enum(["app_index", "app_other", "about_blank", "other", "unavailable"]),
  readyState: z.enum(["loading", "interactive", "complete"]),
  preloadPresent: z.boolean(),
  metaCount: z.number().int().min(0).max(17),
  metaMatches: z.boolean(),
});

export function installedEffectiveCspDiagnostic(value: unknown) {
  const parsed = observations.safeParse(value);
  if (!parsed.success) return "Installed effective CSP: invalid_evidence";
  const p = parsed.data;
  return `Installed effective CSP: eval_blocked=${p.evalBlocked} inline_blocked=${p.inlineScriptBlocked} document_url=${p.documentUrl} top_frame=${p.isTopFrame} top_document_url=${p.topDocumentUrl} ready_state=${p.readyState} preload_present=${p.preloadPresent} meta_count=${p.metaCount} meta_matches=${p.metaMatches}`;
}

export function installedCspInterruptionDiagnostic(
  reason: "timeout" | "error" | "close",
  refused?: { observation: unknown },
) {
  if (refused !== undefined)
    return `${installedEffectiveCspDiagnostic(refused.observation)}\nInstalled CSP frame tree: unavailable`;
  return {
    timeout: "Renderer CDP evaluation timed out",
    error: "Renderer CDP connection failed",
    close: "Renderer CDP connection closed before evaluation completed",
  }[reason];
}

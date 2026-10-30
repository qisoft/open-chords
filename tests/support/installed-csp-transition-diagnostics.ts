import { z } from "zod";

// These helpers classify already-returned evidence. They never select a context,
// issue CDP requests, repeat a probe or turn a failed CSP assertion into success.
function documentCategory(raw: string) {
  if (raw === "about:blank") return "about_blank";
  try {
    const url = new URL(raw);
    if (url.protocol === "open-chords:" && url.hostname === "app")
      return url.pathname === "/index.html" ? "app_index" : "app_other";
  } catch {
    /* URLs and parse errors never leave the classifier. */
  }
  return "other";
}
const frameEvidence = z.object({
  frame: z.object({
    url: z.string(),
    securityOrigin: z.string().optional(),
    unreachableUrl: z.string().optional(),
  }),
});
export function installedCspFrameNavigationDiagnostic(value: unknown) {
  const parsed = frameEvidence.safeParse(value);
  if (!parsed.success) return "Installed CSP navigation: invalid_evidence";
  const frame = parsed.data.frame;
  let origin = "other";
  if (frame.securityOrigin === undefined) origin = "absent";
  else if (frame.securityOrigin === "") origin = "empty";
  else if (frame.securityOrigin === "null") origin = "opaque";
  else {
    try {
      const url = new URL(frame.securityOrigin);
      if (url.protocol === "open-chords:" && url.hostname === "app") origin = "app";
    } catch {
      /* No raw origin or exception output. */
    }
  }
  const unreachable =
    frame.unreachableUrl === undefined
      ? "absent"
      : frame.unreachableUrl === ""
        ? "empty"
        : documentCategory(frame.unreachableUrl);
  return `Installed CSP navigation: root_url=${frame.url === "" ? "empty" : "nonempty"} origin=${origin} unreachable=${unreachable}`;
}
export const InstalledCspDocumentContextSchema = z.strictObject({
  document: z.enum(["app_index", "app_other", "about_blank", "other", "unavailable"]),
  preloadPresent: z.boolean(),
});
const mediaEvidence = z.object({
  entryContext: InstalledCspDocumentContextSchema.optional(),
  exitContext: InstalledCspDocumentContextSchema.optional(),
  offline: z.boolean(),
  played: z.boolean(),
  workspacePlayed: z.boolean(),
  timelineMoved: z.boolean(),
  seeked: z.boolean(),
  pathKeyExposed: z.boolean(),
  error: z.string().nullable(),
  type: z.string(),
});
export function installedCspPriorMediaDiagnostic(targetUrl: string, value: unknown) {
  const parsed = mediaEvidence.safeParse(value);
  if (!parsed.success) return "Installed CSP prior media: invalid_evidence";
  const p = parsed.data;
  const type =
    p.type === "media.playback_ready"
      ? "playback_ready"
      : p.type === "media.probe_failed"
        ? "probe_failed"
        : p.type === "desktop.error"
          ? "desktop_error"
          : "other";
  return `Installed CSP prior media: target=${documentCategory(targetUrl)} type=${type} offline=${p.offline} played=${p.played} workspace_played=${p.workspacePlayed} timeline_moved=${p.timelineMoved} seeked=${p.seeked} path_key_exposed=${p.pathKeyExposed} error_present=${p.error !== null} entry=${p.entryContext?.document ?? "unavailable"} entry_preload=${p.entryContext?.preloadPresent ?? "unknown"} exit=${p.exitContext?.document ?? "unavailable"} exit_preload=${p.exitContext?.preloadPresent ?? "unknown"}`;
}

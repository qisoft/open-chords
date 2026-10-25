import { z } from "zod";

const frame = z.object({
  frame: z.object({ url: z.string() }),
  childFrames: z.array(z.unknown()).optional(),
});

function category(raw: string) {
  if (raw === "about:blank") return "about_blank";
  try {
    const url = new URL(raw);
    if (url.protocol === "open-chords:" && url.hostname === "app")
      return url.pathname === "/index.html" ? "app_index" : "app_other";
  } catch {
    /* Raw URLs never leave the diagnostic. */
  }
  return "other";
}

function protocolCategory(raw: string) {
  try {
    const protocol = new URL(raw).protocol;
    return (
      {
        "open-chords:": "open_chords",
        "about:": "about",
        "file:": "file",
        "http:": "http",
        "https:": "https",
        "devtools:": "devtools",
        "chrome-error:": "chrome_error",
        "data:": "data",
      }[protocol] ?? "other"
    );
  } catch {
    return "invalid";
  }
}

export function installedCspFrameTreeDiagnostic(value: unknown) {
  const pending = [value];
  let root = "unavailable";
  let rootProtocol = "unavailable";
  let visited = 0;
  let app = 0;
  let blank = 0;
  let other = 0;
  while (pending.length > 0 && visited < 64) {
    const node = frame.safeParse(pending.shift());
    if (!node.success) return "Installed CSP frame tree: invalid_evidence";
    const kind = category(node.data.frame.url);
    if (visited === 0) {
      root = kind;
      rootProtocol = protocolCategory(node.data.frame.url);
    }
    visited++;
    if (kind === "app_index" || kind === "app_other") app++;
    else if (kind === "about_blank") blank++;
    else other++;
    // Retain only enough nodes to determine whether the fixed inventory bound is exceeded.
    pending.push(...(node.data.childFrames ?? []).slice(0, 65 - pending.length));
  }
  return `Installed CSP frame tree: root=${root} root_protocol=${rootProtocol} frames=${String(visited)} app=${String(app)} blank=${String(blank)} other=${String(other)} truncated=${String(pending.length > 0)}`;
}

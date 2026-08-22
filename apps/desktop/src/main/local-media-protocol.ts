import { parseApplicationUrl } from "./desktop-origin.ts";
import {
  LocalMediaCapabilityUnavailableError,
  LocalMediaChangedError,
  LocalMediaRangeError,
  LocalMediaReadLimitError,
  type LocalMediaService,
} from "./local-media.ts";

const baseHeaders = {
  "Accept-Ranges": "bytes",
  "Cache-Control": "no-store",
  "Cross-Origin-Resource-Policy": "same-origin",
  "X-Content-Type-Options": "nosniff",
};

export async function handleLocalMediaRequest(
  media: LocalMediaService,
  request: Request,
): Promise<Response> {
  if (request.method === "OPTIONS")
    return new Response(null, { headers: baseHeaders, status: 204 });
  if (request.method !== "GET") return methodNotAllowed();
  const capabilityId = capabilityFromUrl(request.url);
  if (capabilityId === null) return mediaError(404, "Not Found");
  const range = parseByteRange(request.headers.get("range"));
  if (range === null) return mediaError(416, "Range Not Satisfiable");
  try {
    const result = await media.readPlaybackRange({ capabilityId, ...range });
    const headers = new Headers(baseHeaders);
    headers.set("Content-Length", String(result.bytes.byteLength));
    headers.set(
      "Content-Range",
      `bytes ${String(result.startByte)}-${String(result.endByteExclusive - 1)}/${String(result.byteSize)}`,
    );
    headers.set("Content-Type", result.mimeType);
    return new Response(new Uint8Array(result.bytes), { headers, status: 206 });
  } catch (error) {
    if (error instanceof LocalMediaReadLimitError)
      return mediaError(503, "Service Unavailable", { "Retry-After": "1" });
    if (error instanceof LocalMediaCapabilityUnavailableError) return mediaError(404, "Not Found");
    if (error instanceof LocalMediaChangedError) return mediaError(410, "Gone");
    if (error instanceof LocalMediaRangeError) return mediaError(416, "Range Not Satisfiable");
    return mediaError(500, "Internal Server Error");
  }
}

export function isLocalMediaRequestUrl(value: string): boolean {
  return capabilityFromUrl(value) !== null;
}

function capabilityFromUrl(value: string): string | null {
  try {
    const url = parseApplicationUrl(value);
    if (
      url === null ||
      url.search !== "" ||
      url.hash !== "" ||
      !/^\/media\/playbackcapability_[a-f0-9]{32}$/.test(url.pathname)
    ) {
      return null;
    }
    return url.pathname.slice("/media/".length);
  } catch {
    return null;
  }
}

function parseByteRange(
  value: string | null,
): { endByteExclusive?: number; startByte: number } | null {
  if (value === null) return null;
  const match = /^bytes=(0|[1-9]\d*)-(?:(0|[1-9]\d*))?$/.exec(value);
  if (match === null) return null;
  const startByte = Number(match[1]);
  if (match[2] === undefined) {
    return Number.isSafeInteger(startByte) ? { startByte } : null;
  }
  const inclusiveEnd = Number(match[2]);
  if (
    !Number.isSafeInteger(startByte) ||
    !Number.isSafeInteger(inclusiveEnd) ||
    inclusiveEnd < startByte
  ) {
    return null;
  }
  return { endByteExclusive: inclusiveEnd + 1, startByte };
}

function methodNotAllowed(): Response {
  return mediaError(405, null, { Allow: "GET, OPTIONS" });
}

function mediaError(
  status: number,
  message: string | null,
  additionalHeaders: Record<string, string> = {},
): Response {
  return new Response(message, {
    headers: { ...baseHeaders, ...additionalHeaders },
    status,
  });
}

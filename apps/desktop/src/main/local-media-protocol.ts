import type { LocalMediaService } from "./local-media.ts";

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
  if (request.method !== "GET" && request.method !== "HEAD") {
    return mediaError(405, "Method Not Allowed");
  }
  const capabilityId = capabilityFromUrl(request.url);
  if (capabilityId === null) return mediaError(404, "Not Found");
  if (request.method === "HEAD") return mediaError(405, "Range Required");
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
  } catch {
    return mediaError(416, "Range Not Satisfiable");
  }
}

function capabilityFromUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "open-chords:" ||
      url.host !== "app" ||
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
): { endByteExclusive: number; startByte: number } | null {
  if (value === null) return null;
  const match = /^bytes=(0|[1-9]\d*)-(0|[1-9]\d*)$/.exec(value);
  if (match === null) return null;
  const startByte = Number(match[1]);
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

function mediaError(status: number, message: string): Response {
  return new Response(message, { headers: baseHeaders, status });
}

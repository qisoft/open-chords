import { pathToFileURL } from "node:url";

import { net, protocol, session } from "electron";

import { handleLocalMediaRequest, isLocalMediaRequestUrl } from "./local-media-protocol.ts";
import type { LocalMediaService } from "./local-media.ts";
import { loadRendererAssetManifest } from "./renderer-assets.ts";
import { PRIMARY_RENDERER_PARTITION } from "./shell.ts";

export const RENDERER_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src open-chords:",
  "font-src 'self'",
  "media-src open-chords:",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

const responseHeaders = {
  "Content-Security-Policy": RENDERER_CSP,
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

export function registerRendererScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      privileges: {
        allowServiceWorkers: false,
        bypassCSP: false,
        codeCache: true,
        corsEnabled: false,
        secure: true,
        standard: true,
        stream: true,
        supportFetchAPI: true,
      },
      scheme: "open-chords",
    },
  ]);
}

export function installRendererProtocol(rendererRoot: string, media: LocalMediaService): void {
  const assets = loadRendererAssetManifest(rendererRoot);

  session
    .fromPartition(PRIMARY_RENDERER_PARTITION)
    .protocol.handle("open-chords", async (request) => {
      if (isLocalMediaRequestUrl(request.url)) {
        return handleLocalMediaRequest(media, request);
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method Not Allowed", { status: 405, headers: responseHeaders });
      }
      const file = assets.resolve(request.url);
      if (file === null)
        return new Response("Not Found", { status: 404, headers: responseHeaders });

      let response: Response;
      try {
        response = await net.fetch(pathToFileURL(file).toString(), { method: request.method });
      } catch {
        return new Response("Internal Server Error", { status: 500, headers: responseHeaders });
      }
      const headers = new Headers(response.headers);
      for (const [name, value] of Object.entries(responseHeaders)) headers.set(name, value);
      return new Response(response.body, { headers, status: response.status });
    });
}

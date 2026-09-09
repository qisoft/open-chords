export function canonicalYouTubeSource(input: string) {
  if (input.length > 4096) throw new Error("Enter a supported YouTube video URL");
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("Enter a supported YouTube video URL");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"].includes(url.hostname)
  )
    throw new Error("Enter a supported YouTube video URL");
  const videoId =
    url.hostname === "youtu.be"
      ? url.pathname.slice(1)
      : url.pathname === "/watch"
        ? url.searchParams.getAll("v").length === 1
          ? url.searchParams.get("v")
          : null
        : /^\/(shorts|embed|live)\/[A-Za-z0-9_-]{11}$/.test(url.pathname)
          ? url.pathname.split("/")[2]
          : null;
  if (!videoId || !/^[A-Za-z0-9_-]{11}$/.test(videoId))
    throw new Error("Enter a supported YouTube video URL");
  return {
    canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`,
    identity: { kind: "youtube" as const, provider: "youtube" as const, videoId },
  };
}

const metadataSchema = z.object({
  title: z.string().min(1).max(500),
  author_name: z.string().min(1).max(500),
  thumbnail_url: z.string().url().max(2048).optional(),
});

export class YouTubeMetadata {
  readonly #network: NetworkMode;
  readonly #fetch: typeof fetch;
  readonly #unsubscribe: () => void;
  #controller: AbortController | undefined;
  #closed = false;

  constructor(options: { network: NetworkMode; fetch?: typeof fetch }) {
    this.#network = options.network;
    this.#fetch = options.fetch ?? fetch;
    this.#unsubscribe = this.#network.subscribe(() => this.cancel());
  }

  cancel() {
    this.#controller?.abort();
    this.#controller = undefined;
  }

  close() {
    this.#closed = true;
    this.cancel();
    this.#unsubscribe();
  }

  async observe(input: string) {
    if (this.#closed) throw new Error("YouTube metadata is unavailable");
    const source = canonicalYouTubeSource(input);
    this.cancel();
    if (this.#network.offline) throw new Error("Offline Mode is enabled");
    const controller = new AbortController();
    this.#controller = controller;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]);
    const url = new URL("https://www.youtube.com/oembed");
    url.searchParams.set("url", source.canonicalUrl);
    url.searchParams.set("format", "json");
    try {
      const response = await this.#fetch(url, { credentials: "omit", redirect: "error", signal });
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new Error("YouTube metadata is unavailable");
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        for (;;) {
          signal.throwIfAborted();
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > 64 * 1024) throw new Error("YouTube metadata exceeds limit");
          chunks.push(chunk.value);
        }
      } finally {
        await reader.cancel();
      }
      signal.throwIfAborted();
      const data = metadataSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      const thumbnail = data.thumbnail_url ? new URL(data.thumbnail_url) : undefined;
      const safeThumbnail =
        thumbnail?.origin === "https://i.ytimg.com" &&
        !thumbnail.username &&
        !thumbnail.password &&
        !thumbnail.search &&
        !thumbnail.hash &&
        new RegExp(`^/vi(?:_webp)?/${source.identity.videoId}/[A-Za-z0-9_-]+\\.(jpg|webp)$`).test(
          thumbnail.pathname,
        );
      return {
        source,
        observation: SourceMetadataObservationSchema.parse({
          id: `metadata_${randomUUID().replaceAll("-", "")}`,
          observedAt: new Date().toISOString(),
          provider: "youtube",
          title: data.title,
          uploader: data.author_name,
          ...(safeThumbnail ? { thumbnailUrl: thumbnail.href } : {}),
        }),
      };
    } finally {
      if (this.#controller === controller) this.#controller = undefined;
    }
  }
}
import { randomUUID } from "node:crypto";

import { z } from "zod";

import type { NetworkMode } from "./network-mode.ts";
import { SourceMetadataObservationSchema } from "./project-library-records.ts";

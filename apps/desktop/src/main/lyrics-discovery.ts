import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  LyricsSearchSchema,
  type LyricsCandidate,
  type LyricsSearch,
} from "@open-chords/contracts";
import type { LyricsInput, LyricsOrigin } from "@open-chords/domain";
import { z } from "zod";

const recordSchema = z.object({
  id: z.number().int().positive(),
  trackName: z.string().max(200).nullable(),
  artistName: z.string().max(200).nullable(),
  albumName: z.string().max(200).nullable(),
  duration: z.number().nonnegative().nullable(),
  plainLyrics: z.string().max(64_000).nullable(),
  syncedLyrics: z.string().max(64_000).nullable(),
  instrumental: z.boolean(),
});
export async function openLyricsDiscovery(options: { stateRoot: string; fetch?: typeof fetch }) {
  await mkdir(options.stateRoot, { recursive: true });
  const path = join(options.stateRoot, "network-mode.json");
  let offline = false;
  try {
    offline = z
      .strictObject({ offline: z.boolean() })
      .parse(JSON.parse(await readFile(path, "utf8"))).offline;
  } catch (error) {
    if ((error instanceof Error && "code" in error ? error.code : undefined) !== "ENOENT")
      offline = true;
  }
  return new LyricsDiscovery(path, offline, options.fetch ?? fetch);
}

export class LyricsDiscovery {
  #offline: boolean;
  readonly #path: string;
  readonly #fetch: typeof fetch;
  #controller: AbortController | null = null;
  #candidates = new Map<
    string,
    {
      generation: string;
      projectId: string;
      expires: number;
      recordId?: number;
      hash?: string;
      subtitle?: {
        url: string;
        videoId: string;
        language: string;
        automatic: boolean;
        label: string;
      };
    }
  >();
  #write: Promise<void> = Promise.resolve();
  #pendingModeWrites = 0;
  #expiry: ReturnType<typeof setTimeout> | null = null;
  constructor(path: string, offline: boolean, fetcher: typeof fetch) {
    this.#path = path;
    this.#offline = offline;
    this.#fetch = fetcher;
  }
  get offline() {
    return this.#offline;
  }
  async setOffline(value: boolean) {
    if (this.#pendingModeWrites >= 32) throw new Error("Network settings are busy");
    this.#pendingModeWrites++;
    this.#offline = value;
    this.cancel();
    this.#write = this.#write
      .catch(() => {})
      .then(async () => {
        const temp = `${this.#path}.tmp`;
        await writeFile(temp, JSON.stringify({ offline: value }), { mode: 0o600 });
        await rename(temp, this.#path);
        return undefined;
      });
    try {
      await this.#write;
    } finally {
      this.#pendingModeWrites--;
    }
  }
  cancel() {
    if (this.#expiry) clearTimeout(this.#expiry);
    this.#expiry = null;
    this.#controller?.abort();
    this.#controller = null;
    this.#candidates.clear();
  }
  async #read(url: URL, signal: AbortSignal) {
    if (this.#offline) throw new Error("Offline Mode is enabled");
    const response = await this.#fetch(url, {
      signal,
      redirect: "error",
      credentials: "omit",
      headers: {
        Accept: "application/json",
        "User-Agent": "OpenChords/0.0.0 (https://github.com/qisoft/open-chords)",
      },
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error("Lyrics provider unavailable");
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.length;
        if (bytes > 2 * 1024 * 1024) throw new Error("Lyrics response exceeds limit");
        chunks.push(chunk.value);
      }
    } finally {
      await reader.cancel();
    }
    signal.throwIfAborted();
    return Buffer.concat(chunks).toString("utf8");
  }
  async search(
    raw: LyricsSearch,
    generation: string,
    projectId: string,
  ): Promise<LyricsCandidate[]> {
    const input = LyricsSearchSchema.parse(raw);
    this.cancel();
    if (this.#offline) throw new Error("Offline Mode is enabled");

    const controller = new AbortController();
    this.#controller = controller;
    this.#expiry = setTimeout(() => this.cancel(), 300_000);
    this.#expiry.unref();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]);
    if (input.provider === "youtube")
      return this.#youtube(input.query, generation, projectId, signal);
    const url = new URL("https://lrclib.net/api/search");
    url.searchParams.set("q", input.query);
    const records = z
      .array(recordSchema)
      .max(100)
      .parse(JSON.parse(await this.#read(url, signal)));
    return records
      .filter((record) => !record.instrumental && (record.plainLyrics || record.syncedLyrics))
      .slice(0, 20)
      .map((record) => {
        const id = `candidate_${randomUUID().replaceAll("-", "")}`;
        this.#candidates.set(id, {
          generation,
          projectId,
          expires: Date.now() + 300_000,
          recordId: record.id,
          hash: recordHash(record),
        });
        return {
          id,
          label: `${record.trackName ?? "Unknown title"} · ${record.artistName ?? "Unknown artist"} · ${record.albumName ?? ""} · ${record.duration ?? "?"}s`,
          provider: "lrclib" as const,
          language: "und",
          timingKind: record.syncedLyrics ? ("line" as const) : ("untimed" as const),
        };
      });
  }
  async #youtube(
    videoId: string,
    generation: string,
    projectId: string,
    signal: AbortSignal,
  ): Promise<LyricsCandidate[]> {
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) throw new Error("Enter one YouTube video ID");
    const url = new URL("https://www.youtube.com/watch");
    url.searchParams.set("v", videoId);
    const page = await this.#read(url, signal);
    const tracks =
      playerSchema.parse(extractPlayer(page)).captions?.playerCaptionsTracklistRenderer
        .captionTracks ?? [];
    return tracks.slice(0, 20).map((track) => {
      const endpoint = new URL(track.baseUrl);
      if (
        endpoint.origin !== "https://www.youtube.com" ||
        endpoint.username ||
        endpoint.password ||
        endpoint.hash ||
        endpoint.pathname !== "/api/timedtext" ||
        endpoint.searchParams.get("v") !== videoId
      )
        throw new Error("Subtitle endpoint unavailable");
      const id = `candidate_${randomUUID().replaceAll("-", "")}`;
      const label =
        track.name.simpleText ??
        track.name.runs?.map((run) => run.text).join("") ??
        track.languageCode;
      const automatic = track.kind === "asr";
      this.#candidates.set(id, {
        generation,
        projectId,
        expires: Date.now() + 300_000,
        subtitle: { url: endpoint.href, videoId, language: track.languageCode, automatic, label },
      });
      return {
        id,
        label: `${label} · ${automatic ? "Automatic" : "Human"}`,
        provider: automatic ? "youtube_automatic" : "youtube_human",
        language: track.languageCode,
        timingKind: "line",
      };
    });
  }
  async select(
    id: string,
    generation: string,
    projectId: string,
  ): Promise<{ input: LyricsInput; origin: LyricsOrigin }> {
    const candidate = this.#candidates.get(id);
    if (
      !candidate ||
      candidate.generation !== generation ||
      candidate.projectId !== projectId ||
      candidate.expires < Date.now()
    )
      throw new Error("Lyrics candidate expired; search again");
    this.cancel();
    const controller = new AbortController();
    this.#controller = controller;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]);
    try {
      if (candidate.subtitle) {
        const subtitle = candidate.subtitle;
        const url = new URL(subtitle.url);
        url.searchParams.set("fmt", "json3");
        const data = subtitleBodySchema.parse(JSON.parse(await this.#read(url, signal)));
        const cues = data.events
          .filter((event) => event.segs?.some((segment) => segment.utf8.trim()))
          .map((event, index) => {
            if (event.dDurationMs === undefined || event.dDurationMs <= 0)
              throw new Error("Subtitle timing unavailable");
            const text = event
              .segs!.map((segment) => segment.utf8)
              .join("")
              .replaceAll(/\r\n?/g, "\n")
              .split("\n")
              .filter((line) => line.trim().length > 0)
              .join("\n");
            return `${index + 1}\n${subtitleStamp(event.tStartMs)} --> ${subtitleStamp(event.tStartMs + event.dDurationMs)}\n${text}`;
          });
        return {
          input: { text: cues.join("\n\n"), language: subtitle.language, format: "srt" },
          origin: {
            provenance: {
              provider: subtitle.automatic ? "youtube_automatic" : "youtube_human",
              reference: `youtube:${subtitle.videoId}:${subtitle.language}`,
            },
            attribution: ["YouTube", subtitle.label],
            notices: subtitle.automatic ? ["Automatically generated subtitles"] : [],
          },
        };
      }
      const record = recordSchema.parse(
        JSON.parse(
          await this.#read(new URL(`https://lrclib.net/api/get/${candidate.recordId}`), signal),
        ),
      );
      if (record.id !== candidate.recordId || recordHash(record) !== candidate.hash)
        throw new Error("Lyrics candidate changed; search again");
      return {
        input: {
          text: record.syncedLyrics || record.plainLyrics!,
          format: record.syncedLyrics ? "lrc" : "text",
          language: "und",
        },
        origin: {
          provenance: { provider: "lrclib", reference: `lrclib:${record.id}` },
          attribution: [
            "LRCLIB",
            record.artistName ?? "Unknown artist",
            record.trackName ?? "Unknown title",
          ],
          notices: [],
        },
      };
    } finally {
      if (this.#controller === controller) this.cancel();
    }
  }
}
function recordHash(record: z.infer<typeof recordSchema>) {
  return createHash("sha256").update(JSON.stringify(record)).digest("hex");
}

const playerSchema = z.object({
  captions: z
    .object({
      playerCaptionsTracklistRenderer: z.object({
        captionTracks: z
          .array(
            z.object({
              baseUrl: z.string().max(8192),
              languageCode: z
                .string()
                .regex(/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/)
                .max(35),
              kind: z.string().max(30).optional(),
              name: z.object({
                simpleText: z.string().max(200).optional(),
                runs: z
                  .array(z.object({ text: z.string().max(200) }))
                  .max(5)
                  .optional(),
              }),
            }),
          )
          .max(100),
      }),
    })
    .optional(),
});
const subtitleBodySchema = z.object({
  events: z
    .array(
      z.object({
        tStartMs: z.number().int().nonnegative(),
        dDurationMs: z.number().int().nonnegative().optional(),
        segs: z
          .array(z.object({ utf8: z.string().max(10000) }))
          .max(1000)
          .optional(),
      }),
    )
    .max(5000),
});
function subtitleStamp(ms: number) {
  return `${String(Math.floor(ms / 3600000)).padStart(2, "0")}:${String(Math.floor(ms / 60000) % 60).padStart(2, "0")}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}.${String(ms % 1000).padStart(3, "0")}`;
}
function extractPlayer(page: string): unknown {
  const marker = /(?:var\s+)?ytInitialPlayerResponse\s*=\s*/.exec(page);
  if (!marker) throw new Error("Subtitle metadata unavailable");
  const start = marker.index + marker[0].length;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < page.length; index++) {
    const char = page[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) return JSON.parse(page.slice(start, index + 1));
  }
  throw new Error("Subtitle metadata unavailable");
}

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { openLyricsDiscovery } from "../apps/desktop/src/main/lyrics-discovery.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const directory of roots.splice(0)) await rm(directory, { force: true, recursive: true });
});
async function root() {
  const path = await mkdtemp(join(tmpdir(), "open-chords-discovery-"));
  roots.push(path);
  return path;
}
const record = {
  id: 12,
  trackName: "Example",
  artistName: "Artist",
  albumName: "Album",
  duration: 12,
  plainLyrics: "Only selected words",
  syncedLyrics: null,
  instrumental: false,
};

it("searches only explicitly, returns metadata candidates, and Offline Mode persists and prevents transfers", async () => {
  let requests = 0;
  const stateRoot = await root();
  const fetcher: typeof fetch = async () => {
    requests++;
    return Response.json([record, { ...record, id: 13, albumName: "Live" }]);
  };
  const discovery = await openLyricsDiscovery({ stateRoot, fetch: fetcher });
  expect(requests).toBe(0);
  const candidates = await discovery.search(
    { provider: "lrclib", query: "Example" },
    "generation_one",
    "project_one",
  );
  expect(candidates).toHaveLength(2);
  expect(JSON.stringify(candidates)).not.toContain("Only selected words");
  await discovery.setOffline(true);
  await expect(
    discovery.search({ provider: "lrclib", query: "Example" }, "generation_one", "project_one"),
  ).rejects.toThrow("Offline Mode");
  expect(requests).toBe(1);
  const reopened = await openLyricsDiscovery({ stateRoot, fetch: fetcher });
  expect(reopened.offline).toBe(true);
});

it("selects only a current generation-bound candidate, refetches its exact text, and discards the candidate set", async () => {
  const paths: string[] = [];
  const discovery = await openLyricsDiscovery({
    stateRoot: await root(),
    fetch: async (url) => {
      paths.push(new URL(url instanceof Request ? url.url : url).pathname);
      return Response.json(paths.length === 1 ? [record] : record);
    },
  });
  const [candidate] = await discovery.search(
    { provider: "lrclib", query: "Example" },
    "generation_one",
    "project_one",
  );
  await expect(discovery.select(candidate!.id, "generation_other", "project_one")).rejects.toThrow(
    "Lyrics candidate expired",
  );
  const selected = await discovery.select(candidate!.id, "generation_one", "project_one");
  expect(selected.input).toEqual({ text: "Only selected words", language: "und", format: "text" });
  expect(selected.origin.provenance).toEqual({ provider: "lrclib", reference: "lrclib:12" });
  expect(paths).toEqual(["/api/search", "/api/get/12"]);
  await expect(discovery.select(candidate!.id, "generation_one", "project_one")).rejects.toThrow(
    "Lyrics candidate expired",
  );
});

it("distinguishes human and automatic subtitle tracks and keeps signed URLs out of selected provenance", async () => {
  const tracks = ["human", "asr"].map((kind) => ({
    baseUrl: "https://www.youtube.com/api/timedtext?v=abcdefghijk&signature=secret",
    languageCode: "en",
    kind,
    name: { simpleText: "English" },
  }));
  const paths: string[] = [];
  const discovery = await openLyricsDiscovery({
    stateRoot: await root(),
    fetch: async (url) => {
      const parsed = new URL(url instanceof Request ? url.url : url);
      paths.push(parsed.pathname);
      return parsed.pathname === "/watch"
        ? new Response(
            `var ytInitialPlayerResponse = ${JSON.stringify({ captions: { playerCaptionsTracklistRenderer: { captionTracks: tracks } } })};`,
          )
        : Response.json({
            events: [{ tStartMs: 100, dDurationMs: 200, segs: [{ utf8: "Hello" }] }],
          });
    },
  });
  const candidates = await discovery.search(
    { provider: "youtube", query: "abcdefghijk" },
    "generation_one",
    "project_one",
  );
  expect(candidates.map(({ provider }) => provider)).toEqual([
    "youtube_human",
    "youtube_automatic",
  ]);
  expect(JSON.stringify(candidates)).not.toContain("secret");
  const selected = await discovery.select(candidates[1]!.id, "generation_one", "project_one");
  expect(selected.origin.provenance).toEqual({
    provider: "youtube_automatic",
    reference: "youtube:abcdefghijk:en",
  });
  expect(selected.input.text).toContain("00:00:00.100 --> 00:00:00.300\nHello");
  expect(JSON.stringify(selected)).not.toContain("secret");
});

it("cancels in-flight bodies in Offline Mode and refuses off-policy subtitle URLs", async () => {
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const discovery = await openLyricsDiscovery({
    stateRoot: await root(),
    fetch: async (_url, init) => {
      expect(init).toMatchObject({ credentials: "omit", redirect: "error" });
      started();
      return new Promise((_resolve, reject) =>
        init!.signal!.addEventListener("abort", () => reject(new Error("cancelled"))),
      );
    },
  });
  const search = discovery.search(
    { provider: "lrclib", query: "Example" },
    "generation_one",
    "project_one",
  );
  const rejected = search.then(
    () => "unexpected_success",
    () => "cancelled",
  );
  await ready;
  await discovery.setOffline(true);
  expect(await rejected).toBe("cancelled");
  const hostile = await openLyricsDiscovery({
    stateRoot: await root(),
    fetch: async () =>
      new Response(
        `ytInitialPlayerResponse = ${JSON.stringify({ captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ baseUrl: "https://localhost/api/timedtext?v=abcdefghijk", languageCode: "en", name: { simpleText: "English" } }] } } })};`,
      ),
  });
  await expect(
    hostile.search({ provider: "youtube", query: "abcdefghijk" }, "generation_one", "project_one"),
  ).rejects.toThrow("endpoint unavailable");
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { openNetworkMode } from "../apps/desktop/src/main/network-mode.ts";
import {
  canonicalYouTubeSource,
  YouTubeMetadata,
} from "../apps/desktop/src/main/youtube-source.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("YouTube Source identity", () => {
  test("playlist and playback query state do not change the canonical video identity", () => {
    for (const input of [
      "https://www.youtube.com/watch?v=aqz-KE-bpKQ&list=PLexample&index=2&start_radio=1&t=24",
      "https://youtu.be/aqz-KE-bpKQ?si=tracking&t=12",
      "https://m.youtube.com/shorts/aqz-KE-bpKQ?feature=share",
      "https://www.youtube.com/embed/aqz-KE-bpKQ?start=5",
      "https://youtube.com/live/aqz-KE-bpKQ#t=42",
    ]) {
      expect(canonicalYouTubeSource(input)).toEqual({
        canonicalUrl: "https://www.youtube.com/watch?v=aqz-KE-bpKQ",
        identity: { kind: "youtube", provider: "youtube", videoId: "aqz-KE-bpKQ" },
      });
    }
  });

  test("rejects ambiguous identities and URLs outside the supported provider surface", () => {
    for (const input of [
      "https://attacker.example/watch?v=aqz-KE-bpKQ",
      "https://youtube.com.attacker.example/watch?v=aqz-KE-bpKQ",
      "https://user:password@youtube.com/watch?v=aqz-KE-bpKQ",
      "https://youtube.com:8443/watch?v=aqz-KE-bpKQ",
      "http://youtube.com/watch?v=aqz-KE-bpKQ",
      "https://youtube.com/playlist?list=PLexample",
      "https://youtube.com/watch?v=aqz-KE-bpKQ&v=jfKfPfyJRdk",
      "https://youtube.com/arbitrary/aqz-KE-bpKQ",
      "https://youtube.com/shorts/aqz-KE-bpKQ/extra",
      "https://youtube.com/watch?v=too-short",
      "file:///watch?v=aqz-KE-bpKQ",
      "not a URL: secret",
    ])
      expect(() => canonicalYouTubeSource(input)).toThrow("Enter a supported YouTube video URL");
  });
});

test("metadata is explicit, carries a new observation on refresh, and obeys shared Offline Mode", async () => {
  const root = await mkdtemp(join(tmpdir(), "open-chords-youtube-"));
  roots.push(root);
  const network = await openNetworkMode(root);
  const requests: string[] = [];
  const metadata = new YouTubeMetadata({
    network,
    fetch: async (input, options) => {
      requests.push(input instanceof Request ? input.url : input.toString());
      expect(options).toMatchObject({ credentials: "omit", redirect: "error" });
      return Response.json({
        title: "A public video",
        author_name: "Example uploader",
        thumbnail_url: "https://i.ytimg.com/vi/aqz-KE-bpKQ/hqdefault.jpg",
        html: '<iframe src="https://untrusted.example/"></iframe>',
      });
    },
  });
  try {
    expect(requests).toEqual([]);
    const first = await metadata.observe("https://youtu.be/aqz-KE-bpKQ?list=ignored");
    const second = await metadata.observe("https://youtube.com/watch?v=aqz-KE-bpKQ");
    expect(first.source).toEqual(canonicalYouTubeSource("https://youtu.be/aqz-KE-bpKQ"));
    expect(first.observation).toMatchObject({
      provider: "youtube",
      title: "A public video",
      uploader: "Example uploader",
      thumbnailUrl: "https://i.ytimg.com/vi/aqz-KE-bpKQ/hqdefault.jpg",
    });
    expect(first.observation.id).not.toBe(second.observation.id);
    expect(first).not.toHaveProperty("acquisitionAvailable");
    expect(JSON.stringify(first)).not.toContain("iframe");
    expect(requests).toEqual(
      Array(2).fill(
        "https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3Daqz-KE-bpKQ&format=json",
      ),
    );
    await network.setOffline(true);
    await expect(metadata.observe("https://youtu.be/aqz-KE-bpKQ")).rejects.toThrow("Offline Mode");
    expect(requests).toHaveLength(2);
  } finally {
    metadata.close();
  }
});

test("metadata never retains provider HTML or an unrelated thumbnail authority", async () => {
  const root = await mkdtemp(join(tmpdir(), "open-chords-youtube-"));
  roots.push(root);
  const metadata = new YouTubeMetadata({
    network: await openNetworkMode(root),
    fetch: async () =>
      Response.json({
        title: "Safe title",
        author_name: "Uploader",
        thumbnail_url: "https://attacker.example/collect?token=secret",
        html: "<script>steal()</script>",
      }),
  });
  try {
    const result = await metadata.observe("https://youtu.be/aqz-KE-bpKQ");
    expect(result.observation).not.toHaveProperty("thumbnailUrl");
    expect(JSON.stringify(result)).not.toMatch(/attacker|secret|script/);
  } finally {
    metadata.close();
  }
});

test("failed or oversized provider responses yield no metadata observation", async () => {
  const root = await mkdtemp(join(tmpdir(), "open-chords-youtube-"));
  roots.push(root);
  const network = await openNetworkMode(root);
  for (const response of [
    new Response("private failure body", { status: 503 }),
    new Response("x".repeat(65 * 1024)),
    Response.json({ title: "Missing author" }),
  ]) {
    const metadata = new YouTubeMetadata({ network, fetch: async () => response });
    try {
      await expect(metadata.observe("https://youtu.be/aqz-KE-bpKQ")).rejects.toThrow(
        /YouTube metadata|Invalid input/,
      );
    } finally {
      metadata.close();
    }
  }
});

test("enabling Offline Mode cancels an in-flight metadata refresh", async () => {
  const root = await mkdtemp(join(tmpdir(), "open-chords-youtube-"));
  roots.push(root);
  const network = await openNetworkMode(root);
  let begin: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    begin = resolve;
  });
  const metadata = new YouTubeMetadata({
    network,
    fetch: async (_input, options) => {
      begin();
      return new Promise<Response>((_resolve, reject) => {
        options!.signal!.addEventListener("abort", () => reject(new Error("Request cancelled")), {
          once: true,
        });
      });
    },
  });
  try {
    const request = metadata.observe("https://youtu.be/aqz-KE-bpKQ");
    await Promise.all([
      expect(request).rejects.toThrow("Request cancelled"),
      (async () => {
        await started;
        await network.setOffline(true);
      })(),
    ]);
  } finally {
    metadata.close();
  }
});

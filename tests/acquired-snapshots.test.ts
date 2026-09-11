import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import { createAcquiredSnapshot } from "../apps/desktop/src/main/acquired-snapshots.ts";
import { openProjectLibrary } from "../apps/desktop/src/main/project-library.ts";

it("keeps unrelated Sources accessible when one acquired manifest is damaged", async () => {
  const stateRoot = await realpath(
    await mkdtemp(join(tmpdir(), "open-chords-snapshot-isolation-")),
  );
  try {
    const library = await openProjectLibrary({ stateRoot });
    const mediaPath = join(stateRoot, "media.bin");
    const canonicalPath = join(stateRoot, "canonical.wav");
    const bytes = Buffer.from("synthetic publication boundary fixture");
    const hash = createHash("sha256").update(bytes).digest("hex");
    await writeFile(mediaPath, bytes);
    await writeFile(canonicalPath, bytes);
    const makeSnapshot = (videoId: string) =>
      createAcquiredSnapshot({
        id: "snapshot_pending",
        byteFingerprint: `sha256:${hash}`,
        byteSize: bytes.length,
        canonicalAudioFingerprint: `sha256:${hash}`,
        durationSamples: 10,
        metadataObservationIds: [],
        observedAt: "2026-09-11T00:00:00Z",
        selectedFormat: {
          container: "mp4",
          audioCodec: "aac",
          mimeType: "audio/mp4",
          providerFormatId: "140",
        },
        provenance: {
          kind: "youtube_acquisition",
          acquisitionAttemptId: `attempt_${videoId.toLowerCase()}`,
          provider: "youtube",
          videoId,
          canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`,
          components: [{ id: "synthetic", version: "1", hash: `sha256:${hash}` }],
          policy: { id: "synthetic", version: "1", hash: `sha256:${hash}` },
          brokerSummary: {
            downloadedBytes: bytes.length,
            requestCount: 1,
            redirectCount: 0,
            wallTimeMs: 1,
          },
        },
      });
    const first = makeSnapshot("AAAAAAAAAAA");
    const second = makeSnapshot("BBBBBBBBBBB");
    for (const snapshot of [first, second])
      await library.publishYouTubeSnapshot({
        snapshot,
        mediaPath,
        canonicalPath,
        canonicalBytes: bytes.length,
        canonicalHash: hash,
        signal: new AbortController().signal,
        beforePublication: async () => undefined,
      });
    expect(await readdir(join(library.activeRoot, "source-snapshots", first.id))).toEqual([
      "snapshot.json",
    ]);
    await expect(
      library.publishYouTubeSnapshot({
        snapshot: makeSnapshot("CCCCCCCCCCC"),
        mediaPath,
        canonicalPath,
        canonicalBytes: bytes.length,
        canonicalHash: hash,
        signal: new AbortController().signal,
        beforePublication: async () => {
          throw new Error("cleanup_refused");
        },
      }),
    ).rejects.toThrow("cleanup_refused");
    expect(await readdir(join(library.activeRoot, "staging"))).toEqual([]);
    expect(await readdir(join(library.activeRoot, "source-snapshots"))).toHaveLength(2);
    const manifestPath = join(library.activeRoot, "source-snapshots", first.id, "snapshot.json");
    const original = await readFile(manifestPath);
    await writeFile(manifestPath, original.subarray(0, 10));
    const reopened = await openProjectLibrary({ stateRoot });
    expect((await reopened.listYouTubeSources()).map((source) => source.identity)).toEqual([
      { kind: "youtube", provider: "youtube", videoId: "BBBBBBBBBBB" },
    ]);
    expect((await reopened.listYouTubeSources())[0]?.snapshots[0]?.id).toBe(second.id);
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

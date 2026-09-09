import { createHash, randomUUID } from "node:crypto";
import { lstat, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";

import { canonicalSerialize } from "@open-chords/domain";
import { z } from "zod";

import { syncDirectory } from "./filesystem-durability.ts";
import { SourceMetadataObservationSchema, SourceRecordSchema } from "./project-library-records.ts";

const catalogSchema = z.strictObject({
  version: z.literal(1),
  sources: z.array(SourceRecordSchema).max(1000),
});
const filename = "youtube-sources.json";
type Source = z.infer<typeof SourceRecordSchema>;

export function mergeYouTubeSources(...groups: Source[][]): Source[] {
  const merged = new Map<string, Source>();
  const identities = new Map<string, string>();
  const observations = new Map<string, string>();
  for (const source of groups.flat()) {
    if (source.identity.kind !== "youtube") continue;
    const videoId = source.identity.videoId;
    const previous = merged.get(videoId);
    if (
      (previous && previous.id !== source.id) ||
      (identities.has(source.id) && identities.get(source.id) !== videoId)
    )
      throw new Error("YouTube Source identity conflict");
    identities.set(source.id, videoId);
    for (const observation of source.metadataObservations) {
      const content = canonicalSerialize({ videoId, observation });
      if (observations.has(observation.id) && observations.get(observation.id) !== content)
        throw new Error("Source metadata observations are immutable");
      observations.set(observation.id, content);
    }
    merged.set(
      videoId,
      previous
        ? {
            ...previous,
            metadataObservations: [
              ...new Map(
                [...previous.metadataObservations, ...source.metadataObservations].map((item) => [
                  item.id,
                  item,
                ]),
              ).values(),
            ],
            snapshots: [
              ...new Map(
                [...previous.snapshots, ...source.snapshots].map((item) => [item.id, item]),
              ).values(),
            ],
            locators: [
              ...new Map(
                [...previous.locators, ...source.locators].map((item) => [item.id, item]),
              ).values(),
            ],
          }
        : structuredClone(source),
    );
  }
  return [...merged.values()];
}

export async function readYouTubeSources(root: string) {
  const path = join(root, filename);
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.size > 8 * 1024 * 1024)
      throw new Error("YouTube Source catalog is invalid");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  const catalog = catalogSchema.parse(JSON.parse(await readFile(path, "utf8")));
  const seen = new Set<string>();
  for (const source of catalog.sources) {
    if (source.identity.kind !== "youtube" || seen.has(source.identity.videoId))
      throw new Error("YouTube Source catalog is invalid");
    seen.add(source.identity.videoId);
    if (
      new Set(source.metadataObservations.map((item) => item.id)).size !==
      source.metadataObservations.length
    )
      throw new Error("YouTube metadata identity is invalid");
  }
  return mergeYouTubeSources(catalog.sources);
}

export async function appendYouTubeObservation(
  root: string,
  videoId: string,
  raw: unknown,
  established: Source[],
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) throw new Error("Invalid YouTube video ID");
  const observation = SourceMetadataObservationSchema.parse(raw);
  if (observation.provider !== "youtube")
    throw new Error("Metadata provider does not match Source");
  const sources = mergeYouTubeSources(established, await readYouTubeSources(root)).map(
    (source) => ({ ...source, locators: [], snapshots: [] }),
  );
  let source = sources.find(
    (item) => item.identity.kind === "youtube" && item.identity.videoId === videoId,
  );
  if (!source) {
    source = {
      id: `source_youtube_${createHash("sha256").update(videoId).digest("hex")}`,
      identity: { kind: "youtube", provider: "youtube", videoId },
      locators: [],
      metadataObservations: [],
      snapshots: [],
    };
    sources.push(source);
  }
  const previous = sources
    .flatMap((item) => item.metadataObservations)
    .find((item) => item.id === observation.id);
  if (previous) {
    if (
      !source.metadataObservations.some((item) => item.id === observation.id) ||
      canonicalSerialize(previous) !== canonicalSerialize(observation)
    )
      throw new Error("Source metadata observations are immutable");
    return source;
  }
  if (source.metadataObservations.length >= 1000)
    throw new Error("YouTube metadata history limit reached");
  source.metadataObservations.push(observation);
  const data = canonicalSerialize(catalogSchema.parse({ version: 1, sources }));
  if (Buffer.byteLength(data) > 8 * 1024 * 1024)
    throw new Error("YouTube Source catalog limit reached");
  const temp = join(root, `${filename}.${randomUUID()}.tmp`);
  try {
    const file = await open(temp, "wx", 0o600);
    try {
      await file.writeFile(data);
      await file.sync();
    } finally {
      await file.close();
    }
    signal?.throwIfAborted();
    await rename(temp, join(root, filename));
    await syncDirectory(root);
  } finally {
    await rm(temp, { force: true });
  }
  return source;
}

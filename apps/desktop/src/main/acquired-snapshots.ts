import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, opendir, rename, rm } from "node:fs/promises";
import { join } from "node:path";

import { canonicalSerialize } from "@open-chords/domain";
import { z } from "zod";

import { copyAcquiredFile } from "./acquisition-files.ts";
import { AcquisitionSessionError } from "./acquisition-session.ts";
import { readBoundedFile } from "./bounded-file.ts";
import { syncDirectory } from "./filesystem-durability.ts";
import { SourceRecordSchema, SourceSnapshotSchema } from "./project-library-records.ts";

const Manifest = z.strictObject({
  version: z.literal(1),
  source: SourceRecordSchema,
  canonical: z.strictObject({
    bytes: z
      .number()
      .int()
      .positive()
      .max(512 * 1024 * 1024),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  }),
});
const snapshotId = (value: z.infer<typeof SourceSnapshotSchema>) => {
  const { id: _id, ...content } = value;
  return `snapshot_${createHash("sha256").update(canonicalSerialize(content)).digest("hex")}`;
};
export function createAcquiredSnapshot(input: unknown) {
  const parsed = SourceSnapshotSchema.parse(input);
  if (parsed.provenance.kind !== "youtube_acquisition")
    throw new Error("invalid_acquisition_snapshot");
  return { ...parsed, id: snapshotId(parsed) };
}

export async function readAcquiredSources(root: string) {
  const folder = join(root, "source-snapshots");
  try {
    if (!(await lstat(folder)).isDirectory()) return [];
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  const sources: z.infer<typeof SourceRecordSchema>[] = [];
  let inspected = 0;
  for await (const entry of await opendir(folder)) {
    if (++inspected > 1000) break;
    if (!entry.isDirectory() || !/^snapshot_[a-f0-9]{64}$/u.test(entry.name)) continue;
    try {
      const manifest = Manifest.parse(
        JSON.parse(
          (await readBoundedFile(join(folder, entry.name, "snapshot.json"), 65536)).toString(
            "utf8",
          ),
        ),
      );
      const snapshot = manifest.source.snapshots[0];
      if (
        !snapshot ||
        manifest.source.snapshots.length !== 1 ||
        snapshot.id !== entry.name ||
        snapshotId(snapshot) !== snapshot.id ||
        manifest.source.identity.kind !== "youtube" ||
        snapshot.provenance.kind !== "youtube_acquisition" ||
        manifest.source.identity.videoId !== snapshot.provenance.videoId ||
        snapshot.provenance.canonicalUrl !==
          `https://www.youtube.com/watch?v=${snapshot.provenance.videoId}`
      )
        throw new Error("invalid_acquisition_catalog");
      // Snapshot provenance survives independently of temporary acquisition media.
      sources.push(manifest.source);
    } catch {
      // One damaged immutable entry must not prevent opening unrelated Projects.
      // Their retained Source records still explain the unavailable Snapshot.
    }
  }
  return sources;
}

export class AcquisitionPublicationUncertain extends Error {
  constructor() {
    super("acquisition_publication_uncertain");
  }
}

export type AcquiredSnapshotPublication = {
  snapshot: z.infer<typeof SourceSnapshotSchema>;
  mediaPath: string;
  canonicalPath: string;
  canonicalBytes: number;
  canonicalHash: string;
  signal: AbortSignal;
  beforePublication(): Promise<void>;
};

export async function publishAcquiredSnapshot(
  root: string,
  sourceId: string,
  input: AcquiredSnapshotPublication,
) {
  const snapshot = SourceSnapshotSchema.parse(input.snapshot);
  if (
    snapshot.provenance.kind !== "youtube_acquisition" ||
    snapshot.id !== snapshotId(snapshot) ||
    snapshot.metadataObservationIds.length !== 0
  )
    throw new Error("invalid_acquisition_snapshot");
  const source = SourceRecordSchema.parse({
    id: sourceId,
    identity: { kind: "youtube", provider: "youtube", videoId: snapshot.provenance.videoId },
    locators: [],
    metadataObservations: [],
    snapshots: [snapshot],
  });
  const stagingRoot = join(root, "staging");
  const publishedRoot = join(root, "source-snapshots");
  for (const folder of [stagingRoot, publishedRoot]) {
    await mkdir(folder, { recursive: true, mode: 0o700 });
    if (!(await lstat(folder)).isDirectory()) throw new Error("invalid_acquisition_catalog");
  }
  await syncDirectory(root);
  const staging = join(stagingRoot, `acquisition-${randomUUID()}`);
  const destination = join(publishedRoot, snapshot.id);
  await mkdir(staging, { mode: 0o700 });
  try {
    input.signal.throwIfAborted();
    await copyAcquiredFile(input.mediaPath, join(staging, "media.bin"), {
      bytes: snapshot.byteSize,
      sha256: snapshot.byteFingerprint.slice(7),
    });
    await copyAcquiredFile(input.canonicalPath, join(staging, "canonical.wav"), {
      bytes: input.canonicalBytes,
      sha256: input.canonicalHash,
    });
    const manifest = canonicalSerialize(
      Manifest.parse({
        version: 1,
        source,
        canonical: { bytes: input.canonicalBytes, sha256: input.canonicalHash },
      }),
    );
    if (Buffer.byteLength(manifest) > 65536) throw new Error("invalid_acquisition_snapshot");
    const file = await open(join(staging, "snapshot.json"), "wx", 0o600);
    try {
      await file.writeFile(manifest);
      await file.sync();
    } finally {
      await file.close();
    }
    // Snapshot storage contains provenance only. Full-source media is temporary,
    // and must not silently become an opt-in Offline Media Cache entry.
    await rm(join(staging, "media.bin"));
    await rm(join(staging, "canonical.wav"));
    await syncDirectory(staging);
    await input.beforePublication();
    input.signal.throwIfAborted();
    await rename(staging, destination);
    try {
      await syncDirectory(publishedRoot);
    } catch (error) {
      try {
        await rename(destination, staging);
        await syncDirectory(publishedRoot);
      } catch {
        throw new AcquisitionPublicationUncertain();
      }
      throw error;
    }
    return source;
  } catch (error) {
    try {
      await rm(staging, { recursive: true, force: true });
    } catch {
      if (error instanceof AcquisitionPublicationUncertain) throw error;
      throw new AcquisitionSessionError("cleanup_failure");
    }
    throw error;
  }
}

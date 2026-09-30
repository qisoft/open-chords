import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";

import { canonicalSerialize, StableIdSchema } from "@open-chords/domain";
import { z } from "zod";

import { readBoundedFile } from "./bounded-file.ts";
import { syncDirectory } from "./filesystem-durability.ts";

const MAX_ENTRY_BYTES = 128 * 1024 * 1024;
const MAX_ENTRIES = 10_000;
const Sha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const EntryIdSchema = z.string().regex(/^cache_[a-f0-9]{32}$/);

export const OfflineMediaRangeSchema = z
  .strictObject({
    canonicalAudioFingerprint: Sha256Schema,
    endSourceSample: z.number().int().positive(),
    sampleRate: z.number().int().positive().max(384_000),
    sourceId: StableIdSchema,
    sourceSnapshotId: StableIdSchema,
    startSourceSample: z.number().int().nonnegative(),
  })
  .refine((range) => range.endSourceSample > range.startSourceSample);

const EntryRecordSchema = z.strictObject({
  byteSize: z.number().int().positive().max(MAX_ENTRY_BYTES),
  channels: z.literal(1),
  createdAt: z.iso.datetime({ offset: true }),
  encoding: z.literal("pcm_s16le"),
  format: z.literal("open-chords/offline-media-cache-entry"),
  id: EntryIdSchema,
  origin: z.strictObject({
    archiveManifestHash: Sha256Schema,
    kind: z.literal("portable_project_archive"),
  }),
  range: OfflineMediaRangeSchema,
  schemaVersion: z.literal("1.0"),
  sha256: Sha256Schema,
});

export type OfflineMediaRange = z.infer<typeof OfflineMediaRangeSchema>;
export type OfflineMediaCacheEntry = z.infer<typeof EntryRecordSchema>;

const digest = (bytes: Buffer | string) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

export function offlineMediaEntryId(range: OfflineMediaRange): string {
  const identity = canonicalSerialize({
    endSourceSample: range.endSourceSample,
    sourceSnapshotId: range.sourceSnapshotId,
    startSourceSample: range.startSourceSample,
  });
  return `cache_${digest(identity).slice("sha256:".length, "sha256:".length + 32)}`;
}

export class OfflineMediaConflictError extends Error {
  constructor() {
    super("A different verified Offline Media Cache entry already covers this Project Range");
    this.name = "OfflineMediaConflictError";
  }
}

export async function openOfflineMediaCache(options: { stateRoot: string; now?: () => Date }) {
  const root = join(options.stateRoot, "offline-media-cache");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("Invalid Offline Media Cache directory");
  return new OfflineMediaCache(root, options.now ?? (() => new Date()));
}

export class OfflineMediaCache {
  readonly #root: string;
  readonly #now: () => Date;
  #tail: Promise<unknown> = Promise.resolve();

  constructor(root: string, now: () => Date) {
    this.#root = root;
    this.#now = now;
  }

  store(input: {
    archiveManifestHash: string;
    bytes: Buffer;
    range: OfflineMediaRange;
  }): Promise<{ entry: OfflineMediaCacheEntry; state: "cached" | "already_cached" }> {
    return this.#serialize(async () => {
      const range = OfflineMediaRangeSchema.parse(input.range);
      const sampleCount = range.endSourceSample - range.startSourceSample;
      if (input.bytes.length !== sampleCount * 2 || input.bytes.length > MAX_ENTRY_BYTES)
        throw new Error("Offline Media Cache bytes do not cover the Project Range");
      const id = offlineMediaEntryId(range);
      const sha256 = digest(input.bytes);
      const existing = await this.#verified(id);
      if (existing !== null) {
        if (
          existing.sha256 !== sha256 ||
          canonicalSerialize(existing.range) !== canonicalSerialize(range)
        )
          throw new OfflineMediaConflictError();
        return { entry: existing, state: "already_cached" as const };
      }
      const entry = EntryRecordSchema.parse({
        byteSize: input.bytes.length,
        channels: 1,
        createdAt: this.#now().toISOString(),
        encoding: "pcm_s16le",
        format: "open-chords/offline-media-cache-entry",
        id,
        origin: {
          archiveManifestHash: input.archiveManifestHash,
          kind: "portable_project_archive",
        },
        range,
        schemaVersion: "1.0",
        sha256,
      });
      await this.#installDurably(`${id}.pcm`, input.bytes);
      await this.#installDurably(`${id}.json`, Buffer.from(canonicalSerialize(entry), "utf8"));
      return { entry, state: "cached" as const };
    });
  }

  async list(): Promise<OfflineMediaCacheEntry[]> {
    const names = await readdir(this.#root);
    if (names.length > MAX_ENTRIES * 3) throw new Error("Offline Media Cache is too large to list");
    const entries = await Promise.all(
      names
        .filter((name) => /^cache_[a-f0-9]{32}\.json$/.test(name))
        .map((name) => this.#verified(name.slice(0, -".json".length))),
    );
    return entries.filter((entry): entry is OfflineMediaCacheEntry => entry !== null);
  }

  async read(id: string): Promise<Buffer | null> {
    const entry = await this.#record(EntryIdSchema.parse(id));
    if (entry === null) return null;
    try {
      const bytes = await readBoundedFile(join(this.#root, `${entry.id}.pcm`), entry.byteSize);
      return bytes.length === entry.byteSize && digest(bytes) === entry.sha256 ? bytes : null;
    } catch {
      return null;
    }
  }

  remove(id: string): Promise<void> {
    return this.#serialize(async () => {
      const entryId = EntryIdSchema.parse(id);
      await rm(join(this.#root, `${entryId}.json`), { force: true });
      await rm(join(this.#root, `${entryId}.pcm`), { force: true });
      await syncDirectory(this.#root);
    });
  }

  async #verified(id: string): Promise<OfflineMediaCacheEntry | null> {
    const entry = await this.#record(id);
    return entry !== null && (await this.read(id)) !== null ? entry : null;
  }

  async #record(id: string): Promise<OfflineMediaCacheEntry | null> {
    try {
      const entry = EntryRecordSchema.parse(
        JSON.parse(
          (await readBoundedFile(join(this.#root, `${id}.json`), 64 * 1024)).toString("utf8"),
        ),
      );
      return entry.id === id && offlineMediaEntryId(entry.range) === id ? entry : null;
    } catch {
      return null;
    }
  }

  async #installDurably(name: string, bytes: Buffer): Promise<void> {
    const temporary = join(this.#root, `.${randomUUID()}.tmp`);
    try {
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(bytes);
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, join(this.#root, name));
      await syncDirectory(this.#root);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation, operation);
    this.#tail = result.catch(() => undefined);
    return result;
  }
}

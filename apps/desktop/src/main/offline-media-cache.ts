import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, rename, rm, statfs } from "node:fs/promises";
import { join } from "node:path";

import {
  OFFLINE_MEDIA_CACHE_CAPACITY_BYTES,
  OFFLINE_MEDIA_FREE_DISK_RESERVE_BYTES,
} from "@open-chords/contracts";
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
  verification: z.enum(["archive_attested", "snapshot_fingerprint"]),
});

export type OfflineMediaVerification = z.infer<typeof EntryRecordSchema>["verification"];
export type OfflineMediaRange = z.infer<typeof OfflineMediaRangeSchema>;
export type OfflineMediaCacheEntry = z.infer<typeof EntryRecordSchema>;

const digest = (bytes: Buffer | string) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

export function offlineMediaEntryId(range: OfflineMediaRange): string {
  const identity = canonicalSerialize({
    canonicalAudioFingerprint: range.canonicalAudioFingerprint,
    endSourceSample: range.endSourceSample,
    sourceId: range.sourceId,
    sourceSnapshotId: range.sourceSnapshotId,
    startSourceSample: range.startSourceSample,
  });
  return `cache_${digest(identity).slice("sha256:".length, "sha256:".length + 32)}`;
}

export type OfflineMediaBlockReason = "capacity" | "conflicting_entry" | "disk_space";

export class OfflineMediaBlockedError extends Error {
  readonly reason: OfflineMediaBlockReason;
  constructor(reason: OfflineMediaBlockReason) {
    super(`Offline Media Cache entry blocked: ${reason}`);
    this.name = "OfflineMediaBlockedError";
    this.reason = reason;
  }
}

type CacheOptions = {
  capacityBytes?: number;
  freeDiskBytes?: (root: string) => Promise<number>;
  now?: () => Date;
  reserveBytes?: number;
  stateRoot: string;
};

export async function openOfflineMediaCache(options: CacheOptions) {
  const root = join(options.stateRoot, "offline-media-cache");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("Invalid Offline Media Cache directory");
  return new OfflineMediaCache(root, {
    capacityBytes: options.capacityBytes ?? OFFLINE_MEDIA_CACHE_CAPACITY_BYTES,
    freeDiskBytes: options.freeDiskBytes ?? freeDiskBytes,
    now: options.now ?? (() => new Date()),
    reserveBytes: options.reserveBytes ?? OFFLINE_MEDIA_FREE_DISK_RESERVE_BYTES,
  });
}

async function freeDiskBytes(root: string): Promise<number> {
  const stats = await statfs(root);
  return stats.bavail * stats.bsize;
}

export class OfflineMediaCache {
  readonly #root: string;
  readonly #options: Required<Omit<CacheOptions, "stateRoot">>;
  #tail: Promise<unknown> = Promise.resolve();

  constructor(root: string, options: Required<Omit<CacheOptions, "stateRoot">>) {
    this.#root = root;
    this.#options = options;
  }

  get capacityBytes() {
    return this.#options.capacityBytes;
  }

  // A cache entry never replaces an equal or stronger attestation. Only bytes proven
  // against a retained Snapshot fingerprint may replace an archive-attested entry.
  store(input: {
    archiveManifestHash: string;
    bytes: Buffer;
    range: OfflineMediaRange;
    verification: OfflineMediaVerification;
  }): Promise<{ entry: OfflineMediaCacheEntry; state: "cached" | "already_cached" }> {
    return this.#serialize(async () => {
      const range = OfflineMediaRangeSchema.parse(input.range);
      const sampleCount = range.endSourceSample - range.startSourceSample;
      if (input.bytes.length !== sampleCount * 2 || input.bytes.length > MAX_ENTRY_BYTES)
        throw new Error("Offline Media Cache bytes do not cover the Project Range");
      if (
        input.verification === "snapshot_fingerprint" &&
        (range.startSourceSample !== 0 || digest(input.bytes) !== range.canonicalAudioFingerprint)
      )
        throw new Error("Snapshot-fingerprint media must equal the Snapshot canonical audio");
      const id = offlineMediaEntryId(range);
      const sha256 = digest(input.bytes);
      const existing = await this.#verified(id);
      if (existing !== null) {
        const stronger =
          existing.verification === "archive_attested" &&
          input.verification === "snapshot_fingerprint";
        if (existing.sha256 === sha256 && !stronger)
          return { entry: existing, state: "already_cached" as const };
        if (!stronger) throw new OfflineMediaBlockedError("conflicting_entry");
      }
      const used = (await this.list())
        .filter((entry) => entry.id !== id)
        .reduce((total, entry) => total + entry.byteSize, 0);
      if (used + input.bytes.length > this.#options.capacityBytes)
        throw new OfflineMediaBlockedError("capacity");
      if (
        (await this.#options.freeDiskBytes(this.#root)) - input.bytes.length <
        this.#options.reserveBytes
      )
        throw new OfflineMediaBlockedError("disk_space");
      const entry = EntryRecordSchema.parse({
        byteSize: input.bytes.length,
        channels: 1,
        createdAt: this.#options.now().toISOString(),
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
        verification: input.verification,
      });
      if (existing !== null) {
        await rm(join(this.#root, `${id}.json`), { force: true });
        await syncDirectory(this.#root);
      }
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

import { createHash, randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { CONTRACT_VERSION, ProjectEnvelopeSchema } from "@open-chords/contracts";
import { parseProjectContract } from "@open-chords/domain";

import { ProjectOwnedRecordsSchema, type ProjectOwnedRecords } from "./project-library-records.ts";
import type { ProjectLibrary } from "./project-library.ts";

const MAX_PROBE_BYTES = 64 * 1024;
const HASH_CHUNK_BYTES = 1024 * 1024;
const MAX_PLAYBACK_RANGE_BYTES = 8 * 1024 * 1024;
const MAX_CONCURRENT_VERIFIED_READS = 8;
const MAX_PLAYBACK_CAPABILITIES_PER_GENERATION = 8;
const CANONICAL_SAMPLE_RATE = 48_000;
const LOCAL_MEDIA_COMPONENT_HASH = sha256("open-chords/local-media/wav-pcm-s16le/v1");

type VerifiedLocalMedia = {
  audioCodec: "pcm_s16le";
  byteFingerprint: string;
  byteSize: number;
  canonicalAudioFingerprint: string;
  container: "wav";
  dataOffset: number;
  durationSamples: number;
  handle: LocalMediaFileHandle;
  identity: FileIdentity;
  mimeType: "audio/wav";
  path: string;
  sampleRate: number;
};

type FileIdentity = {
  ctimeNs: bigint;
  dev: bigint;
  ino: bigint;
  mode: bigint;
  mtimeNs: bigint;
  size: bigint;
};

type LocalFileLocator = Extract<
  ProjectOwnedRecords["sources"][number]["locators"][number],
  { kind: "local_file" }
>;

class VerifiedMediaLease {
  readonly media: VerifiedLocalMedia;
  readonly #cleanup: MediaHandleCleanup;
  #ownsHandle = true;

  constructor(media: VerifiedLocalMedia, cleanup: MediaHandleCleanup) {
    this.media = media;
    this.#cleanup = cleanup;
  }

  move(): VerifiedMediaLease {
    if (!this.#ownsHandle) throw new Error("Verified media lease is no longer owned");
    this.#ownsHandle = false;
    return new VerifiedMediaLease(this.media, this.#cleanup);
  }

  async release(): Promise<void> {
    if (!this.#ownsHandle) return;
    await this.#cleanup.release(this.media.handle);
    this.#ownsHandle = false;
  }
}

class MediaHandleCleanup {
  readonly #closing = new Map<LocalMediaFileHandle, Promise<void>>();
  readonly #failed = new Set<LocalMediaFileHandle>();
  readonly #retained = new Set<LocalMediaFileHandle>();

  retain(handle: LocalMediaFileHandle): void {
    this.#retained.add(handle);
  }

  async release(handle: LocalMediaFileHandle): Promise<void> {
    if (!this.#retained.has(handle)) return;
    const activeClose = this.#closing.get(handle);
    if (activeClose !== undefined) return activeClose;
    const close = Promise.resolve().then(() => handle.close());
    this.#closing.set(handle, close);
    try {
      await close;
      this.#failed.delete(handle);
      this.#retained.delete(handle);
    } catch (error) {
      this.#failed.add(handle);
      throw error;
    } finally {
      if (this.#closing.get(handle) === close) this.#closing.delete(handle);
    }
  }

  async retryFailed(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.#failed].map((handle) => this.release(handle)),
    );
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failure !== undefined) throw failure.reason;
  }

  async releaseAllRetained(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.#retained].map((handle) => this.release(handle)),
    );
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failure !== undefined) throw failure.reason;
  }
}

class RevokedMediaGenerationError extends Error {
  constructor() {
    super("Local media capability is unavailable because its generation was revoked");
  }
}

type SelectionCapabilityEntry = {
  generationId: string;
  lease: VerifiedMediaLease;
};

type PlaybackCapabilityEntry = {
  generationId: string;
  lease: VerifiedMediaLease;
  projectId: string;
};

class MediaCapabilityRegistry {
  readonly #activeOperations = new Map<string, Set<Promise<void>>>();
  readonly #activeGenerations = new Set<string>();
  readonly #cleanup: MediaHandleCleanup;
  readonly #generationQueues = new Map<string, Promise<void>>();
  readonly #playback = new Map<string, PlaybackCapabilityEntry>();
  readonly #selection = new Map<string, SelectionCapabilityEntry>();
  readonly #serviceOperations = new Set<Promise<void>>();
  #disposePromise: Promise<void> | undefined;
  #disposed = false;

  constructor(cleanup: MediaHandleCleanup) {
    this.#cleanup = cleanup;
  }

  activateGeneration(generationId: string): void {
    this.#assertNotDisposed();
    if (this.#activeGenerations.has(generationId)) {
      throw new Error("Local media generation is already active");
    }
    this.#activeGenerations.add(generationId);
  }

  beginOperation(generationId: string): () => void {
    this.#assertNotDisposed();
    this.#assertGenerationActive(generationId);
    let finish!: () => void;
    const completed = new Promise<void>((completeOperation) => {
      finish = completeOperation;
    });
    const operations = this.#activeOperations.get(generationId) ?? new Set();
    operations.add(completed);
    this.#activeOperations.set(generationId, operations);
    this.#serviceOperations.add(completed);
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      operations.delete(completed);
      if (operations.size === 0) this.#activeOperations.delete(generationId);
      this.#serviceOperations.delete(completed);
      finish();
    };
  }

  beginServiceOperation(): () => void {
    this.#assertNotDisposed();
    let finish!: () => void;
    const completed = new Promise<void>((completeOperation) => {
      finish = completeOperation;
    });
    this.#serviceOperations.add(completed);
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      this.#serviceOperations.delete(completed);
      finish();
    };
  }

  consumeSelection(capabilityId: string, generationId: string): Promise<VerifiedMediaLease | null> {
    return this.#runGenerationTask(generationId, true, async () => {
      const entry = this.#selection.get(capabilityId);
      if (entry === undefined || entry.generationId !== generationId) return null;
      this.#selection.delete(capabilityId);
      return entry.lease;
    });
  }

  playback(capabilityId: string): VerifiedMediaLease | null {
    return this.#playback.get(capabilityId)?.lease ?? null;
  }

  async publishIfActive<T>(
    generationId: string,
    publish: () => Promise<T>,
    cleanupLeases: readonly VerifiedMediaLease[] = [],
  ): Promise<T> {
    return this.#runGenerationTask(generationId, true, publish, async () => {
      await releaseLeasesSuppressingCleanupErrors(cleanupLeases);
    });
  }

  async replaceSelection(generationId: string, lease: VerifiedMediaLease): Promise<string> {
    return this.#runGenerationTask(generationId, true, async () => {
      await this.#cleanup.retryFailed();
      const releases: VerifiedMediaLease[] = [];
      for (const [capabilityId, entry] of this.#selection) {
        if (entry.generationId !== generationId) continue;
        this.#selection.delete(capabilityId);
        releases.push(entry.lease);
      }
      await releaseLeases(releases);
      const capabilityId = opaqueId("mediacapability");
      this.#selection.set(capabilityId, { generationId, lease: lease.move() });
      return capabilityId;
    });
  }

  async replacePlayback(
    generationId: string,
    projectId: string,
    lease: VerifiedMediaLease,
  ): Promise<string> {
    return this.#runGenerationTask(generationId, true, async () => {
      await this.#cleanup.retryFailed();
      const generationCapabilities: string[] = [];
      const releases: VerifiedMediaLease[] = [];
      for (const [capabilityId, entry] of this.#playback) {
        if (entry.generationId !== generationId) continue;
        if (entry.projectId === projectId) {
          this.#playback.delete(capabilityId);
          releases.push(entry.lease);
        } else generationCapabilities.push(capabilityId);
      }
      while (generationCapabilities.length >= MAX_PLAYBACK_CAPABILITIES_PER_GENERATION) {
        const oldestCapabilityId = generationCapabilities.shift();
        if (oldestCapabilityId === undefined) break;
        const oldest = this.#playback.get(oldestCapabilityId);
        this.#playback.delete(oldestCapabilityId);
        if (oldest !== undefined) releases.push(oldest.lease);
      }
      await releaseLeases(releases);
      const capabilityId = opaqueId("playbackcapability");
      this.#playback.set(capabilityId, { generationId, lease: lease.move(), projectId });
      return capabilityId;
    });
  }

  async revokeGeneration(generationId: string): Promise<void> {
    if (this.#disposed) return this.#disposePromise;
    this.#activeGenerations.delete(generationId);
    await Promise.all([...(this.#activeOperations.get(generationId) ?? [])]);
    await this.#runGenerationTask(generationId, false, async () => {
      const releases: VerifiedMediaLease[] = [];
      for (const [capabilityId, entry] of this.#selection) {
        if (entry.generationId !== generationId) continue;
        this.#selection.delete(capabilityId);
        releases.push(entry.lease);
      }
      for (const [capabilityId, entry] of this.#playback) {
        if (entry.generationId !== generationId) continue;
        this.#playback.delete(capabilityId);
        releases.push(entry.lease);
      }
      await releaseLeases(releases);
      await this.#cleanup.retryFailed();
    });
  }

  dispose(): Promise<void> {
    if (this.#disposePromise !== undefined) return this.#disposePromise;
    this.#disposed = true;
    this.#activeGenerations.clear();
    this.#disposePromise = this.#drainForDisposal();
    return this.#disposePromise;
  }

  #assertGenerationActive(generationId: string): void {
    this.#assertNotDisposed();
    if (!this.#activeGenerations.has(generationId)) throw new RevokedMediaGenerationError();
  }

  #assertNotDisposed(): void {
    if (this.#disposed) throw new Error("Local media service is disposed");
  }

  async #drainForDisposal(): Promise<void> {
    await Promise.all([...this.#serviceOperations]);
    await Promise.all([...this.#generationQueues.values()]);
    this.#selection.clear();
    this.#playback.clear();
    await this.#cleanup.releaseAllRetained();
  }

  async #runGenerationTask<T>(
    generationId: string,
    requireActive: boolean,
    task: () => Promise<T>,
    cleanup: () => Promise<void> = async () => undefined,
  ): Promise<T> {
    const prior = this.#generationQueues.get(generationId) ?? Promise.resolve();
    const result = prior
      .catch(() => undefined)
      .then(async () => {
        try {
          if (requireActive) this.#assertGenerationActive(generationId);
          return await task();
        } finally {
          await cleanup();
        }
      });
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.#generationQueues.set(generationId, tail);
    try {
      return await result;
    } finally {
      if (this.#generationQueues.get(generationId) === tail) {
        this.#generationQueues.delete(generationId);
      }
    }
  }
}

async function releaseLeases(leases: readonly VerifiedMediaLease[]): Promise<void> {
  const results = await Promise.allSettled(leases.map((lease) => lease.release()));
  const failure = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failure !== undefined) throw failure.reason;
}

async function releaseLeasesSuppressingCleanupErrors(
  leases: readonly VerifiedMediaLease[],
): Promise<void> {
  await Promise.allSettled(leases.map((lease) => lease.release()));
}

type MediaSelectionCapability = {
  byteSize: number;
  capabilityId: string;
  durationSamples: number;
  mimeType: string;
  sampleRate: number;
};

export type LocalMediaSelection =
  | { kind: "cancelled" }
  | (MediaSelectionCapability & {
      kind: "selected";
    });

export type LocalMediaRelinkResult =
  | { kind: "cancelled" }
  | { kind: "relinked"; sourceId: string }
  | (MediaSelectionCapability & {
      kind: "different_source";
    });

export type LocalMediaPlayback =
  | { kind: "unavailable"; projectId: string; sourceId: string }
  | {
      byteSize: number;
      capabilityId: string;
      endSourceSample: number;
      kind: "ready";
      mimeType: string;
      playbackUrl: string;
      projectId: string;
      sampleRate: number;
      startSourceSample: number;
    };

export type LocalMediaServiceOptions = {
  fileSystem?: LocalMediaFileSystem;
  library: ProjectLibrary;
  now?: () => Date;
  pickFile: () => Promise<string | null>;
  rangeCache?: LocalMediaRangeCache;
};

export type LocalMediaFileHandle = {
  close(): Promise<void>;
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }>;
  stat(options: { bigint: true }): Promise<BigIntStats>;
};

export type LocalMediaFileSystem = {
  lstat(path: string): Promise<BigIntStats>;
  open(path: string, flags: number): Promise<LocalMediaFileHandle>;
};

export const nodeLocalMediaFileSystem: LocalMediaFileSystem = {
  lstat: (path) => lstat(path, { bigint: true }),
  open,
};

export type LocalMediaRangeCache = {
  cacheProjectRange(input: {
    canonicalAudioFingerprint: string;
    endSourceSample: number;
    projectId: string;
    readCanonicalPcm: (range: {
      endProjectSample: number;
      startProjectSample: number;
    }) => Promise<Uint8Array>;
    sampleRate: number;
    sourceId: string;
    sourceSnapshotId: string;
    startSourceSample: number;
  }): Promise<void>;
};

export class LocalMediaService {
  readonly #capabilities: MediaCapabilityRegistry;
  readonly #cleanup = new MediaHandleCleanup();
  readonly #fileSystem: LocalMediaFileSystem;
  readonly #library: ProjectLibrary;
  readonly #now: () => Date;
  readonly #pickFile: () => Promise<string | null>;
  readonly #rangeCache: LocalMediaRangeCache | undefined;
  #activeVerifiedReads = 0;

  constructor(options: LocalMediaServiceOptions) {
    this.#capabilities = new MediaCapabilityRegistry(this.#cleanup);
    this.#fileSystem = options.fileSystem ?? nodeLocalMediaFileSystem;
    this.#library = options.library;
    this.#now = options.now ?? (() => new Date());
    this.#pickFile = options.pickFile;
    this.#rangeCache = options.rangeCache;
  }

  activateGeneration(generationId: string): void {
    this.#capabilities.activateGeneration(generationId);
  }

  revokeGeneration(generationId: string): Promise<void> {
    return this.#capabilities.revokeGeneration(generationId);
  }

  dispose(): Promise<void> {
    return this.#capabilities.dispose();
  }

  pickLocalFile(generationId: string): Promise<LocalMediaSelection> {
    return this.#runGenerationOperation(generationId, () => this.#pickLocalFile(generationId));
  }

  async #pickLocalFile(generationId: string): Promise<LocalMediaSelection> {
    const selectedPath = await this.#pickFile();
    if (selectedPath === null) return { kind: "cancelled" };
    const lease = await this.#verifyLocalWav(selectedPath);
    try {
      const capabilityId = await this.#capabilities.replaceSelection(generationId, lease);
      return {
        byteSize: lease.media.byteSize,
        capabilityId,
        durationSamples: lease.media.durationSamples,
        kind: "selected",
        mimeType: lease.media.mimeType,
        sampleRate: lease.media.sampleRate,
      };
    } finally {
      await releaseLeasesSuppressingCleanupErrors([lease]);
    }
  }

  createProject(input: {
    capabilityId: string;
    endSourceSample: number;
    generationId: string;
    startSourceSample: number;
  }): Promise<{ projectId: string; projectRevisionId: string; sourceId: string }> {
    return this.#runGenerationOperation(input.generationId, () => this.#createProject(input));
  }

  async #createProject(input: {
    capabilityId: string;
    endSourceSample: number;
    generationId: string;
    startSourceSample: number;
  }): Promise<{ projectId: string; projectRevisionId: string; sourceId: string }> {
    const selectedLease = await this.#capabilities.consumeSelection(
      input.capabilityId,
      input.generationId,
    );
    if (selectedLease === null) {
      throw new Error("Local media capability is unavailable");
    }
    let cleanupQueued = false;
    let reverifiedLease: VerifiedMediaLease | undefined;
    try {
      const selected = selectedLease.media;
      assertProjectRange(input, selected.durationSamples);
      reverifiedLease = await this.#verifyLocalWav(selected.path);
      const capability = reverifiedLease.media;
      if (capability.byteFingerprint !== selected.byteFingerprint) {
        throw new Error("Selected media changed before Project creation");
      }
      assertSameFileIdentity(selected.identity, capability.identity);

      const observedAt = this.#now().toISOString();
      const existingSource = this.#library.findLocalFileSourceByFingerprint(
        capability.byteFingerprint,
      );
      const sourceId = existingSource?.id ?? sourceIdFor(capability.byteFingerprint);
      const locator = {
        fingerprint: capability.byteFingerprint,
        id: opaqueId("locator"),
        kind: "local_file" as const,
        path: capability.path,
        status: "available" as const,
        verifiedAt: observedAt,
      };
      const source = existingSource ?? {
        id: sourceId,
        identity: { fingerprint: capability.byteFingerprint, kind: "local_file" as const },
        locators: [],
        metadataObservations: [],
        snapshots: [
          {
            byteFingerprint: capability.byteFingerprint,
            byteSize: capability.byteSize,
            canonicalAudioFingerprint: capability.canonicalAudioFingerprint,
            durationSamples: capability.durationSamples,
            id: snapshotIdFor(capability.byteFingerprint),
            metadataObservationIds: [],
            observedAt,
            provenance: {
              components: [
                {
                  hash: LOCAL_MEDIA_COMPONENT_HASH,
                  id: "open-chords-local-wav-probe",
                  version: "1.0",
                },
              ],
              kind: "local_file" as const,
            },
            selectedFormat: {
              audioCodec: capability.audioCodec,
              container: capability.container,
              mimeType: capability.mimeType,
            },
          },
        ],
      };
      const records = ProjectOwnedRecordsSchema.parse({
        exportReceipts: [],
        extensions: {},
        projectRange: {
          endSourceSample: input.endSourceSample,
          sourceId,
          startSourceSample: input.startSourceSample,
        },
        sources: [{ ...source, locators: [...source.locators, locator] }],
      });
      const projectId = opaqueId("project");
      const envelope = buildUnanalyzedProjectEnvelope({
        durationSamples: input.endSourceSample - input.startSourceSample,
        projectId,
        sampleRate: capability.sampleRate,
      });
      cleanupQueued = true;
      const created = await this.#capabilities.publishIfActive(
        input.generationId,
        async () => this.#library.createProject({ envelope, records }),
        [selectedLease, reverifiedLease],
      );
      return { projectId, projectRevisionId: created.projectRevisionId, sourceId };
    } finally {
      if (!cleanupQueued) {
        await releaseLeasesSuppressingCleanupErrors([
          selectedLease,
          ...(reverifiedLease === undefined ? [] : [reverifiedLease]),
        ]);
      }
    }
  }

  relinkSource(input: { generationId: string; sourceId: string }): Promise<LocalMediaRelinkResult> {
    return this.#runGenerationOperation(input.generationId, () => this.#relinkSource(input));
  }

  async #relinkSource(input: {
    generationId: string;
    sourceId: string;
  }): Promise<LocalMediaRelinkResult> {
    const selectedPath = await this.#pickFile();
    if (selectedPath === null) return { kind: "cancelled" };
    const lease = await this.#verifyLocalWav(selectedPath);
    let cleanupQueued = false;
    try {
      const verified = lease.media;
      const source = this.#library.getSourceById(input.sourceId);
      if (source === undefined) throw new Error("Source is unavailable");
      if (
        source.identity.kind !== "local_file" ||
        source.identity.fingerprint !== verified.byteFingerprint
      ) {
        const capabilityId = await this.#capabilities.replaceSelection(input.generationId, lease);
        return {
          byteSize: verified.byteSize,
          capabilityId,
          durationSamples: verified.durationSamples,
          kind: "different_source",
          mimeType: verified.mimeType,
          sampleRate: verified.sampleRate,
        };
      }
      cleanupQueued = true;
      await this.#capabilities.publishIfActive(
        input.generationId,
        async () =>
          this.#library.observeSourceLocator(input.sourceId, {
            fingerprint: verified.byteFingerprint,
            id: opaqueId("locator"),
            kind: "local_file",
            path: verified.path,
            status: "available",
            verifiedAt: this.#now().toISOString(),
          }),
        [lease],
      );
      return { kind: "relinked", sourceId: input.sourceId };
    } finally {
      if (!cleanupQueued) await releaseLeasesSuppressingCleanupErrors([lease]);
    }
  }

  openPlayback(input: { generationId: string; projectId: string }): Promise<LocalMediaPlayback> {
    return this.#runGenerationOperation(input.generationId, () => this.#openPlayback(input));
  }

  async #openPlayback(input: {
    generationId: string;
    projectId: string;
  }): Promise<LocalMediaPlayback> {
    const project = await this.#library.readProject(input.projectId);
    const range = project.records.projectRange;
    const source = project.records.sources.find(({ id }) => id === range.sourceId);
    if (source === undefined || source.identity.kind !== "local_file") {
      return { kind: "unavailable", projectId: input.projectId, sourceId: range.sourceId };
    }
    const locators = source.locators
      .filter(
        (locator): locator is LocalFileLocator =>
          locator.kind === "local_file" && locator.status === "available",
      )
      .toSorted((left, right) => Date.parse(right.verifiedAt) - Date.parse(left.verifiedAt));
    for (const locator of locators) {
      let lease: VerifiedMediaLease;
      try {
        lease = await this.#verifyLocalWav(locator.path);
      } catch {
        await this.#markLocatorUnavailable(source.id, locator);
        continue;
      }
      try {
        const verified = lease.media;
        if (verified.byteFingerprint !== source.identity.fingerprint) {
          await this.#markLocatorUnavailable(source.id, locator);
          continue;
        }
        const capabilityId = await this.#capabilities.replacePlayback(
          input.generationId,
          input.projectId,
          lease,
        );
        return {
          byteSize: verified.byteSize,
          capabilityId,
          endSourceSample: range.endSourceSample,
          kind: "ready",
          mimeType: verified.mimeType,
          playbackUrl: `open-chords://app/media/${capabilityId}`,
          projectId: input.projectId,
          sampleRate: verified.sampleRate,
          startSourceSample: range.startSourceSample,
        };
      } finally {
        await releaseLeasesSuppressingCleanupErrors([lease]);
      }
    }
    return { kind: "unavailable", projectId: input.projectId, sourceId: source.id };
  }

  readPlaybackRange(input: {
    capabilityId: string;
    endByteExclusive?: number;
    startByte: number;
  }): Promise<{
    byteSize: number;
    bytes: Buffer;
    endByteExclusive: number;
    mimeType: string;
    startByte: number;
  }> {
    return this.#runServiceOperation(() => this.#readPlaybackRange(input));
  }

  async #readPlaybackRange(input: {
    capabilityId: string;
    endByteExclusive?: number;
    startByte: number;
  }): Promise<{
    byteSize: number;
    bytes: Buffer;
    endByteExclusive: number;
    mimeType: string;
    startByte: number;
  }> {
    const lease = this.#capabilities.playback(input.capabilityId);
    if (lease === null) throw new Error("Playback capability is unavailable");
    const capability = lease.media;
    const endByteExclusive =
      input.endByteExclusive ??
      Math.min(capability.byteSize, input.startByte + MAX_PLAYBACK_RANGE_BYTES);
    if (
      !Number.isSafeInteger(input.startByte) ||
      !Number.isSafeInteger(endByteExclusive) ||
      input.startByte < 0 ||
      endByteExclusive <= input.startByte ||
      endByteExclusive > capability.byteSize ||
      endByteExclusive - input.startByte > MAX_PLAYBACK_RANGE_BYTES
    ) {
      throw new Error("Playback byte range is invalid or exceeds its limit");
    }
    const bytes = await this.#readVerifiedBytes(capability, input.startByte, endByteExclusive);
    return {
      byteSize: capability.byteSize,
      bytes,
      endByteExclusive,
      mimeType: capability.mimeType,
      startByte: input.startByte,
    };
  }

  cacheProjectRange(projectId: string): Promise<void> {
    return this.#runServiceOperation(() => this.#cacheProjectRange(projectId));
  }

  async #cacheProjectRange(projectId: string): Promise<void> {
    if (this.#rangeCache === undefined)
      throw new Error("Local media range cache is not configured");
    const project = await this.#library.readProject(projectId);
    const range = project.records.projectRange;
    const source = project.records.sources.find(({ id }) => id === range.sourceId);
    if (source === undefined || source.identity.kind !== "local_file") {
      throw new Error("Project Source is unavailable");
    }
    const snapshot = source.snapshots[0];
    if (snapshot === undefined) throw new Error("Project Source snapshot is unavailable");
    const locator = source.locators.find(
      (candidate): candidate is LocalFileLocator =>
        candidate.kind === "local_file" && candidate.status === "available",
    );
    if (locator === undefined) throw new Error("Project Source Locator is unavailable");
    const lease = await this.#verifyLocalWav(locator.path);
    try {
      const verified = lease.media;
      if (verified.byteFingerprint !== source.identity.fingerprint) {
        await this.#markLocatorUnavailable(source.id, locator);
        throw new Error("Project Source Locator no longer matches its identity");
      }
      const durationSamples = range.endSourceSample - range.startSourceSample;
      await this.#rangeCache.cacheProjectRange({
        canonicalAudioFingerprint: snapshot.canonicalAudioFingerprint,
        endSourceSample: range.endSourceSample,
        projectId,
        readCanonicalPcm: async ({ endProjectSample, startProjectSample }) => {
          if (
            !Number.isSafeInteger(startProjectSample) ||
            !Number.isSafeInteger(endProjectSample) ||
            startProjectSample < 0 ||
            endProjectSample <= startProjectSample ||
            endProjectSample > durationSamples
          ) {
            throw new Error("Cache read must stay inside the immutable Project Range");
          }
          return this.#readVerifiedBytes(
            verified,
            verified.dataOffset + (range.startSourceSample + startProjectSample) * 2,
            verified.dataOffset + (range.startSourceSample + endProjectSample) * 2,
          );
        },
        sampleRate: verified.sampleRate,
        sourceId: source.id,
        sourceSnapshotId: snapshot.id,
        startSourceSample: range.startSourceSample,
      });
    } finally {
      await releaseLeasesSuppressingCleanupErrors([lease]);
      await this.#cleanup.retryFailed();
    }
  }

  async #markLocatorUnavailable(sourceId: string, locator: LocalFileLocator): Promise<void> {
    await this.#library.observeSourceLocator(sourceId, {
      ...locator,
      status: "unavailable",
      verifiedAt: laterTimestamp(locator.verifiedAt, this.#now()),
    });
  }

  #verifyLocalWav(path: string): Promise<VerifiedMediaLease> {
    return verifyLocalWav(path, this.#fileSystem, this.#cleanup);
  }

  async #runGenerationOperation<T>(generationId: string, operation: () => Promise<T>): Promise<T> {
    const finish = this.#capabilities.beginOperation(generationId);
    try {
      return await operation();
    } finally {
      finish();
    }
  }

  async #runServiceOperation<T>(operation: () => Promise<T>): Promise<T> {
    const finish = this.#capabilities.beginServiceOperation();
    try {
      return await operation();
    } finally {
      finish();
    }
  }

  async #readVerifiedBytes(
    media: VerifiedLocalMedia,
    startByte: number,
    endByteExclusive: number,
  ): Promise<Buffer> {
    if (this.#activeVerifiedReads >= MAX_CONCURRENT_VERIFIED_READS) {
      throw new Error("Too many local media reads are active");
    }
    this.#activeVerifiedReads += 1;
    try {
      return await readVerifiedBytes(media, startByte, endByteExclusive);
    } finally {
      this.#activeVerifiedReads -= 1;
    }
  }
}

async function readVerifiedBytes(
  media: VerifiedLocalMedia,
  startByte: number,
  endByteExclusive: number,
): Promise<Buffer> {
  const identity = await media.handle.stat({ bigint: true });
  assertSameFileIdentity(media.identity, identity);
  const bytes = Buffer.alloc(endByteExclusive - startByte);
  const read = await media.handle.read(bytes, 0, bytes.length, startByte);
  if (read.bytesRead !== bytes.length) throw new Error("Local media changed while reading");
  const identityAfter = await media.handle.stat({ bigint: true });
  assertSameFileIdentity(identity, identityAfter);
  return bytes;
}

async function verifyLocalWav(
  candidatePath: string,
  fileSystem: LocalMediaFileSystem,
  cleanup: MediaHandleCleanup,
): Promise<VerifiedMediaLease> {
  const path = resolve(candidatePath);
  const ancestorsBefore = await inspectPathAncestors(path, fileSystem);
  await assertSamePathAncestors(ancestorsBefore, fileSystem);
  const pathBefore = await fileSystem.lstat(path);
  if (!pathBefore.isFile() || pathBefore.isSymbolicLink()) {
    throw new Error("Selected media must be a regular file, not a symbolic link or junction");
  }
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  const handle = await fileSystem.open(path, constants.O_RDONLY | noFollow);
  cleanup.retain(handle);
  try {
    const before = await handle.stat({ bigint: true });
    assertSameFileIdentity(pathBefore, before);
    if (before.size <= 0n || before.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("Selected media size is unsupported");
    }
    const byteSize = Number(before.size);
    const probe = Buffer.alloc(Math.min(byteSize, MAX_PROBE_BYTES));
    const { bytesRead } = await handle.read(probe, 0, probe.length, 0);
    const format = parseCanonicalWav(probe.subarray(0, bytesRead), byteSize);
    const byteHash = createHash("sha256");
    const audioHash = createHash("sha256");
    const chunk = Buffer.alloc(Math.min(byteSize, HASH_CHUNK_BYTES));
    for (let position = 0; position < byteSize;) {
      const length = Math.min(chunk.length, byteSize - position);
      const read = await handle.read(chunk, 0, length, position);
      if (read.bytesRead !== length) throw new Error("Selected media changed while reading");
      const bytes = chunk.subarray(0, read.bytesRead);
      byteHash.update(bytes);
      const overlapStart = Math.max(position, format.dataOffset);
      const overlapEnd = Math.min(position + read.bytesRead, format.dataOffset + format.dataSize);
      if (overlapEnd > overlapStart) {
        audioHash.update(bytes.subarray(overlapStart - position, overlapEnd - position));
      }
      position += read.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    const pathAfter = await fileSystem.lstat(path);
    await assertSamePathAncestors(ancestorsBefore, fileSystem);
    assertSameFileIdentity(before, after);
    assertSameFileIdentity(after, pathAfter);
    const verified: VerifiedLocalMedia = {
      audioCodec: "pcm_s16le",
      byteFingerprint: `sha256:${byteHash.digest("hex")}`,
      byteSize,
      canonicalAudioFingerprint: `sha256:${audioHash.digest("hex")}`,
      container: "wav",
      dataOffset: format.dataOffset,
      durationSamples: format.durationSamples,
      handle,
      identity: fileIdentity(after),
      mimeType: "audio/wav",
      path,
      sampleRate: CANONICAL_SAMPLE_RATE,
    };
    return new VerifiedMediaLease(verified, cleanup);
  } catch (error) {
    await cleanup.release(handle).catch(() => undefined);
    throw error;
  }
}

type PathAncestorIdentity = {
  dev: bigint;
  ino: bigint;
  mode: bigint;
  path: string;
};

async function inspectPathAncestors(
  path: string,
  fileSystem: LocalMediaFileSystem,
): Promise<PathAncestorIdentity[]> {
  const ancestors: string[] = [];
  for (let current = dirname(path); current !== dirname(current); current = dirname(current)) {
    ancestors.push(current);
  }
  const identities: PathAncestorIdentity[] = [];
  for (const ancestor of ancestors.reverse()) {
    const identity = await fileSystem.lstat(ancestor);
    if (identity.isSymbolicLink()) {
      throw new Error("Selected media path must not traverse a symbolic link or junction");
    }
    identities.push({ dev: identity.dev, ino: identity.ino, mode: identity.mode, path: ancestor });
  }
  return identities;
}

async function assertSamePathAncestors(
  expected: readonly PathAncestorIdentity[],
  fileSystem: LocalMediaFileSystem,
): Promise<void> {
  for (const ancestor of expected) {
    const current = await fileSystem.lstat(ancestor.path);
    if (
      current.isSymbolicLink() ||
      current.dev !== ancestor.dev ||
      current.ino !== ancestor.ino ||
      current.mode !== ancestor.mode
    ) {
      throw new Error("Selected media ancestor changed or became a symbolic link or junction");
    }
  }
}

function parseCanonicalWav(probe: Buffer, byteSize: number) {
  if (
    probe.length < 12 ||
    probe.toString("ascii", 0, 4) !== "RIFF" ||
    probe.toString("ascii", 8, 12) !== "WAVE"
  ) {
    throw new Error("Selected file is not supported media");
  }
  let format: { blockAlign: number; channels: number; sampleRate: number } | undefined;
  let data: { dataOffset: number; dataSize: number } | undefined;
  for (let offset = 12; offset + 8 <= probe.length;) {
    const id = probe.toString("ascii", offset, offset + 4);
    const size = probe.readUInt32LE(offset + 4);
    const content = offset + 8;
    if (content + size > byteSize) throw new Error("Selected media container is truncated");
    if (id === "fmt " && size >= 16 && content + 16 <= probe.length) {
      const encoding = probe.readUInt16LE(content);
      const channels = probe.readUInt16LE(content + 2);
      const sampleRate = probe.readUInt32LE(content + 4);
      const blockAlign = probe.readUInt16LE(content + 12);
      const bitsPerSample = probe.readUInt16LE(content + 14);
      if (
        encoding !== 1 ||
        channels !== 1 ||
        sampleRate !== CANONICAL_SAMPLE_RATE ||
        bitsPerSample !== 16 ||
        blockAlign !== 2
      ) {
        throw new Error("Selected WAV must be canonical 48 kHz mono PCM16 media");
      }
      format = { blockAlign, channels, sampleRate };
    }
    if (id === "data") data = { dataOffset: content, dataSize: size };
    if (format !== undefined && data !== undefined) break;
    offset = content + size + (size % 2);
  }
  if (format === undefined || data === undefined || data.dataSize <= 0) {
    throw new Error("Selected WAV is missing bounded format or audio data");
  }
  if (data.dataSize % format.blockAlign !== 0) {
    throw new Error("Selected WAV audio data is not frame-aligned");
  }
  return { ...data, durationSamples: data.dataSize / format.blockAlign };
}

function buildUnanalyzedProjectEnvelope(input: {
  durationSamples: number;
  projectId: string;
  sampleRate: number;
}) {
  const payload = parseProjectContract({
    activeView: null,
    analysisRevisions: [],
    durationSamples: input.durationSamples,
    editLayers: [],
    extensions: {},
    format: "open-chords/project",
    id: input.projectId,
    lyricsAlignments: [],
    lyricsDocuments: [],
    sampleRate: input.sampleRate,
    schemaVersion: CONTRACT_VERSION,
    supportClaims: [],
  });
  return ProjectEnvelopeSchema.parse({
    extensions: {},
    payload,
    protocol: "open-chords/contracts",
    schemaVersion: CONTRACT_VERSION,
    type: "project_snapshot",
  });
}

function assertProjectRange(
  range: { endSourceSample: number; startSourceSample: number },
  durationSamples: number,
): void {
  if (
    !Number.isSafeInteger(range.startSourceSample) ||
    !Number.isSafeInteger(range.endSourceSample) ||
    range.startSourceSample < 0 ||
    range.endSourceSample <= range.startSourceSample ||
    range.endSourceSample > durationSamples
  ) {
    throw new Error("Project Range is outside verified media");
  }
}

function assertSameFileIdentity(left: FileIdentity, right: FileIdentity): void {
  if (
    left.dev !== right.dev ||
    left.ino !== right.ino ||
    left.mode !== right.mode ||
    left.size !== right.size ||
    left.mtimeNs !== right.mtimeNs ||
    left.ctimeNs !== right.ctimeNs
  ) {
    throw new Error("Selected media changed while reading");
  }
}

function fileIdentity(stat: FileIdentity): FileIdentity {
  return {
    ctimeNs: stat.ctimeNs,
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode,
    mtimeNs: stat.mtimeNs,
    size: stat.size,
  };
}

function laterTimestamp(previous: string, now: Date): string {
  const next = Math.max(now.getTime(), Date.parse(previous) + 1);
  return new Date(next).toISOString();
}

function opaqueId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

function sourceIdFor(fingerprint: string): string {
  return `source_${fingerprint.slice("sha256:".length)}`;
}

function snapshotIdFor(fingerprint: string): string {
  return `snapshot_${fingerprint.slice("sha256:".length)}`;
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { CONTRACT_VERSION, ProjectEnvelopeSchema } from "@open-chords/contracts";
import { parseProjectContract } from "@open-chords/domain";

import { ProjectOwnedRecordsSchema, type ProjectOwnedRecords } from "./project-library-records.ts";
import type { ProjectLibrary } from "./project-library.ts";

const MAX_PROBE_BYTES = 64 * 1024;
const HASH_CHUNK_BYTES = 1024 * 1024;
const MAX_PLAYBACK_RANGE_BYTES = 8 * 1024 * 1024;
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

type SelectionCapability = VerifiedLocalMedia & {
  generationId: string;
};

type PlaybackCapability = VerifiedLocalMedia & {
  generationId: string;
  projectId: string;
};

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
  afterAncestorVerification?: () => Promise<void> | void;
  afterVerificationRead?: () => Promise<void> | void;
  library: ProjectLibrary;
  now?: () => Date;
  pickFile: () => Promise<string | null>;
  rangeCache?: LocalMediaRangeCache;
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
  readonly #afterAncestorVerification: () => Promise<void> | void;
  readonly #afterVerificationRead: () => Promise<void> | void;
  readonly #capabilities = new Map<string, SelectionCapability>();
  readonly #playbackCapabilities = new Map<string, PlaybackCapability>();
  readonly #library: ProjectLibrary;
  readonly #now: () => Date;
  readonly #pickFile: () => Promise<string | null>;
  readonly #rangeCache: LocalMediaRangeCache | undefined;

  constructor(options: LocalMediaServiceOptions) {
    this.#afterAncestorVerification = options.afterAncestorVerification ?? (() => undefined);
    this.#afterVerificationRead = options.afterVerificationRead ?? (() => undefined);
    this.#library = options.library;
    this.#now = options.now ?? (() => new Date());
    this.#pickFile = options.pickFile;
    this.#rangeCache = options.rangeCache;
  }

  revokeGeneration(generationId: string): void {
    for (const [capabilityId, capability] of this.#capabilities) {
      if (capability.generationId === generationId) this.#capabilities.delete(capabilityId);
    }
    for (const [capabilityId, capability] of this.#playbackCapabilities) {
      if (capability.generationId === generationId) this.#playbackCapabilities.delete(capabilityId);
    }
  }

  async pickLocalFile(generationId: string): Promise<LocalMediaSelection> {
    const selectedPath = await this.#pickFile();
    if (selectedPath === null) return { kind: "cancelled" };
    const verified = await this.#verifyLocalWav(selectedPath);
    const capabilityId = opaqueId("mediacapability");
    this.#capabilities.set(capabilityId, { ...verified, generationId });
    return {
      byteSize: verified.byteSize,
      capabilityId,
      durationSamples: verified.durationSamples,
      kind: "selected",
      mimeType: verified.mimeType,
      sampleRate: verified.sampleRate,
    };
  }

  async createProject(input: {
    capabilityId: string;
    endSourceSample: number;
    generationId: string;
    startSourceSample: number;
  }): Promise<{ projectId: string; projectRevisionId: string; sourceId: string }> {
    let capability = this.#capabilities.get(input.capabilityId);
    if (capability === undefined || capability.generationId !== input.generationId) {
      throw new Error("Local media capability is unavailable");
    }
    assertProjectRange(input, capability.durationSamples);
    const reverified = await this.#verifyLocalWav(capability.path);
    if (reverified.byteFingerprint !== capability.byteFingerprint) {
      throw new Error("Selected media changed before Project creation");
    }
    assertSameFileIdentity(capability.identity, reverified.identity);
    capability = { ...reverified, generationId: capability.generationId };

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
    const created = await this.#library.createProject({ envelope, records });
    this.#capabilities.delete(input.capabilityId);
    return { projectId, projectRevisionId: created.projectRevisionId, sourceId };
  }

  async relinkSource(input: {
    generationId: string;
    sourceId: string;
  }): Promise<LocalMediaRelinkResult> {
    const selectedPath = await this.#pickFile();
    if (selectedPath === null) return { kind: "cancelled" };
    const verified = await this.#verifyLocalWav(selectedPath);
    const source = this.#library.getSourceById(input.sourceId);
    if (source === undefined) throw new Error("Source is unavailable");
    if (
      source.identity.kind !== "local_file" ||
      source.identity.fingerprint !== verified.byteFingerprint
    ) {
      const capabilityId = opaqueId("mediacapability");
      this.#capabilities.set(capabilityId, { ...verified, generationId: input.generationId });
      return {
        byteSize: verified.byteSize,
        capabilityId,
        durationSamples: verified.durationSamples,
        kind: "different_source",
        mimeType: verified.mimeType,
        sampleRate: verified.sampleRate,
      };
    }
    await this.#library.observeSourceLocator(input.sourceId, {
      fingerprint: verified.byteFingerprint,
      id: opaqueId("locator"),
      kind: "local_file",
      path: verified.path,
      status: "available",
      verifiedAt: this.#now().toISOString(),
    });
    return { kind: "relinked", sourceId: input.sourceId };
  }

  async openPlayback(input: {
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
      try {
        const verified = await this.#verifyLocalWav(locator.path);
        if (verified.byteFingerprint !== source.identity.fingerprint) {
          await this.#markLocatorUnavailable(source.id, locator);
          continue;
        }
        const capabilityId = opaqueId("playbackcapability");
        this.#playbackCapabilities.set(capabilityId, {
          ...verified,
          generationId: input.generationId,
          projectId: input.projectId,
        });
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
      } catch {
        await this.#markLocatorUnavailable(source.id, locator);
      }
    }
    return { kind: "unavailable", projectId: input.projectId, sourceId: source.id };
  }

  async readPlaybackRange(input: {
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
    const capability = this.#playbackCapabilities.get(input.capabilityId);
    if (capability === undefined) throw new Error("Playback capability is unavailable");
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
    const bytes = await readVerifiedBytes(capability, input.startByte, endByteExclusive);
    return {
      byteSize: capability.byteSize,
      bytes,
      endByteExclusive,
      mimeType: capability.mimeType,
      startByte: input.startByte,
    };
  }

  async cacheProjectRange(projectId: string): Promise<void> {
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
    const verified = await this.#verifyLocalWav(locator.path);
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
        return readVerifiedBytes(
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
  }

  async #markLocatorUnavailable(sourceId: string, locator: LocalFileLocator): Promise<void> {
    await this.#library.observeSourceLocator(sourceId, {
      ...locator,
      status: "unavailable",
      verifiedAt: laterTimestamp(locator.verifiedAt, this.#now()),
    });
  }

  #verifyLocalWav(path: string): Promise<VerifiedLocalMedia> {
    return verifyLocalWav(path, this.#afterAncestorVerification, this.#afterVerificationRead);
  }
}

async function readVerifiedBytes(
  media: VerifiedLocalMedia,
  startByte: number,
  endByteExclusive: number,
): Promise<Buffer> {
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  const handle = await open(media.path, constants.O_RDONLY | noFollow);
  try {
    const identity = await handle.stat({ bigint: true });
    assertSameFileIdentity(media.identity, identity);
    const bytes = Buffer.alloc(endByteExclusive - startByte);
    const read = await handle.read(bytes, 0, bytes.length, startByte);
    if (read.bytesRead !== bytes.length) throw new Error("Local media changed while reading");
    const identityAfter = await handle.stat({ bigint: true });
    assertSameFileIdentity(identity, identityAfter);
    return bytes;
  } finally {
    await handle.close();
  }
}

async function verifyLocalWav(
  candidatePath: string,
  afterAncestorVerification: () => Promise<void> | void,
  afterVerificationRead: () => Promise<void> | void,
): Promise<VerifiedLocalMedia> {
  const path = resolve(candidatePath);
  const ancestorsBefore = await inspectPathAncestors(path);
  await afterAncestorVerification();
  await assertSamePathAncestors(ancestorsBefore);
  const pathBefore = await lstat(path, { bigint: true });
  if (!pathBefore.isFile() || pathBefore.isSymbolicLink()) {
    throw new Error("Selected media must be a regular file, not a symbolic link or junction");
  }
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  const handle = await open(path, constants.O_RDONLY | noFollow);
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
    await afterVerificationRead();
    const after = await handle.stat({ bigint: true });
    const pathAfter = await lstat(path, { bigint: true });
    await assertSamePathAncestors(ancestorsBefore);
    assertSameFileIdentity(before, after);
    assertSameFileIdentity(after, pathAfter);
    return {
      audioCodec: "pcm_s16le",
      byteFingerprint: `sha256:${byteHash.digest("hex")}`,
      byteSize,
      canonicalAudioFingerprint: `sha256:${audioHash.digest("hex")}`,
      container: "wav",
      dataOffset: format.dataOffset,
      durationSamples: format.durationSamples,
      identity: fileIdentity(after),
      mimeType: "audio/wav",
      path,
      sampleRate: CANONICAL_SAMPLE_RATE,
    };
  } finally {
    await handle.close();
  }
}

type PathAncestorIdentity = {
  dev: bigint;
  ino: bigint;
  mode: bigint;
  path: string;
};

async function inspectPathAncestors(path: string): Promise<PathAncestorIdentity[]> {
  const ancestors: string[] = [];
  for (let current = dirname(path); current !== dirname(current); current = dirname(current)) {
    ancestors.push(current);
  }
  const identities: PathAncestorIdentity[] = [];
  for (const ancestor of ancestors.reverse()) {
    const identity = await lstat(ancestor, { bigint: true });
    if (identity.isSymbolicLink()) {
      throw new Error("Selected media path must not traverse a symbolic link or junction");
    }
    identities.push({ dev: identity.dev, ino: identity.ino, mode: identity.mode, path: ancestor });
  }
  return identities;
}

async function assertSamePathAncestors(expected: readonly PathAncestorIdentity[]): Promise<void> {
  for (const ancestor of expected) {
    const current = await lstat(ancestor.path, { bigint: true });
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

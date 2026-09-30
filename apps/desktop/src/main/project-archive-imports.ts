import { lstat } from "node:fs/promises";

import { canonicalSerialize } from "@open-chords/domain";

import { readBoundedFile } from "./bounded-file.ts";
import { OfflineMediaConflictError, type OfflineMediaCache } from "./offline-media-cache.ts";
import { archivedProjectFor, sha256, type ArchivedProject } from "./project-archive-format.ts";
import {
  ArchiveRejectionError,
  inspectPortableProjectArchive,
  type ArchiveRejection,
  type InspectedArchive,
} from "./project-archive-inspection.ts";
import { ARCHIVE_ZIP_LIMITS } from "./project-archive-zip.ts";
import type { ProjectLibrary } from "./project-library.ts";

const MAX_COPY_CANDIDATES = 100;

export type ProjectArchiveImportRejection =
  | ArchiveRejection
  | "identity_exhausted"
  | "source_conflict"
  | "unreadable_archive";

export type ProjectArchiveImportResult =
  | { state: "cancelled" }
  | { reason: ProjectArchiveImportRejection; state: "rejected" }
  | {
      importedCopy: boolean;
      offlineMedia: "cached" | "not_included";
      projectId: string;
      state: "already_present" | "imported";
    };

type Options = {
  cache: Pick<OfflineMediaCache, "store">;
  library: Pick<
    ProjectLibrary,
    | "findLocalFileSourceByFingerprint"
    | "getSourceById"
    | "listProjects"
    | "listYouTubeSources"
    | "readProject"
    | "restoreProjectRevision"
  >;
  pickArchive: () => Promise<string | null>;
};

class ImportRejected extends Error {
  readonly reason: ProjectArchiveImportRejection;
  constructor(reason: ProjectArchiveImportRejection) {
    super(`Portable Project Archive import rejected: ${reason}`);
    this.reason = reason;
  }
}

export class ProjectArchiveImports {
  readonly #options: Options;
  #busy = false;

  constructor(options: Options) {
    this.#options = options;
  }

  get busy() {
    return this.#busy;
  }

  async importArchive(): Promise<ProjectArchiveImportResult> {
    if (this.#busy) throw new Error("An archive import is already running");
    this.#busy = true;
    try {
      const path = await this.#options.pickArchive();
      if (path === null) return { state: "cancelled" };
      return await this.#import(await readQuarantineCopy(path));
    } catch (error) {
      if (error instanceof ArchiveRejectionError || error instanceof ImportRejected)
        return { reason: error.reason, state: "rejected" };
      throw error;
    } finally {
      this.#busy = false;
    }
  }

  async #import(bytes: Buffer): Promise<ProjectArchiveImportResult> {
    const inspected = inspectPortableProjectArchive(bytes);
    const document = await this.#adoptLibrarySources(inspected.document);
    const offlineMedia = await this.#cacheMedia(inspected, document);
    for (const candidate of identityCandidates(document, inspected.manifestHash)) {
      const projectId = candidate.envelope.payload.id;
      const existing = this.#options.library
        .listProjects()
        .find((entry) => entry.projectId === projectId);
      const importedCopy = projectId !== document.envelope.payload.id;
      if (existing === undefined) {
        await this.#options.library.restoreProjectRevision(candidate);
        return { importedCopy, offlineMedia, projectId, state: "imported" };
      }
      if (existing.status === "active" && (await this.#matches(projectId, candidate)))
        return { importedCopy, offlineMedia, projectId, state: "already_present" };
    }
    throw new ImportRejected("identity_exhausted");
  }

  async #matches(projectId: string, candidate: ArchivedProject): Promise<boolean> {
    const current = archivedProjectFor(await this.#options.library.readProject(projectId));
    return canonicalSerialize(current.document) === canonicalSerialize(candidate);
  }

  // Source identity and immutable Snapshots belong to the Library. An archive may add an
  // unknown Source, which stays unavailable until relinked, but can never redefine one.
  async #adoptLibrarySources(document: ArchivedProject): Promise<ArchivedProject> {
    const { library } = this.#options;
    const youtubeSources = await library.listYouTubeSources();
    const sources = document.records.sources.map((source) => {
      const owner =
        source.identity.kind === "local_file"
          ? library.findLocalFileSourceByFingerprint(source.identity.fingerprint)
          : youtubeSources.find(
              ({ identity }) =>
                identity.kind === "youtube" &&
                source.identity.kind === "youtube" &&
                identity.videoId === source.identity.videoId,
            );
      if (owner !== undefined && owner.id !== source.id)
        throw new ImportRejected("source_conflict");
      const established = library.getSourceById(source.id);
      if (established === undefined) return source;
      if (canonicalSerialize(established.identity) !== canonicalSerialize(source.identity))
        throw new ImportRejected("source_conflict");
      const snapshots = source.snapshots.map((snapshot) => {
        const retained = established.snapshots.find(({ id }) => id === snapshot.id);
        if (retained === undefined) return snapshot;
        if (
          retained.byteFingerprint !== snapshot.byteFingerprint ||
          retained.byteSize !== snapshot.byteSize ||
          retained.canonicalAudioFingerprint !== snapshot.canonicalAudioFingerprint ||
          retained.durationSamples !== snapshot.durationSamples
        )
          throw new ImportRejected("source_conflict");
        return retained;
      });
      const metadataObservations = source.metadataObservations.map((observation) => {
        const retained = established.metadataObservations.find(({ id }) => id === observation.id);
        if (
          retained !== undefined &&
          canonicalSerialize(retained) !== canonicalSerialize(observation)
        )
          throw new ImportRejected("source_conflict");
        return observation;
      });
      return { ...source, metadataObservations, snapshots };
    });
    return { ...document, records: { ...document.records, sources } };
  }

  async #cacheMedia(
    inspected: InspectedArchive,
    document: ArchivedProject,
  ): Promise<"cached" | "not_included"> {
    if (inspected.media === undefined) return "not_included";
    const { declaration } = inspected.media;
    const snapshot = document.records.sources
      .find(({ id }) => id === declaration.sourceId)
      ?.snapshots.find(({ id }) => id === declaration.sourceSnapshotId);
    if (snapshot === undefined) throw new ImportRejected("reference_invalid");
    try {
      await this.#options.cache.store({
        archiveManifestHash: inspected.manifestHash,
        bytes: inspected.media.bytes,
        range: {
          canonicalAudioFingerprint: snapshot.canonicalAudioFingerprint,
          endSourceSample: declaration.endSourceSample,
          sampleRate: declaration.sampleRate,
          sourceId: declaration.sourceId,
          sourceSnapshotId: declaration.sourceSnapshotId,
          startSourceSample: declaration.startSourceSample,
        },
      });
    } catch (error) {
      if (error instanceof OfflineMediaConflictError) throw new ImportRejected("hash_mismatch");
      throw error;
    }
    return "cached";
  }
}

async function readQuarantineCopy(path: string): Promise<Buffer> {
  let size: number;
  try {
    const stat = await lstat(path);
    if (!stat.isFile()) throw new ImportRejected("unreadable_archive");
    size = stat.size;
  } catch (error) {
    if (error instanceof ImportRejected) throw error;
    throw new ImportRejected("unreadable_archive");
  }
  if (size > ARCHIVE_ZIP_LIMITS.maxArchiveBytes) throw new ImportRejected("size_limit");
  try {
    return await readBoundedFile(path, ARCHIVE_ZIP_LIMITS.maxArchiveBytes);
  } catch {
    throw new ImportRejected("unreadable_archive");
  }
}

// The first candidate keeps the archived identity. Later candidates are deterministic
// Imported Project Copies, so retrying one archive converges on the copy it created.
function* identityCandidates(
  document: ArchivedProject,
  manifestHash: string,
): Generator<ArchivedProject> {
  yield document;
  const origin = document.envelope.payload;
  for (const index of Array.from({ length: MAX_COPY_CANDIDATES }, (_, position) => position)) {
    const suffix = sha256(`${origin.id}\n${manifestHash}\n${String(index)}`).slice(7, 39);
    yield {
      ...document,
      envelope: {
        ...document.envelope,
        payload: {
          ...origin,
          id: `project_${suffix}`,
          importOrigins: [
            ...(origin.importOrigins ?? []),
            { archiveManifestHash: manifestHash, projectId: origin.id },
          ],
        },
      },
    };
  }
}

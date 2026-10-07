import { lstat } from "node:fs/promises";

import { canonicalSerialize } from "@open-chords/domain";

import { readBoundedFile } from "./bounded-file.ts";
import {
  OfflineMediaBlockedError,
  type OfflineMediaBlockReason,
  type OfflineMediaCache,
  type OfflineMediaVerification,
} from "./offline-media-cache.ts";
import { archivedProjectFor, sha256, type ArchivedProject } from "./project-archive-format.ts";
import {
  ArchiveRejectionError,
  inspectPortableProjectArchive,
  type ArchiveRejection,
  type InspectedArchive,
} from "./project-archive-inspection.ts";
import { ARCHIVE_ZIP_LIMITS } from "./project-archive-zip.ts";
import type { ProjectLibrary } from "./project-library.ts";
import { assertValidProjectPayload } from "./project-payload.ts";

const MAX_COPY_CANDIDATES = 100;

export type ProjectArchiveImportRejection =
  | ArchiveRejection
  | "identity_exhausted"
  | "source_conflict"
  | "unreadable_archive";

export type OfflineMediaOutcome =
  | { state: "declined" | "not_included" }
  | { state: "already_cached" | "cached"; verification: OfflineMediaVerification }
  | {
      reason: OfflineMediaBlockReason | "unverifiable_for_known_source" | "write_failed";
      state: "blocked";
    };

export type ProjectArchiveImportResult =
  | { state: "cancelled" }
  | { reason: ProjectArchiveImportRejection; state: "rejected" }
  | {
      importedCopy: boolean;
      offlineMedia: OfflineMediaOutcome;
      projectId: string;
      state: "already_present" | "imported";
    };

export class ArchiveImportBusyError extends Error {
  constructor() {
    super("An archive import is already running");
    this.name = "ArchiveImportBusyError";
  }
}

type Options = {
  cache: Pick<OfflineMediaCache, "store">;
  library: Pick<
    ProjectLibrary,
    | "findLocalFileSourceByFingerprint"
    | "getSourceById"
    | "listProjects"
    | "listYouTubeSources"
    | "migrateToCurrentSchema"
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

  async importArchive(
    options: { adoptOfflineMedia: boolean } = { adoptOfflineMedia: false },
  ): Promise<ProjectArchiveImportResult> {
    if (this.#busy) throw new ArchiveImportBusyError();
    this.#busy = true;
    try {
      const path = await this.#options.pickArchive();
      if (path === null) return { state: "cancelled" };
      return await this.#import(await readQuarantineCopy(path), options.adoptOfflineMedia);
    } catch (error) {
      if (error instanceof ArchiveRejectionError || error instanceof ImportRejected)
        return { reason: error.reason, state: "rejected" };
      throw error;
    } finally {
      this.#busy = false;
    }
  }

  async #import(bytes: Buffer, adoptOfflineMedia: boolean): Promise<ProjectArchiveImportResult> {
    const inspected = inspectPortableProjectArchive(bytes);
    const knownSourceIds = new Set(
      inspected.document.records.sources
        .filter(({ id }) => this.#options.library.getSourceById(id) !== undefined)
        .map(({ id }) => id),
    );
    const document = await this.#adoptLibrarySources(inspected.document);
    const { candidate, state } = await this.#resolveIdentity(document, inspected.manifestHash);
    if (state === "imported") await this.#options.library.restoreProjectRevision(candidate);
    const projectId = candidate.envelope.payload.id;
    return {
      importedCopy: projectId !== document.envelope.payload.id,
      offlineMedia: adoptOfflineMedia
        ? await this.#adoptMedia(inspected, document, knownSourceIds)
        : { state: inspected.media === undefined ? "not_included" : "declined" },
      projectId,
      state,
    };
  }

  async #resolveIdentity(
    document: ArchivedProject,
    manifestHash: string,
  ): Promise<{ candidate: ArchivedProject; state: "already_present" | "imported" }> {
    for (const candidate of identityCandidates(document, manifestHash)) {
      try {
        assertValidProjectPayload(candidate);
      } catch {
        throw new ImportRejected("identity_exhausted");
      }
      const projectId = candidate.envelope.payload.id;
      const existing = this.#options.library
        .listProjects()
        .find((entry) => entry.projectId === projectId);
      if (existing === undefined) return { candidate, state: "imported" };
      if (existing.status === "active" && (await this.#matches(projectId, candidate)))
        return { candidate, state: "already_present" };
    }
    throw new ImportRejected("identity_exhausted");
  }

  async #matches(projectId: string, candidate: ArchivedProject): Promise<boolean> {
    const { library } = this.#options;
    let migrated: Parameters<typeof archivedProjectFor>[0];
    try {
      migrated = await library.migrateToCurrentSchema(candidate);
    } catch {
      return false;
    }
    return (
      canonicalSerialize(archivedProjectFor(await library.readProject(projectId)).document) ===
      canonicalSerialize(archivedProjectFor(migrated).document)
    );
  }

  // Source identity and immutable Snapshots belong to the Library. An archive may add an
  // unknown Source, which stays unavailable until relinked. A known Source is replaced by
  // the Library's record, so an archive can neither redefine nor extend it.
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
      const redefined = source.snapshots.some((snapshot) => {
        const retained = established.snapshots.find(({ id }) => id === snapshot.id);
        return (
          retained !== undefined &&
          (retained.byteFingerprint !== snapshot.byteFingerprint ||
            retained.byteSize !== snapshot.byteSize ||
            retained.canonicalAudioFingerprint !== snapshot.canonicalAudioFingerprint ||
            retained.durationSamples !== snapshot.durationSamples)
        );
      });
      if (redefined) throw new ImportRejected("source_conflict");
      return established;
    });
    const adopted = { ...document, records: { ...document.records, sources } };
    try {
      assertValidProjectPayload(adopted);
    } catch {
      throw new ImportRejected("source_conflict");
    }
    return adopted;
  }

  // Bytes proven only by the archive's own manifest must never be bound to a Source the
  // Library already owns. Only a full Range equal to a retained Snapshot fingerprint is
  // verified; media for a Source the archive introduces is recorded as archive-attested.
  async #adoptMedia(
    inspected: InspectedArchive,
    document: ArchivedProject,
    knownSourceIds: ReadonlySet<string>,
  ): Promise<OfflineMediaOutcome> {
    if (inspected.media === undefined) return { state: "not_included" };
    const { bytes, declaration } = inspected.media;
    const snapshot = document.records.sources
      .find(({ id }) => id === declaration.sourceId)
      ?.snapshots.find(({ id }) => id === declaration.sourceSnapshotId);
    if (snapshot === undefined) return { reason: "write_failed", state: "blocked" };
    const known = knownSourceIds.has(declaration.sourceId);
    const fullRange =
      declaration.startSourceSample === 0 &&
      declaration.endSourceSample === snapshot.durationSamples &&
      sha256(bytes) === snapshot.canonicalAudioFingerprint;
    if (known && !fullRange) return { reason: "unverifiable_for_known_source", state: "blocked" };
    try {
      const stored = await this.#options.cache.store({
        archiveManifestHash: inspected.manifestHash,
        bytes,
        range: {
          canonicalAudioFingerprint: snapshot.canonicalAudioFingerprint,
          endSourceSample: declaration.endSourceSample,
          sampleRate: declaration.sampleRate,
          sourceId: declaration.sourceId,
          sourceSnapshotId: declaration.sourceSnapshotId,
          startSourceSample: declaration.startSourceSample,
        },
        verification: known ? "snapshot_fingerprint" : "archive_attested",
      });
      return { state: stored.state, verification: stored.entry.verification };
    } catch (error) {
      return {
        reason: error instanceof OfflineMediaBlockedError ? error.reason : "write_failed",
        state: "blocked",
      };
    }
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

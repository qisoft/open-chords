import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  access,
  cp,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import {
  CONTRACT_VERSION,
  parseContractEnvelope,
  ProjectEnvelopeSchema,
} from "@open-chords/contracts";
import {
  canonicalSerialize,
  EditTransactionSchema,
  parseProjectContract,
  StableIdSchema,
  validateAnalysisManifestProvenance,
  type EditTransaction,
  type AnalysisRevision,
  type AnalysisManifest,
  type AnalysisRecipe,
  type ProjectContract,
} from "@open-chords/domain";
import { z } from "zod";

import {
  locatorMatchesSourceIdentity,
  ProjectOwnedRecordsSchema,
  SourceLocatorSchema,
  type ProjectOwnedRecords,
} from "./project-library-records.ts";

const HASH_PATTERN = /^sha256:([a-f0-9]{64})$/;
const PROJECT_REVISION_ID_PATTERN = /^projectrevision_[a-f0-9]{32}$/;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1_000;
const LIBRARY_LOCATION_FILE = "project-library-location.json";
const RELOCATION_JOURNAL_FILE = "project-library-relocation.json";
const RELOCATION_MARKER_FILE = ".open-chords-relocation.json";
const DEFAULT_LIBRARY_DIRECTORY = "project-library";
const SOURCE_CATALOG_FILE = "source-catalog.json";
const SOURCE_CATALOG_BACKUP_FILE = "source-catalog.backup.json";
const execFileAsync = promisify(execFile);

const HashSchema = z.string().regex(HASH_PATTERN);
const ProjectRevisionIdSchema = z.string().regex(PROJECT_REVISION_ID_PATTERN);
const StoredProjectPayloadSchema = z.strictObject({
  envelope: ProjectEnvelopeSchema,
  format: z.literal("open-chords/project-library-payload"),
  records: ProjectOwnedRecordsSchema,
  schemaVersion: z.literal("1.0"),
});
const ProjectRevisionRecordSchema = z.strictObject({
  createdAt: z.iso.datetime({ offset: true }),
  format: z.literal("open-chords/project-revision"),
  parentProjectRevisionId: ProjectRevisionIdSchema.nullable(),
  payloadObjectHash: HashSchema,
  projectId: StableIdSchema,
  projectRevisionId: ProjectRevisionIdSchema,
  reason: z.enum([
    "analysis_publication",
    "created",
    "edit_transaction",
    "migration",
    "restored",
    "rollback",
  ]),
  schemaVersion: z.literal("1.0"),
});
const RevisionPointerSchema = z.strictObject({
  projectRevisionId: ProjectRevisionIdSchema,
  revisionObjectHash: HashSchema,
  sequence: z.number().int().positive(),
});
const ProjectHeadSchema = z.strictObject({
  format: z.literal("open-chords/project-head"),
  projectId: StableIdSchema,
  projectRevisionId: ProjectRevisionIdSchema,
  revisionObjectHash: HashSchema,
  schemaVersion: z.literal("1.0"),
  sequence: z.number().int().positive(),
});
const TrashRecordSchema = z.strictObject({
  format: z.literal("open-chords/library-trash-record"),
  projectId: StableIdSchema,
  schemaVersion: z.literal("1.0"),
  trashedAt: z.iso.datetime({ offset: true }),
});
const RecoveryReportSchema = z.strictObject({
  createdAt: z.iso.datetime({ offset: true }),
  format: z.literal("open-chords/project-recovery-report"),
  lostProjectRevisionId: ProjectRevisionIdSchema.nullable(),
  projectId: StableIdSchema,
  recoveredProjectRevisionId: ProjectRevisionIdSchema.nullable(),
  reason: z.literal("active_head_corrupt"),
  schemaVersion: z.literal("1.0"),
});
const LibraryLocationSchema = z.strictObject({
  activeRoot: z.string().min(1),
  format: z.literal("open-chords/project-library-location"),
  schemaVersion: z.literal("1.0"),
});
const DirectoryIdentitySchema = z.strictObject({
  device: z.string().regex(/^\d+$/),
  inode: z.string().regex(/^\d+$/),
});
const RelocationJournalSchema = z.strictObject({
  stagingCleanupTarget: z.string().min(1),
  format: z.literal("open-chords/project-library-relocation"),
  id: z.string().uuid(),
  previousRoot: z.string().min(1),
  schemaVersion: z.literal("1.0"),
  stagingTarget: z.string().min(1),
  target: z.string().min(1),
  targetCleanupTarget: z.string().min(1),
  targetParent: z.string().min(1),
  targetParentIdentity: DirectoryIdentitySchema,
});
const RelocationMarkerSchema = z.strictObject({
  format: z.literal("open-chords/project-library-relocation-marker"),
  id: z.string().uuid(),
  schemaVersion: z.literal("1.0"),
});
const SourceCatalogSchema = z.strictObject({
  format: z.literal("open-chords/source-catalog"),
  locatorsBySourceId: z.record(
    StableIdSchema,
    z
      .array(SourceLocatorSchema)
      .refine(
        (locators) => new Set(locators.map(({ id }) => id)).size === locators.length,
        "Source Locator IDs must be unique",
      ),
  ),
  revision: z.number().int().nonnegative(),
  schemaVersion: z.literal("1.0"),
});

type StoredProjectPayload = z.infer<typeof StoredProjectPayloadSchema>;
type ProjectRevisionRecord = z.infer<typeof ProjectRevisionRecordSchema>;
type SourceCatalog = z.infer<typeof SourceCatalogSchema>;
type LocatorRecords = ProjectOwnedRecords["sources"][number]["locators"];
type LocatorCatalog = Map<string, LocatorRecords>;
type RevisionPointer = z.infer<typeof RevisionPointerSchema>;
type TrashRecord = z.infer<typeof TrashRecordSchema>;
export type ProjectRecoveryReport = z.infer<typeof RecoveryReportSchema>;

export type ProjectLibraryFaultPoint =
  | "after_payload_durable"
  | "after_revision_durable"
  | "before_head_replace"
  | "after_head_rename"
  | "after_head_file_sync"
  | "after_head_replace"
  | "after_object_rename"
  | "after_relocation_target_rename"
  | "before_relocation_copy"
  | "before_relocation_cleanup_claim"
  | "after_relocation_cleanup_remove"
  | "after_relocation_location_rename"
  | "after_relocation_location_replace"
  | "after_catalog_recovery_report"
  | "after_catalog_durable"
  | "before_relocation_staging_cleanup"
  | "before_trash_parent_sync"
  | "before_trash_restore_parent_sync"
  | "before_permanent_delete_parent_sync"
  | "before_empty_trash_remove"
  | "after_trash_move"
  | "after_trash_restore_move"
  | "after_permanent_delete";

export type ProjectMigration = {
  fromVersion: string;
  migrate: (envelope: unknown) => unknown;
  toVersion: string;
};

export type ProjectLibraryOptions = {
  currentSchemaVersion?: string;
  faultInjector?: (point: ProjectLibraryFaultPoint) => void | Promise<void>;
  migrations?: readonly ProjectMigration[];
  now?: () => Date;
  pathPolicy?: (path: string) => "local" | "unsupported" | Promise<"local" | "unsupported">;
  stateRoot: string;
};

type RevisionSnapshot = {
  payload: StoredProjectPayload;
  pointer: RevisionPointer;
  revision: ProjectRevisionRecord;
};

type LibraryEntry = {
  compatibility: "read_only" | "writable";
  location: "active" | "trashed";
  migrationFailure?: string;
  recoveryReport?: ProjectRecoveryReport;
  revision?: RevisionSnapshot;
  revisions: RevisionSnapshot[];
  status: "active" | "damaged" | "trashed";
  trashRecord?: TrashRecord;
};

export type ProjectLibraryListEntry = {
  compatibility?: "read_only" | "writable";
  migrationFailure?: string;
  projectId: string;
  projectRevisionId?: string;
  recoveryReport?: ProjectRecoveryReport;
  status: "active" | "damaged" | "trashed";
};

export type ProjectLibraryChange = {
  projectId: string;
  projectRevisionId: string;
  sequence: number;
};

export class ProjectLibraryDamagedError extends Error {
  constructor(projectId: string) {
    super(`Project ${projectId} has no verified Project Revision`);
    this.name = "ProjectLibraryDamagedError";
  }
}

export class ProjectLibraryReadOnlyError extends Error {
  constructor(schemaVersion: string) {
    super(`Project schema ${schemaVersion} is read-only in this application`);
    this.name = "ProjectLibraryReadOnlyError";
  }
}

class ProjectStorageCorruptionError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "ProjectStorageCorruptionError";
  }
}

class ProjectPublicationError extends Error {
  constructor(cause: unknown) {
    super(`Project publication failed: ${errorMessage(cause)}`, { cause });
    this.name = "ProjectPublicationError";
  }
}

class ProjectPublicationReconciliationError extends Error {
  constructor(cause: unknown) {
    super("Project publication failed and storage reconciliation also failed", { cause });
    this.name = "ProjectPublicationReconciliationError";
  }
}

class ProjectHeadDurabilityError extends Error {
  constructor(cause: unknown) {
    super("Project Head durability could not be established", { cause });
    this.name = "ProjectHeadDurabilityError";
  }
}

class ProjectLifecycleDurabilityError extends Error {
  constructor(cause: unknown) {
    super("Project lifecycle directory change was not durably committed", { cause });
    this.name = "ProjectLifecycleDurabilityError";
  }
}

export class ProjectLibraryIncompatibleSchemaError extends Error {
  constructor(schemaVersion: string) {
    super(`Project schema ${schemaVersion} has an unsupported major version`);
    this.name = "ProjectLibraryIncompatibleSchemaError";
  }
}

export async function openProjectLibrary(options: ProjectLibraryOptions): Promise<ProjectLibrary> {
  return ProjectLibrary.open(options);
}

export class ProjectLibrary {
  readonly #currentSchemaVersion: string;
  readonly #faultInjector: NonNullable<ProjectLibraryOptions["faultInjector"]>;
  readonly #migrations: readonly ProjectMigration[];
  readonly #now: () => Date;
  readonly #pathPolicy: NonNullable<ProjectLibraryOptions["pathPolicy"]>;
  readonly #stateRoot: string;
  #activeRoot: string;
  #entries = new Map<string, LibraryEntry>();
  readonly #migrationFailures = new Map<string, string>();
  #locatorCatalog = new Map<string, ProjectOwnedRecords["sources"][number]["locators"]>();
  #mutationBlockedError: Error | undefined;
  #mutationTail: Promise<void> = Promise.resolve();
  readonly #subscribers = new Set<(change: ProjectLibraryChange) => void>();

  private constructor(options: ProjectLibraryOptions, activeRoot: string) {
    this.#activeRoot = activeRoot;
    this.#currentSchemaVersion = options.currentSchemaVersion ?? CONTRACT_VERSION;
    parseSchemaVersion(this.#currentSchemaVersion);
    this.#faultInjector = options.faultInjector ?? (() => undefined);
    this.#migrations = options.migrations ?? [];
    validateMigrationGraph(this.#migrations);
    this.#now = options.now ?? (() => new Date());
    this.#pathPolicy = options.pathPolicy ?? classifyLibraryPath;
    this.#stateRoot = resolve(options.stateRoot);
  }

  static async open(options: ProjectLibraryOptions): Promise<ProjectLibrary> {
    if (!isAbsolute(options.stateRoot))
      throw new Error("Project Library state root must be absolute");
    const stateRoot = resolve(options.stateRoot);
    await ensureDurableDirectory(stateRoot);
    await inspectRelocationJournal(stateRoot);
    const locationPath = join(stateRoot, LIBRARY_LOCATION_FILE);
    const configuredRoot = await readLibraryLocation(
      locationPath,
      join(stateRoot, DEFAULT_LIBRARY_DIRECTORY),
    );
    const activeRoot = await canonicalizeLibraryPath(configuredRoot);
    const library = new ProjectLibrary(options, activeRoot);
    await library.#assertLocalPath(activeRoot);
    await library.#initializeRoot();
    await library.#cleanupCompletedRelocation();
    return library;
  }

  get activeRoot(): string {
    return this.#activeRoot;
  }

  listProjects(): ProjectLibraryListEntry[] {
    return [...this.#entries.entries()]
      .map(([projectId, entry]) => ({
        ...(entry.revision === undefined
          ? {}
          : {
              compatibility: entry.compatibility,
              projectRevisionId: entry.revision.revision.projectRevisionId,
            }),
        projectId,
        ...(entry.migrationFailure === undefined
          ? {}
          : { migrationFailure: entry.migrationFailure }),
        ...(entry.recoveryReport === undefined ? {} : { recoveryReport: entry.recoveryReport }),
        status: entry.status,
      }))
      .toSorted((left, right) => left.projectId.localeCompare(right.projectId));
  }

  subscribe(listener: (change: ProjectLibraryChange) => void): () => void {
    this.#subscribers.add(listener);
    return () => this.#subscribers.delete(listener);
  }

  findLocalFileSourceByFingerprint(
    fingerprint: string,
  ): ProjectOwnedRecords["sources"][number] | undefined {
    return this.#findSource(
      ({ identity }) => identity.kind === "local_file" && identity.fingerprint === fingerprint,
    );
  }

  getSourceById(sourceId: string): ProjectOwnedRecords["sources"][number] | undefined {
    return this.#findSource(({ id }) => id === sourceId);
  }

  async observeSourceLocator(sourceId: string, rawLocator: unknown): Promise<void> {
    return this.#serializeMutation(async () => {
      const locator = SourceLocatorSchema.parse(rawLocator);
      const candidateEntries = new Map(this.#entries);
      let found = false;
      for (const [projectId, entry] of this.#entries) {
        if (entry.revision === undefined) continue;
        const source = entry.revision.payload.records.sources.find(({ id }) => id === sourceId);
        if (source === undefined) continue;
        if (!locatorMatchesSourceIdentity(source, locator))
          throw new Error("Source Locator does not match Source identity");
        const candidate = structuredClone(entry);
        const candidateSource = candidate.revision?.payload.records.sources.find(
          ({ id }) => id === sourceId,
        );
        if (candidateSource === undefined) throw new Error("Source record clone is unavailable");
        candidateSource.locators.push(locator);
        candidateEntries.set(projectId, candidate);
        found = true;
        break;
      }
      if (!found) throw new Error(`Source ${sourceId} was not found`);
      this.#locatorCatalog = await this.#refreshLocatorCatalog(candidateEntries);
    });
  }

  #findSource(
    matches: (source: ProjectOwnedRecords["sources"][number]) => boolean,
  ): ProjectOwnedRecords["sources"][number] | undefined {
    for (const entry of this.#entries.values()) {
      if (entry.location !== "active" || entry.status !== "active" || entry.revision === undefined)
        continue;
      const source = this.#recordsWithCurrentLocators(entry.revision.payload.records).sources.find(
        matches,
      );
      if (source !== undefined) return structuredClone(source);
    }
    return undefined;
  }

  async createProject(input: {
    envelope: unknown;
    records: ProjectOwnedRecords;
  }): Promise<{ projectRevisionId: string }> {
    return this.#serializeMutation(async () => {
      const payload = buildStoredPayload(input);
      this.#assertCurrentWritableSchema(payload.envelope);
      const projectId = payload.envelope.payload.id;
      if (this.#entries.has(projectId)) throw new Error(`Project ${projectId} already exists`);
      const revision = await this.#commitPayload(projectId, payload, null, 1, "created");
      return { projectRevisionId: revision.revision.projectRevisionId };
    });
  }

  async restoreProjectRevision(input: {
    envelope: unknown;
    records: ProjectOwnedRecords;
  }): Promise<{ migrationFailure?: string; projectRevisionId: string }> {
    return this.#serializeMutation(async () => {
      const payload = buildStoredPayload(input);
      const projectId = payload.envelope.payload.id;
      if (this.#entries.has(projectId)) throw new Error(`Project ${projectId} already exists`);
      this.#assertRestorableSchema(payload.envelope);
      const restored = await this.#commitPayload(projectId, payload, null, 1, "restored");
      try {
        const migrated = await this.#migrateUntilCurrent(projectId, restored);
        return { projectRevisionId: migrated.revision.projectRevisionId };
      } catch (error) {
        if (
          error instanceof ProjectPublicationReconciliationError ||
          error === this.#mutationBlockedError
        )
          throw error;
        const migrationFailure = errorMessage(error);
        this.#migrationFailures.set(projectId, migrationFailure);
        await this.#refreshEntries();
        return {
          migrationFailure,
          projectRevisionId: restored.revision.projectRevisionId,
        };
      }
    });
  }

  async readProject(projectId: string): Promise<{
    compatibility: "read_only" | "writable";
    envelope: z.infer<typeof ProjectEnvelopeSchema>;
    projectRevisionId: string;
    records: ProjectOwnedRecords;
    recoveryReport?: ProjectRecoveryReport;
    migrationFailure?: string;
    revisions: Array<{
      createdAt: string;
      projectRevisionId: string;
      reason: ProjectRevisionRecord["reason"];
    }>;
  }> {
    const entry = this.#entries.get(projectId);
    if (entry === undefined || entry.location === "trashed")
      throw new Error(`Project ${projectId} was not found`);
    if (entry.status === "damaged" || entry.revision === undefined)
      throw new ProjectLibraryDamagedError(projectId);
    return {
      compatibility: entry.compatibility,
      envelope: structuredClone(entry.revision.payload.envelope),
      projectRevisionId: entry.revision.revision.projectRevisionId,
      records: this.#recordsWithCurrentLocators(entry.revision.payload.records),
      ...(entry.migrationFailure === undefined ? {} : { migrationFailure: entry.migrationFailure }),
      ...(entry.recoveryReport === undefined
        ? {}
        : { recoveryReport: structuredClone(entry.recoveryReport) }),
      revisions: entry.revisions.map(({ revision }) => ({
        createdAt: revision.createdAt,
        projectRevisionId: revision.projectRevisionId,
        reason: revision.reason,
      })),
    };
  }

  async getSnapshot(projectId: string): Promise<{
    eventSequence: number;
    project: ProjectContract;
    projectRevisionId: string;
  } | null> {
    const entry = this.#entries.get(projectId);
    if (entry === undefined || entry.location === "trashed") return null;
    if (entry.status === "damaged" || entry.revision === undefined)
      throw new ProjectLibraryDamagedError(projectId);
    return {
      eventSequence: entry.revision.pointer.sequence,
      project: structuredClone(entry.revision.payload.envelope.payload),
      projectRevisionId: entry.revision.revision.projectRevisionId,
    };
  }

  async getProjectRange(projectId: string): Promise<ProjectOwnedRecords["projectRange"] | null> {
    const entry = this.#entries.get(projectId);
    if (entry === undefined || entry.location === "trashed" || entry.revision === undefined) {
      return null;
    }
    return structuredClone(entry.revision.payload.records.projectRange);
  }

  async resolveBlockedDependencies(input: {
    canonicalAudioFingerprint: string;
    modelStore: {
      resolveBlockedRecipeArtifacts(
        recipe: AnalysisRecipe,
      ): Promise<Array<{ id: string; kind: "model" }>>;
    };
    projectId: string;
    recipe: AnalysisRecipe;
    sourceSnapshotId: string;
  }): Promise<Array<{ id: string; kind: "media" | "model" }>> {
    const entry = this.#entries.get(input.projectId);
    if (entry === undefined || entry.location === "trashed" || entry.revision === undefined) {
      return [{ id: input.sourceSnapshotId, kind: "media" }];
    }
    const source = entry.revision.payload.records.sources.find(
      ({ id }) => id === entry.revision?.payload.records.projectRange.sourceId,
    );
    const snapshot = source?.snapshots.find(({ id }) => id === input.sourceSnapshotId);
    if (snapshot?.canonicalAudioFingerprint !== input.canonicalAudioFingerprint) {
      return [{ id: input.sourceSnapshotId, kind: "media" }];
    }
    return input.modelStore.resolveBlockedRecipeArtifacts(input.recipe);
  }

  async commitEditTransaction(input: {
    expectedProjectRevisionId: string;
    projectId: string;
    transaction: EditTransaction;
  }): Promise<
    { notFound: true } | { projectRevisionId: string } | { readOnly: true } | { stale: true }
  > {
    return this.#serializeMutation(async () => {
      const entry = this.#entries.get(input.projectId);
      if (entry === undefined || entry.location === "trashed") return { notFound: true };
      if (entry.status === "damaged" || entry.revision === undefined)
        throw new ProjectLibraryDamagedError(input.projectId);
      if (entry.compatibility === "read_only") return { readOnly: true };
      if (entry.revision.revision.projectRevisionId !== input.expectedProjectRevisionId)
        return { stale: true };

      const project = structuredClone(entry.revision.payload.envelope.payload);
      const activeView = project.activeView;
      if (activeView === null) throw new Error("Project has no Analysis Revision to edit");
      const activeLayer = project.editLayers.find(({ id }) => id === activeView.editLayerId);
      if (activeLayer === undefined) throw new Error("Active Edit Layer is missing");
      activeLayer.transactions.push(EditTransactionSchema.parse(input.transaction));
      activeView.editHistoryPosition = activeLayer.transactions.length;
      const payload = buildStoredPayload({
        envelope: { ...entry.revision.payload.envelope, payload: parseProjectContract(project) },
        records: entry.revision.payload.records,
      });
      const next = await this.#commitPayload(
        input.projectId,
        payload,
        entry.revision.revision.projectRevisionId,
        entry.revision.pointer.sequence + 1,
        "edit_transaction",
      );
      return { projectRevisionId: next.revision.projectRevisionId };
    });
  }

  async publishAnalysisRevision(input: {
    attemptId: string;
    canonicalAudioFingerprint: string;
    expectedProjectRevisionId: string;
    jobKey: string;
    manifest: AnalysisManifest;
    projectId: string;
    recipeHash: string;
    revision: AnalysisRevision;
    sourceIdentityKind: "canonical_audio" | "source_snapshot";
    sourceSnapshotId: string;
  }): Promise<
    { notFound: true } | { projectRevisionId: string } | { readOnly: true } | { stale: true }
  > {
    return this.#serializeMutation(async () => {
      const entry = this.#entries.get(input.projectId);
      if (entry === undefined || entry.location === "trashed") return { notFound: true };
      if (entry.status === "damaged" || entry.revision === undefined)
        throw new ProjectLibraryDamagedError(input.projectId);
      if (entry.compatibility === "read_only") return { readOnly: true };

      let verifiedCandidate;
      try {
        verifiedCandidate = validateAnalysisManifestProvenance({
          digest: hashContent,
          expectedCandidateIdentity: {
            attemptId: input.attemptId,
            canonicalAudioFingerprint: input.canonicalAudioFingerprint,
            jobKey: input.jobKey,
            projectId: input.projectId,
            recipeHash: input.recipeHash,
            sourceIdentityKind: input.sourceIdentityKind,
            sourceSnapshotId: input.sourceSnapshotId,
          },
          manifest: input.manifest,
          revision: input.revision,
        });
      } catch {
        throw new Error("Analysis Revision identity does not match its Job candidate manifest");
      }
      const candidate = verifiedCandidate.revision;
      const expectedManifestHash = verifiedCandidate.manifestHash;
      const project = structuredClone(entry.revision.payload.envelope.payload);
      const records = structuredClone(entry.revision.payload.records);
      const existing = project.analysisRevisions.find(({ id }) => id === candidate.id);
      if (existing !== undefined) {
        const retainedManifest = records.analysisManifests.find(
          ({ analysisRevisionId }) => analysisRevisionId === candidate.id,
        );
        if (canonicalSerialize(existing) !== canonicalSerialize(candidate)) {
          throw new Error(`Analysis Revision ${candidate.id} conflicts with published content`);
        }
        if (
          retainedManifest?.hash !== expectedManifestHash ||
          canonicalSerialize(retainedManifest.manifest) !== canonicalSerialize(input.manifest)
        ) {
          throw new Error(`Analysis Revision ${candidate.id} has no matching retained Manifest`);
        }
        return { projectRevisionId: entry.revision.revision.projectRevisionId };
      }
      if (entry.revision.revision.projectRevisionId !== input.expectedProjectRevisionId)
        return { stale: true };
      if (!analysisManifestSourceIsVerified(entry.revision.payload.records, input.manifest)) {
        throw new Error("Analysis candidate Source Snapshot is not verified by Project authority");
      }
      project.analysisRevisions.push(candidate);
      records.analysisManifests.push({
        analysisRevisionId: candidate.id,
        hash: expectedManifestHash,
        manifest: input.manifest,
      });
      if (project.activeView === null) {
        const editLayerId = `edit_${randomUUID().replaceAll("-", "")}`;
        project.editLayers.push({
          analysisRevisionId: candidate.id,
          id: editLayerId,
          transactions: [],
        });
        project.activeView = {
          analysisRevisionId: candidate.id,
          editHistoryPosition: 0,
          editLayerId,
          presentation: {
            beginnerView: false,
            enharmonicPreference: "contextual",
            transposeSemitones: 0,
          },
        };
      }
      const payload = buildStoredPayload({
        envelope: {
          ...entry.revision.payload.envelope,
          payload: parseProjectContract(project),
        },
        records,
      });
      const next = await this.#commitPayload(
        input.projectId,
        payload,
        entry.revision.revision.projectRevisionId,
        entry.revision.pointer.sequence + 1,
        "analysis_publication",
      );
      return { projectRevisionId: next.revision.projectRevisionId };
    });
  }

  async rollbackProject(
    projectId: string,
    targetProjectRevisionId: string,
    expectedProjectRevisionId: string,
  ): Promise<{ projectRevisionId: string }> {
    return this.#serializeMutation(async () => {
      const entry = this.#requireWritableEntry(projectId, expectedProjectRevisionId);
      const target = entry.revisions.find(
        ({ revision }) => revision.projectRevisionId === targetProjectRevisionId,
      );
      if (target === undefined) throw new Error("Rollback Project Revision was not found");
      const payload = await this.#prepareMigratedPayload(target);
      const next = await this.#commitPayload(
        projectId,
        payload,
        entry.revision.revision.projectRevisionId,
        entry.revision.pointer.sequence + 1,
        "rollback",
      );
      return { projectRevisionId: next.revision.projectRevisionId };
    });
  }

  async trashProject(projectId: string): Promise<void> {
    await this.#serializeMutation(() =>
      this.#runReconciledLifecycleMutation(async () => {
        const entry = this.#entries.get(projectId);
        if (entry === undefined || entry.location === "trashed")
          throw new Error("Project was not found");
        const source = this.#projectDirectory(projectId, "active");
        await assertManagedDirectory(this.#activeRoot, source);
        const target = this.#projectDirectory(projectId, "trashed");
        await assertManagedDirectory(this.#activeRoot, dirname(target));
        await mkdir(dirname(target), { recursive: true });
        const trashRecord = TrashRecordSchema.parse({
          format: "open-chords/library-trash-record",
          projectId,
          schemaVersion: "1.0",
          trashedAt: this.#now().toISOString(),
        });
        await atomicWriteFile(join(source, "TRASH.json"), canonicalSerialize(trashRecord));
        await syncDirectory(source);
        await rename(source, target);
        try {
          await this.#faultInjector("before_trash_parent_sync");
          await syncDirectory(dirname(source));
          await syncDirectory(dirname(target));
        } catch (error) {
          throw new ProjectLifecycleDurabilityError(error);
        }
        await this.#faultInjector("after_trash_move");
        await this.#refreshEntries();
      }),
    );
  }

  async restoreTrashedProject(projectId: string): Promise<void> {
    await this.#serializeMutation(() =>
      this.#runReconciledLifecycleMutation(async () => {
        const entry = this.#entries.get(projectId);
        if (entry?.location !== "trashed") throw new Error("Trashed Project was not found");
        const source = this.#projectDirectory(projectId, "trashed");
        await assertManagedDirectory(this.#activeRoot, source);
        const target = this.#projectDirectory(projectId, "active");
        await assertManagedDirectory(this.#activeRoot, dirname(target));
        await rename(source, target);
        try {
          await this.#faultInjector("before_trash_restore_parent_sync");
          await syncDirectory(dirname(source));
          await syncDirectory(dirname(target));
        } catch (error) {
          throw new ProjectLifecycleDurabilityError(error);
        }
        await this.#faultInjector("after_trash_restore_move");
        await rm(join(target, "TRASH.json"), { force: true });
        await syncDirectory(target);
        await this.#refreshEntries();
      }),
    );
  }

  async permanentlyDeleteProject(projectId: string, confirmation: string): Promise<void> {
    if (confirmation !== projectId)
      throw new Error("Permanent deletion confirmation does not match");
    await this.#serializeMutation(() =>
      this.#runReconciledLifecycleMutation(async () => {
        const entry = this.#entries.get(projectId);
        if (entry?.location !== "trashed") throw new Error("Project must be in Library Trash");
        const projectDirectory = this.#projectDirectory(projectId, "trashed");
        await assertManagedDirectory(this.#activeRoot, projectDirectory);
        await rm(projectDirectory, { recursive: true });
        try {
          await this.#faultInjector("before_permanent_delete_parent_sync");
          await syncDirectory(join(this.#activeRoot, "trash"));
        } catch (error) {
          throw new ProjectLifecycleDurabilityError(error);
        }
        await this.#faultInjector("after_permanent_delete");
        await this.#refreshEntries();
        await this.#collectUnreferencedObjects();
      }),
    );
  }

  async emptyTrash(options: { olderThan?: Date } = {}): Promise<string[]> {
    return this.#serializeMutation(() =>
      this.#runReconciledLifecycleMutation(async () => {
        const threshold = options.olderThan ?? new Date(this.#now().getTime() - THIRTY_DAYS_MS);
        const deleted: string[] = [];
        for (const [projectId, entry] of this.#entries) {
          if (
            entry.location === "trashed" &&
            entry.trashRecord !== undefined &&
            new Date(entry.trashRecord.trashedAt) < threshold
          ) {
            const projectDirectory = this.#projectDirectory(projectId, "trashed");
            await assertManagedDirectory(this.#activeRoot, projectDirectory);
            await this.#faultInjector("before_empty_trash_remove");
            await rm(projectDirectory, { recursive: true });
            try {
              await syncDirectory(join(this.#activeRoot, "trash"));
            } catch (error) {
              throw new ProjectLifecycleDurabilityError(error);
            }
            deleted.push(projectId);
          }
        }
        await this.#refreshEntries();
        await this.#collectUnreferencedObjects();
        return deleted.toSorted();
      }),
    );
  }

  async relocate(targetRoot: string): Promise<void> {
    await this.#serializeMutation(async () => {
      if (!isAbsolute(targetRoot)) throw new Error("Project Library target must be absolute");
      const previousRoot = this.#activeRoot;
      const target = await canonicalizeLibraryPath(targetRoot);
      if (target === previousRoot) return;
      if (isNestedPath(previousRoot, target) || isNestedPath(target, previousRoot))
        throw new Error("Project Library cannot be relocated inside its current directory");
      await this.#assertLocalPath(target);
      if (await this.#resumeRelocation(target)) return;
      if (await pathExists(target))
        throw new Error("Project Library relocation target already exists");
      if (!(await pathExists(dirname(target))))
        throw new Error("Project Library relocation target parent must already exist");
      const targetParent = await realpath(dirname(target));
      const targetParentIdentity = await readDirectoryIdentity(targetParent);
      await syncDirectory(targetParent);
      await syncDirectory(dirname(targetParent));
      const stagingTarget = join(
        dirname(target),
        `.open-chords-library-relocation-${randomUUID()}`,
      );
      const relocationId = randomUUID();
      const relocationJournal = RelocationJournalSchema.parse({
        format: "open-chords/project-library-relocation",
        id: relocationId,
        previousRoot,
        schemaVersion: "1.0",
        stagingCleanupTarget: join(
          targetParent,
          `.open-chords-library-relocation-cleanup-${randomUUID()}`,
        ),
        stagingTarget,
        target,
        targetCleanupTarget: join(
          targetParent,
          `.open-chords-library-target-cleanup-${randomUUID()}`,
        ),
        targetParent,
        targetParentIdentity,
      });
      await atomicWriteFile(
        join(this.#stateRoot, RELOCATION_JOURNAL_FILE),
        canonicalSerialize(relocationJournal),
      );
      const stagedLibrary = join(stagingTarget, "library");
      await assertRelocationParent(relocationJournal);
      if (
        (await pathEntryExists(relocationJournal.stagingCleanupTarget)) ||
        (await pathEntryExists(relocationJournal.targetCleanupTarget))
      )
        throw new Error("Project Library relocation cleanup path already exists");
      await mkdir(stagingTarget);
      await assertRelocationParent(relocationJournal);
      await assertRealDirectory(stagingTarget);
      await writeDurableFile(
        join(stagingTarget, RELOCATION_MARKER_FILE),
        canonicalSerialize({
          format: "open-chords/project-library-relocation-marker",
          id: relocationId,
          schemaVersion: "1.0",
        }),
        "wx",
      );
      await syncDirectory(stagingTarget);
      await syncDirectory(dirname(stagingTarget));
      let targetInstalled = false;
      let targetDurable = false;
      let locationDurable = false;
      const locationPath = join(this.#stateRoot, LIBRARY_LOCATION_FILE);
      const locationContent = canonicalSerialize({
        activeRoot: target,
        format: "open-chords/project-library-location",
        schemaVersion: "1.0",
      });
      try {
        await this.#faultInjector("before_relocation_copy");
        await assertRelocationParent(relocationJournal);
        await assertRealDirectory(stagingTarget);
        await cp(previousRoot, stagedLibrary, {
          errorOnExist: true,
          force: false,
          recursive: true,
        });
        await rm(join(stagedLibrary, "staging"), { force: true, recursive: true });
        await mkdir(join(stagedLibrary, "staging"));
        const validation = new ProjectLibrary(
          {
            currentSchemaVersion: this.#currentSchemaVersion,
            migrations: this.#migrations,
            now: this.#now,
            pathPolicy: this.#pathPolicy,
            stateRoot: this.#stateRoot,
          },
          stagedLibrary,
        );
        await validation.#initializeRoot();
        if (validation.listProjects().some(({ status }) => status === "damaged"))
          throw new Error("Relocated Project Library did not pass complete validation");
        await writeDurableFile(
          join(stagedLibrary, RELOCATION_MARKER_FILE),
          canonicalSerialize({
            format: "open-chords/project-library-relocation-marker",
            id: relocationId,
            schemaVersion: "1.0",
          }),
          "wx",
        );
        await syncTree(stagedLibrary);
        await assertRelocationParent(relocationJournal);
        await assertRealDirectory(stagingTarget);
        if (
          (await pathEntryExists(target)) ||
          (await pathEntryExists(relocationJournal.targetCleanupTarget))
        )
          throw new Error("Project Library relocation target appeared during copy");
        await rename(stagedLibrary, target);
        targetInstalled = true;
        await assertRelocationParent(relocationJournal);
        await assertRealDirectory(target);
        await syncDirectory(dirname(target));
        targetDurable = true;
        await this.#faultInjector("after_relocation_target_rename");
        await atomicWriteFile(locationPath, locationContent, () =>
          this.#faultInjector("after_relocation_location_rename"),
        );
        locationDurable = true;
        await this.#faultInjector("after_relocation_location_replace");
        this.#activeRoot = target;
        await this.#refreshEntries();
        await this.#removeRelocationStaging(relocationJournal, target);
        await this.#cleanupCompletedRelocation();
      } catch (error) {
        let stagingCleanupError: unknown;
        try {
          await this.#faultInjector("before_relocation_staging_cleanup");
          await this.#removeRelocationStaging(relocationJournal, target);
        } catch (cleanupError) {
          stagingCleanupError = cleanupError;
        }
        if (targetInstalled) {
          try {
            if (!targetDurable) await syncDirectory(dirname(target));
            if (!locationDurable) await atomicWriteFile(locationPath, locationContent);
            this.#activeRoot = target;
            await this.#refreshEntries();
          } catch (recoveryError) {
            this.#mutationBlockedError = new Error(
              "Project Library must be reopened after an unreconciled relocation failure",
              { cause: recoveryError },
            );
            throw new Error("Project Library relocation failed and reconciliation also failed", {
              cause: recoveryError,
            });
          }
        }
        if (stagingCleanupError !== undefined)
          throw new Error(
            `Project Library relocation and staging cleanup both failed: ${errorMessage(stagingCleanupError)}`,
            { cause: error },
          );
        if (targetInstalled) await this.#cleanupCompletedRelocation();
        else await this.#clearRelocationJournal();
        if (targetInstalled) return;
        throw error;
      }
    });
  }

  async #resumeRelocation(target: string): Promise<boolean> {
    const journal = await readRelocationJournal(this.#stateRoot);
    if (journal === undefined) return false;
    if (journal.previousRoot !== this.#activeRoot || journal.target !== target)
      throw new Error("Another Project Library relocation requires recovery first");
    await this.#removeRelocationStaging(journal, target);
    await this.#claimValidateAndRemoveRelocationPath(
      journal,
      target,
      journal.targetCleanupTarget,
      false,
    );
    await this.#clearRelocationJournal();
    return false;
  }

  async #cleanupCompletedRelocation(): Promise<void> {
    const journal = await readRelocationJournal(this.#stateRoot);
    if (journal === undefined || journal.target !== this.#activeRoot) return;
    await this.#removeRelocationStaging(journal, this.#activeRoot);
    const markerPath = join(this.#activeRoot, RELOCATION_MARKER_FILE);
    if (await pathExists(markerPath)) {
      const marker = await parseJsonFile(markerPath, RelocationMarkerSchema);
      if (marker.id !== journal.id)
        throw new Error("Project Library relocation marker does not match its journal");
      await rm(markerPath);
    }
    await syncDirectory(this.#activeRoot);
    await this.#clearRelocationJournal();
  }

  async #removeRelocationStaging(
    journal: z.infer<typeof RelocationJournalSchema>,
    approvedTarget: string,
  ): Promise<void> {
    if (dirname(approvedTarget) !== journal.targetParent)
      throw new Error("Project Library relocation staging path is outside its approved parent");
    await this.#claimValidateAndRemoveRelocationPath(
      journal,
      journal.stagingTarget,
      journal.stagingCleanupTarget,
      true,
    );
  }

  async #claimValidateAndRemoveRelocationPath(
    journal: z.infer<typeof RelocationJournalSchema>,
    candidate: string,
    cleanupTarget: string,
    allowEmptyWithoutMarker: boolean,
  ): Promise<void> {
    await assertRelocationParent(journal);
    const candidateExists = await pathEntryExists(candidate);
    const cleanupExists = await pathEntryExists(cleanupTarget);
    if (candidateExists && cleanupExists)
      throw new Error("Project Library relocation cleanup ownership is ambiguous");
    if (!candidateExists && !cleanupExists) {
      await syncDirectory(journal.targetParent);
      await assertRelocationParent(journal);
      return;
    }
    if (!cleanupExists) {
      await validateRelocationOwnedDirectory(candidate, journal.id, allowEmptyWithoutMarker);
      await this.#faultInjector("before_relocation_cleanup_claim");
      await assertRelocationParent(journal);
      await rename(candidate, cleanupTarget);
      await syncDirectory(journal.targetParent);
    }
    await assertRelocationParent(journal);
    await validateRelocationOwnedDirectory(cleanupTarget, journal.id, allowEmptyWithoutMarker);
    await rm(cleanupTarget, { recursive: true });
    await this.#faultInjector("after_relocation_cleanup_remove");
    await syncDirectory(journal.targetParent);
  }

  async #clearRelocationJournal(): Promise<void> {
    await rm(join(this.#stateRoot, RELOCATION_JOURNAL_FILE), { force: true });
    await syncDirectory(this.#stateRoot);
  }

  async #initializeRoot(): Promise<void> {
    await ensureManagedDirectory(this.#activeRoot, this.#activeRoot);
    for (const directory of [
      join(this.#activeRoot, "objects"),
      join(this.#activeRoot, "objects", "sha256"),
      join(this.#activeRoot, "projects"),
      join(this.#activeRoot, "quarantine"),
      join(this.#activeRoot, "reports"),
      join(this.#activeRoot, "staging"),
      join(this.#activeRoot, "trash"),
    ])
      await ensureManagedDirectory(this.#activeRoot, directory);
    await this.#refreshEntries();
    await scavengeDirectory(this.#activeRoot, join(this.#activeRoot, "staging"));
    await this.#migrateExistingProjects();
    await this.#collectUnreferencedObjects();
  }

  async #refreshEntries(): Promise<void> {
    const entries = new Map<string, LibraryEntry>();
    await this.#scanProjectContainer("active", entries);
    await this.#scanProjectContainer("trashed", entries);
    validateLibrarySourceAuthority(entries);
    for (const [projectId, failure] of this.#migrationFailures) {
      const entry = entries.get(projectId);
      if (entry !== undefined) entry.migrationFailure = failure;
    }
    const locatorCatalog = await this.#refreshLocatorCatalog(entries);
    this.#entries = entries;
    this.#locatorCatalog = locatorCatalog;
    await atomicWriteFile(
      join(this.#activeRoot, "project-index.json"),
      canonicalSerialize({
        format: "open-chords/rebuildable-project-index",
        projects: this.listProjects(),
        schemaVersion: "1.0",
      }),
    ).catch(() => {
      // The index is an optional projection; a failed rewrite cannot invalidate a verified Head.
    });
  }

  async #scanProjectContainer(
    location: "active" | "trashed",
    entries: Map<string, LibraryEntry>,
  ): Promise<void> {
    const container = join(this.#activeRoot, location === "active" ? "projects" : "trash");
    await assertManagedDirectory(this.#activeRoot, container);
    for (const directory of await readdir(container, { withFileTypes: true })) {
      if (!directory.isDirectory())
        throw new Error(
          `Managed Project container contains an unsupported entry: ${directory.name}`,
        );
      const projectId = directory.name;
      if (entries.has(projectId))
        throw new Error(`Project ${projectId} exists in both active Library and Trash`);
      const projectDirectory = join(container, projectId);
      await assertManagedDirectory(this.#activeRoot, projectDirectory);
      const recoveryReport = await readLatestRecoveryReport(this.#activeRoot, projectDirectory);
      const stagedBoundary = await this.#stagedHeadForProject(projectDirectory, projectId);
      const headExists = await pathExists(join(projectDirectory, "HEAD.json"));
      if (
        location === "active" &&
        recoveryReport === undefined &&
        !headExists &&
        stagedBoundary?.kind === "valid" &&
        stagedBoundary.head.sequence === 1
      ) {
        const quarantineDirectory = join(this.#activeRoot, "quarantine");
        await assertManagedDirectory(this.#activeRoot, quarantineDirectory);
        await rename(
          projectDirectory,
          join(quarantineDirectory, `${safeFileName(projectId)}-UNPUBLISHED-${randomUUID()}`),
        );
        await syncDirectory(quarantineDirectory);
        await syncDirectory(container);
        continue;
      }
      let trashRecord: TrashRecord | undefined;
      try {
        if (location === "trashed")
          trashRecord = await parseJsonFile(
            join(projectDirectory, "TRASH.json"),
            TrashRecordSchema,
          );
        const revision = await this.#readHead(projectDirectory, projectId);
        await this.#discardUnpublishedRevisionTail(projectDirectory, revision.pointer.sequence);
        const revisions = await this.#readVerifiedRevisions(projectDirectory, projectId);
        entries.set(projectId, {
          compatibility: this.#compatibilityFor(revision.payload.envelope),
          location,
          ...(recoveryReport === undefined ? {} : { recoveryReport }),
          revision,
          revisions,
          status: location === "active" ? "active" : "trashed",
          ...(trashRecord === undefined ? {} : { trashRecord }),
        });
      } catch (error) {
        if (!(error instanceof ProjectStorageCorruptionError)) throw error;
        if (location === "trashed") {
          const revisions = await this.#readVerifiedRevisions(projectDirectory, projectId);
          const latest = revisions.at(-1);
          entries.set(projectId, {
            compatibility:
              latest === undefined ? "read_only" : this.#compatibilityFor(latest.payload.envelope),
            location,
            ...(recoveryReport === undefined ? {} : { recoveryReport }),
            ...(latest === undefined ? {} : { revision: latest }),
            revisions,
            status: "damaged",
            ...(trashRecord === undefined ? {} : { trashRecord }),
          });
          continue;
        }
        const recovered = await this.#recoverProject(
          projectDirectory,
          projectId,
          stagedBoundary === undefined
            ? headExists
              ? undefined
              : 0
            : stagedBoundary.kind === "valid"
              ? stagedBoundary.head.sequence - 1
              : 0,
        );
        entries.set(projectId, recovered);
      }
    }
  }

  async #stagedHeadForProject(
    projectDirectory: string,
    projectId: string,
  ): Promise<
    { head: z.infer<typeof ProjectHeadSchema>; kind: "valid" } | { kind: "ambiguous" } | undefined
  > {
    const stagingDirectory = join(this.#activeRoot, "staging");
    await assertManagedDirectory(this.#activeRoot, stagingDirectory);
    const candidates: z.infer<typeof ProjectHeadSchema>[] = [];
    for (const entry of await readdir(stagingDirectory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const headPath = join(stagingDirectory, entry.name, "HEAD.json");
      if (!(await pathExists(headPath))) continue;
      try {
        const head = await parseJsonFile(headPath, ProjectHeadSchema);
        if (head.projectId === projectId) candidates.push(head);
      } catch (error) {
        if (!(error instanceof ProjectStorageCorruptionError)) throw error;
      }
    }
    if (candidates.length === 0) return undefined;
    if (candidates.length !== 1) return { kind: "ambiguous" };
    const head = candidates[0];
    if (head === undefined) return { kind: "ambiguous" };
    try {
      const revisions = await this.#readVerifiedRevisions(projectDirectory, projectId);
      const exactMatch = revisions.some(
        ({ pointer }) =>
          pointer.projectRevisionId === head.projectRevisionId &&
          pointer.revisionObjectHash === head.revisionObjectHash &&
          pointer.sequence === head.sequence,
      );
      return exactMatch ? { head, kind: "valid" } : { kind: "ambiguous" };
    } catch (error) {
      if (error instanceof ProjectStorageCorruptionError) return { kind: "ambiguous" };
      throw error;
    }
  }

  async #recoverProject(
    projectDirectory: string,
    projectId: string,
    maximumRecoverableSequence?: number,
  ): Promise<LibraryEntry> {
    let lostProjectRevisionId: string | null = null;
    try {
      const rawHead = await parseJsonFile(join(projectDirectory, "HEAD.json"), ProjectHeadSchema);
      lostProjectRevisionId = rawHead.projectRevisionId;
    } catch (error) {
      if (!(error instanceof ProjectStorageCorruptionError)) throw error;
      // The quarantined report still explains that the active Head was unreadable.
    }
    const headPath = join(projectDirectory, "HEAD.json");
    if (await pathExists(headPath)) {
      await assertManagedDirectory(this.#activeRoot, join(this.#activeRoot, "quarantine"));
      await rename(
        headPath,
        join(
          this.#activeRoot,
          "quarantine",
          `${safeFileName(projectId)}-HEAD-${randomUUID()}.json`,
        ),
      );
      await syncDirectory(join(this.#activeRoot, "quarantine"));
      await syncDirectory(projectDirectory);
    }
    if (maximumRecoverableSequence !== undefined && maximumRecoverableSequence > 0)
      await this.#discardUnpublishedRevisionTail(projectDirectory, maximumRecoverableSequence);
    const revisions = await this.#readVerifiedRevisions(projectDirectory, projectId);
    const recovered =
      maximumRecoverableSequence === undefined
        ? revisions.at(-1)
        : revisions.findLast(({ pointer }) => pointer.sequence <= maximumRecoverableSequence);
    const report = RecoveryReportSchema.parse({
      createdAt: this.#now().toISOString(),
      format: "open-chords/project-recovery-report",
      lostProjectRevisionId,
      projectId,
      recoveredProjectRevisionId: recovered?.revision.projectRevisionId ?? null,
      reason: "active_head_corrupt",
      schemaVersion: "1.0",
    });
    const reportsDirectory = join(projectDirectory, "reports");
    await ensureManagedDirectory(this.#activeRoot, reportsDirectory);
    await writeDurableFile(
      join(reportsDirectory, `recovery-${Date.now()}-${randomUUID()}.json`),
      canonicalSerialize(report),
      "wx",
    );
    await syncDirectory(reportsDirectory);
    if (recovered === undefined) {
      return {
        compatibility: "read_only",
        location: "active",
        recoveryReport: report,
        revisions: [],
        status: "damaged",
      };
    }
    await atomicWriteFile(
      headPath,
      canonicalSerialize({
        format: "open-chords/project-head",
        projectId,
        projectRevisionId: recovered.revision.projectRevisionId,
        revisionObjectHash: recovered.pointer.revisionObjectHash,
        schemaVersion: "1.0",
        sequence: recovered.pointer.sequence,
      }),
    );
    return {
      compatibility: this.#compatibilityFor(recovered.payload.envelope),
      location: "active",
      recoveryReport: report,
      revision: recovered,
      revisions,
      status: "active",
    };
  }

  async #readHead(projectDirectory: string, projectId: string): Promise<RevisionSnapshot> {
    const head = await parseJsonFile(join(projectDirectory, "HEAD.json"), ProjectHeadSchema);
    if (head.projectId !== projectId)
      throw new ProjectStorageCorruptionError("Project Head belongs to another Project");
    const revisions = await this.#readVerifiedRevisions(projectDirectory, projectId);
    const revision = revisions.find(
      ({ pointer }) =>
        pointer.projectRevisionId === head.projectRevisionId &&
        pointer.revisionObjectHash === head.revisionObjectHash &&
        pointer.sequence === head.sequence,
    );
    if (revision === undefined)
      throw new ProjectStorageCorruptionError(
        "Project Head does not identify a revision in the verified pointer ledger",
      );
    return revision;
  }

  async #discardUnpublishedRevisionTail(
    projectDirectory: string,
    headSequence: number,
  ): Promise<void> {
    const revisionsDirectory = join(projectDirectory, "revisions");
    await assertManagedDirectory(this.#activeRoot, revisionsDirectory);
    let removed = false;
    for (const file of await readdir(revisionsDirectory)) {
      if (!file.endsWith(".json")) continue;
      try {
        const pointer = await parseJsonFile(join(revisionsDirectory, file), RevisionPointerSchema);
        if (pointer.sequence <= headSequence) continue;
        await rm(join(revisionsDirectory, file));
        removed = true;
      } catch (error) {
        if (!(error instanceof ProjectStorageCorruptionError)) throw error;
      }
    }
    if (removed) await syncDirectory(revisionsDirectory);
  }

  async #readVerifiedRevisions(
    projectDirectory: string,
    projectId: string,
  ): Promise<RevisionSnapshot[]> {
    const revisionsDirectory = join(projectDirectory, "revisions");
    let files: string[];
    try {
      await assertManagedDirectory(this.#activeRoot, revisionsDirectory);
      files = await readdir(revisionsDirectory);
    } catch (error) {
      if (isMissingPathError(error)) return [];
      throw error;
    }
    const candidates: RevisionSnapshot[] = [];
    for (const file of files.toSorted()) {
      if (!file.endsWith(".json")) continue;
      try {
        const pointer = await parseJsonFile(join(revisionsDirectory, file), RevisionPointerSchema);
        candidates.push(await this.#readRevision(pointer.revisionObjectHash, pointer, projectId));
      } catch (error) {
        if (!(error instanceof ProjectStorageCorruptionError)) throw error;
        // Invalid immutable revisions are ignored during recovery and remain available for diagnosis.
      }
    }
    const sorted = candidates.toSorted(
      (left, right) =>
        left.pointer.sequence - right.pointer.sequence ||
        left.revision.projectRevisionId.localeCompare(right.revision.projectRevisionId),
    );
    const verified: RevisionSnapshot[] = [];
    let expectedSequence = 1;
    let expectedParent: string | null = null;
    while (true) {
      const matching = sorted.filter(
        ({ pointer, revision }) =>
          pointer.sequence === expectedSequence &&
          revision.parentProjectRevisionId === expectedParent,
      );
      if (matching.length !== 1) break;
      const next = matching[0];
      if (next === undefined) break;
      verified.push(next);
      expectedParent = next.revision.projectRevisionId;
      expectedSequence += 1;
    }
    return verified;
  }

  async #readRevision(
    revisionObjectHash: string,
    pointer: RevisionPointer,
    expectedProjectId?: string,
  ): Promise<RevisionSnapshot> {
    const revision = await this.#readObject(revisionObjectHash, ProjectRevisionRecordSchema);
    if (
      revision.projectRevisionId !== pointer.projectRevisionId ||
      (expectedProjectId !== undefined && revision.projectId !== expectedProjectId)
    ) {
      throw new ProjectStorageCorruptionError(
        "Project Revision pointer does not match its immutable object",
      );
    }
    const payload = await this.#readStoredPayload(revision.payloadObjectHash);
    try {
      validateStoredPayload(payload);
    } catch (error) {
      if (error instanceof ProjectLibraryIncompatibleSchemaError) throw error;
      throw new ProjectStorageCorruptionError("Stored Project payload is invalid", error);
    }
    if (payload.envelope.payload.id !== revision.projectId)
      throw new ProjectStorageCorruptionError(
        "Project Revision payload belongs to another Project",
      );
    return { payload, pointer, revision };
  }

  async #readObject<T>(hash: string, schema: z.ZodType<T>): Promise<T> {
    const content = await this.#readHashedObjectContent(hash);
    try {
      return schema.parse(JSON.parse(content));
    } catch (error) {
      throw new ProjectStorageCorruptionError("Immutable object is invalid", error);
    }
  }

  async #readStoredPayload(hash: string): Promise<StoredProjectPayload> {
    const content = await this.#readHashedObjectContent(hash);
    let raw: unknown;
    try {
      raw = JSON.parse(content);
    } catch (error) {
      throw new ProjectStorageCorruptionError("Immutable Project payload is not JSON", error);
    }
    let compatibility: { futureMinor: boolean };
    try {
      compatibility = inspectStoredPayloadCompatibility(raw);
    } catch (error) {
      if (error instanceof ProjectLibraryIncompatibleSchemaError) throw error;
      throw new ProjectStorageCorruptionError(
        "Immutable Project payload has invalid versions",
        error,
      );
    }
    try {
      return StoredProjectPayloadSchema.parse(migrateStoredPayloadV1AnalysisProvenance(raw));
    } catch (error) {
      if (compatibility.futureMinor)
        throw new ProjectLibraryIncompatibleSchemaError(
          "newer minor with unsupported core semantics",
        );
      throw new ProjectStorageCorruptionError("Immutable Project payload is invalid", error);
    }
  }

  async #readHashedObjectContent(hash: string): Promise<string> {
    let content: string;
    try {
      content = await readRegularStorageFile(this.#objectPath(hash));
    } catch (error) {
      if (isMissingPathError(error))
        throw new ProjectStorageCorruptionError("Immutable object is missing", error);
      throw error;
    }
    if (hashContent(content) !== hash)
      throw new ProjectStorageCorruptionError("Immutable object hash mismatch");
    return content;
  }

  async #commitPayload(
    projectId: string,
    rawPayload: StoredProjectPayload,
    parentProjectRevisionId: string | null,
    sequence: number,
    reason: ProjectRevisionRecord["reason"],
  ): Promise<RevisionSnapshot> {
    try {
      return await this.#commitPayloadAttempt(
        projectId,
        rawPayload,
        parentProjectRevisionId,
        sequence,
        reason,
      );
    } catch (error) {
      if (error instanceof ProjectHeadDurabilityError) {
        this.#mutationBlockedError = new Error(
          "Project Library must be reopened after an uncertain Head durability failure",
          { cause: error },
        );
        throw new ProjectPublicationReconciliationError(error);
      }
      let committedAfterFailure: RevisionSnapshot | undefined;
      try {
        await this.#refreshEntries();
        await scavengeDirectory(this.#activeRoot, join(this.#activeRoot, "staging"));
        await this.#collectUnreferencedObjects();
        const current = this.#entries.get(projectId)?.revision;
        const expectedPayloadHash = hashContent(
          canonicalSerialize(validateStoredPayload(rawPayload)),
        );
        if (
          current?.pointer.sequence === sequence &&
          current.revision.parentProjectRevisionId === parentProjectRevisionId &&
          current.revision.payloadObjectHash === expectedPayloadHash
        )
          committedAfterFailure = current;
      } catch (recoveryError) {
        const combinedFailure = new AggregateError(
          [error, recoveryError],
          "Project publication failed and storage reconciliation also failed",
        );
        this.#mutationBlockedError = new Error(
          "Project Library must be reopened after an unreconciled storage failure",
          { cause: combinedFailure },
        );
        throw new ProjectPublicationReconciliationError(recoveryError);
      }
      if (committedAfterFailure !== undefined) {
        this.#notifySubscribers(committedAfterFailure);
        return committedAfterFailure;
      }
      throw new ProjectPublicationError(error);
    }
  }

  async #commitPayloadAttempt(
    projectId: string,
    rawPayload: StoredProjectPayload,
    parentProjectRevisionId: string | null,
    sequence: number,
    reason: ProjectRevisionRecord["reason"],
  ): Promise<RevisionSnapshot> {
    const payload = validateStoredPayload(rawPayload);
    if (payload.envelope.payload.id !== projectId)
      throw new Error("Project payload belongs to another Project");
    assertSourceAuthorityAgainstEntries(payload.records, this.#entries);
    assertLocatorUpdates(payload.records, this.#locatorCatalog);
    const projectRevisionId = `projectrevision_${randomUUID().replaceAll("-", "")}`;
    await assertManagedDirectory(this.#activeRoot, join(this.#activeRoot, "staging"));
    const stagingDirectory = join(this.#activeRoot, "staging", randomUUID());
    await mkdir(stagingDirectory, { recursive: true });
    await syncDirectory(join(this.#activeRoot, "staging"));
    const payloadContent = canonicalSerialize(payload);
    const payloadObjectHash = hashContent(payloadContent);
    const stagedPayloadPath = join(stagingDirectory, "payload.json");
    await writeDurableFile(stagedPayloadPath, payloadContent, "wx");
    await this.#faultInjector("after_payload_durable");

    const revision = ProjectRevisionRecordSchema.parse({
      createdAt: this.#now().toISOString(),
      format: "open-chords/project-revision",
      parentProjectRevisionId,
      payloadObjectHash,
      projectId,
      projectRevisionId,
      reason,
      schemaVersion: "1.0",
    });
    const revisionContent = canonicalSerialize(revision);
    const revisionObjectHash = hashContent(revisionContent);
    const stagedRevisionPath = join(stagingDirectory, "revision.json");
    await writeDurableFile(stagedRevisionPath, revisionContent, "wx");

    const pointer = RevisionPointerSchema.parse({
      projectRevisionId,
      revisionObjectHash,
      sequence,
    });
    const stagedPointerPath = join(stagingDirectory, "revision-pointer.json");
    await writeDurableFile(stagedPointerPath, canonicalSerialize(pointer), "wx");
    const head = ProjectHeadSchema.parse({
      format: "open-chords/project-head",
      projectId,
      projectRevisionId,
      revisionObjectHash,
      schemaVersion: "1.0",
      sequence,
    });
    const stagedHeadPath = join(stagingDirectory, "HEAD.json");
    await writeDurableFile(stagedHeadPath, canonicalSerialize(head), "wx");
    await syncDirectory(stagingDirectory);

    await this.#installObject(stagedPayloadPath, payloadObjectHash);
    await this.#installObject(stagedRevisionPath, revisionObjectHash);
    const projectDirectory = this.#projectDirectory(projectId, "active");
    const revisionsDirectory = join(projectDirectory, "revisions");
    await ensureManagedDirectory(this.#activeRoot, projectDirectory);
    await ensureManagedDirectory(this.#activeRoot, revisionsDirectory);
    await rename(
      stagedPointerPath,
      join(revisionsDirectory, `${String(sequence).padStart(12, "0")}-${projectRevisionId}.json`),
    );
    await syncDirectory(revisionsDirectory);
    await this.#faultInjector("after_revision_durable");
    await this.#faultInjector("before_head_replace");
    await rename(stagedHeadPath, join(projectDirectory, "HEAD.json"));
    try {
      await this.#faultInjector("after_head_rename");
      await syncFile(join(projectDirectory, "HEAD.json"));
      await this.#faultInjector("after_head_file_sync");
      await syncDirectory(projectDirectory);
    } catch (error) {
      try {
        await atomicWriteFile(join(projectDirectory, "HEAD.json"), canonicalSerialize(head));
      } catch (recoveryError) {
        throw new ProjectHeadDurabilityError(
          new AggregateError([error, recoveryError], "Project Head durability retry failed"),
        );
      }
    }
    await this.#faultInjector("after_head_replace");
    await rm(stagingDirectory, { force: true, recursive: true });
    await this.#refreshEntries();
    const committed = this.#entries.get(projectId)?.revision;
    if (committed?.revision.projectRevisionId !== projectRevisionId)
      throw new Error("Committed Project Head could not be verified");
    this.#notifySubscribers(committed);
    return committed;
  }

  #notifySubscribers(committed: RevisionSnapshot): void {
    for (const subscriber of this.#subscribers) {
      try {
        subscriber({
          projectId: committed.revision.projectId,
          projectRevisionId: committed.revision.projectRevisionId,
          sequence: committed.pointer.sequence,
        });
      } catch {
        // Observer failures cannot roll back or invalidate an already durable Project Head.
      }
    }
  }

  async #installObject(stagedPath: string, hash: string): Promise<void> {
    await assertManagedDirectory(this.#activeRoot, join(this.#activeRoot, "objects", "sha256"));
    const target = this.#objectPath(hash);
    let installed = false;
    try {
      await rename(stagedPath, target);
      installed = true;
      await this.#faultInjector("after_object_rename");
      await syncDirectory(dirname(target));
    } catch (error) {
      if (installed) throw error;
      if (!(await pathExists(target))) throw error;
      const existing = await readFile(target, "utf8");
      if (hashContent(existing) !== hash)
        throw new Error("Content-addressed object collision", { cause: error });
      await rm(stagedPath, { force: true });
    }
  }

  async #migrateUntilCurrent(
    projectId: string,
    initial: RevisionSnapshot,
  ): Promise<RevisionSnapshot> {
    if (this.#compatibilityFor(initial.payload.envelope) === "writable") return initial;
    const migratedPayload = await this.#prepareMigratedPayload(initial);
    return this.#commitPayload(
      projectId,
      migratedPayload,
      initial.revision.projectRevisionId,
      initial.pointer.sequence + 1,
      "migration",
    );
  }

  async #prepareMigratedPayload(initial: RevisionSnapshot): Promise<StoredProjectPayload> {
    let envelope = structuredClone(initial.payload.envelope);
    let completedSteps = 0;
    while (isOlderCompatibleSchema(envelope, this.#currentSchemaVersion)) {
      if (completedSteps >= this.#migrations.length)
        throw new Error("Project migration graph did not reach the current schema");
      const fromVersion = oldestEnvelopeSchemaVersion(envelope);
      const migration = this.#migrations.find((candidate) => candidate.fromVersion === fromVersion);
      if (migration === undefined) throw new ProjectLibraryReadOnlyError(fromVersion);
      envelope = ProjectEnvelopeSchema.parse(await migration.migrate(structuredClone(envelope)));
      const nextVersion = oldestEnvelopeSchemaVersion(envelope);
      if (
        compareSchemaVersions(nextVersion, fromVersion) <= 0 ||
        nextVersion !== migration.toVersion
      )
        throw new Error("Project migration did not advance its complete schema state");
      buildStoredPayload({ envelope, records: initial.payload.records });
      completedSteps += 1;
    }
    const migratedPayload = buildStoredPayload({
      envelope,
      records: initial.payload.records,
    });
    this.#assertCurrentWritableSchema(migratedPayload.envelope);
    return migratedPayload;
  }

  async #migrateExistingProjects(): Promise<void> {
    const candidates = [...this.#entries.entries()].filter(
      ([, entry]) =>
        entry.location === "active" &&
        entry.status === "active" &&
        entry.revision !== undefined &&
        isOlderCompatibleSchema(entry.revision.payload.envelope, this.#currentSchemaVersion),
    );
    for (const [projectId, entry] of candidates) {
      if (entry.revision === undefined) continue;
      try {
        await this.#migrateUntilCurrent(projectId, entry.revision);
        this.#migrationFailures.delete(projectId);
      } catch (error) {
        if (
          error instanceof ProjectPublicationReconciliationError ||
          error === this.#mutationBlockedError
        )
          throw error;
        this.#migrationFailures.set(projectId, errorMessage(error));
        // A failed or unavailable migration leaves the last durable revision readable and read-only.
        await this.#refreshEntries();
        const refreshed = this.#entries.get(projectId);
        if (refreshed?.compatibility === "writable") {
          this.#migrationFailures.delete(projectId);
          delete refreshed.migrationFailure;
        }
      }
    }
  }

  async #collectUnreferencedObjects(): Promise<void> {
    if ([...this.#entries.values()].some(({ status }) => status === "damaged")) return;
    const referenced = new Set<string>();
    for (const entry of this.#entries.values()) {
      for (const revision of entry.revisions) {
        referenced.add(revision.pointer.revisionObjectHash);
        referenced.add(revision.revision.payloadObjectHash);
      }
    }
    const objectsDirectory = join(this.#activeRoot, "objects", "sha256");
    await assertManagedDirectory(this.#activeRoot, objectsDirectory);
    let removed = false;
    for (const file of await readdir(objectsDirectory)) {
      const match = /^([a-f0-9]{64})\.json$/.exec(file);
      if (match?.[1] === undefined) continue;
      if (referenced.has(`sha256:${match[1]}`)) continue;
      await rm(join(objectsDirectory, file));
      removed = true;
    }
    if (removed) await syncDirectory(objectsDirectory);
  }

  #requireWritableEntry(
    projectId: string,
    expectedProjectRevisionId: string,
  ): Required<Pick<LibraryEntry, "revision">> & LibraryEntry {
    const entry = this.#entries.get(projectId);
    if (entry === undefined || entry.status !== "active" || entry.revision === undefined)
      throw new Error("Project was not found or is damaged");
    if (entry.compatibility === "read_only")
      throw new ProjectLibraryReadOnlyError(entry.revision.payload.envelope.schemaVersion);
    if (entry.revision.revision.projectRevisionId !== expectedProjectRevisionId)
      throw new Error("Project Revision is stale");
    return { ...entry, revision: entry.revision };
  }

  #compatibilityFor(envelope: z.infer<typeof ProjectEnvelopeSchema>): "read_only" | "writable" {
    return compareSchemaVersions(envelope.schemaVersion, this.#currentSchemaVersion) === 0 &&
      compareSchemaVersions(envelope.payload.schemaVersion, this.#currentSchemaVersion) === 0
      ? "writable"
      : "read_only";
  }

  #assertCurrentWritableSchema(envelope: z.infer<typeof ProjectEnvelopeSchema>): void {
    if (this.#compatibilityFor(envelope) !== "writable")
      throw new ProjectLibraryReadOnlyError(envelope.schemaVersion);
  }

  #assertRestorableSchema(envelope: z.infer<typeof ProjectEnvelopeSchema>): void {
    const current = parseSchemaVersion(this.#currentSchemaVersion);
    for (const version of [envelope.schemaVersion, envelope.payload.schemaVersion]) {
      const candidate = parseSchemaVersion(version);
      if (candidate.major !== current.major || candidate.minor > current.minor)
        throw new ProjectLibraryReadOnlyError(version);
    }
  }

  async #assertLocalPath(path: string): Promise<void> {
    if ((await this.#pathPolicy(path)) !== "local")
      throw new Error("Active Project Library must be on a local disk");
  }

  #objectPath(hash: string): string {
    const match = HASH_PATTERN.exec(hash);
    if (match?.[1] === undefined) throw new Error("Invalid content hash");
    return join(this.#activeRoot, "objects", "sha256", `${match[1]}.json`);
  }

  #projectDirectory(projectId: string, location: "active" | "trashed"): string {
    if (!/^[a-z][a-z0-9]*_[a-z0-9][a-z0-9_-]*$/.test(projectId))
      throw new Error("Invalid Project ID");
    return join(this.#activeRoot, location === "active" ? "projects" : "trash", projectId);
  }

  #recordsWithCurrentLocators(records: ProjectOwnedRecords): ProjectOwnedRecords {
    return materializeCurrentLocators(records, this.#locatorCatalog);
  }

  async #refreshLocatorCatalog(
    entries: ReadonlyMap<string, LibraryEntry>,
  ): Promise<LocatorCatalog> {
    const paths = [
      join(this.#activeRoot, SOURCE_CATALOG_FILE),
      join(this.#activeRoot, SOURCE_CATALOG_BACKUP_FILE),
    ];
    const candidates: Array<{ catalog: SourceCatalog; locators: LocatorCatalog; path: string }> =
      [];
    const invalidPaths: string[] = [];
    for (const path of paths) {
      if (!(await pathExists(path))) continue;
      let catalog: SourceCatalog;
      try {
        catalog = await parseJsonFile(path, SourceCatalogSchema);
      } catch (error) {
        if (!(error instanceof ProjectStorageCorruptionError)) throw error;
        invalidPaths.push(path);
        continue;
      }
      try {
        candidates.push({
          catalog,
          locators: mergeCatalogWithEntries(catalog.locatorsBySourceId, entries),
          path,
        });
      } catch {
        invalidPaths.push(path);
      }
    }
    candidates.sort(
      (left, right) =>
        right.catalog.revision - left.catalog.revision ||
        paths.indexOf(left.path) - paths.indexOf(right.path),
    );
    if (
      candidates[0] !== undefined &&
      candidates[1] !== undefined &&
      candidates[0].catalog.revision === candidates[1].catalog.revision &&
      canonicalSerialize(candidates[0].catalog.locatorsBySourceId) !==
        canonicalSerialize(candidates[1].catalog.locatorsBySourceId)
    )
      throw new ProjectStorageCorruptionError(
        "Source catalog copies disagree at the same revision",
      );
    const selected = candidates[0];
    if (selected === undefined && invalidPaths.length > 0)
      throw new ProjectStorageCorruptionError(
        "Source catalog and its last-known-good backup are both invalid",
      );

    const locators = selected?.locators ?? mergeCatalogWithEntries({}, entries);
    if (selected === undefined && locators.size === 0) return locators;
    const locatorsBySourceId = Object.fromEntries(locators);
    const unchanged =
      selected !== undefined &&
      canonicalSerialize(selected.catalog.locatorsBySourceId) ===
        canonicalSerialize(locatorsBySourceId);
    const catalog = SourceCatalogSchema.parse({
      format: "open-chords/source-catalog",
      locatorsBySourceId,
      revision: unchanged ? selected.catalog.revision : (selected?.catalog.revision ?? 0) + 1,
      schemaVersion: "1.0",
    });

    if (invalidPaths.length > 0)
      await this.#quarantineInvalidCatalogs(invalidPaths, selected?.path);
    const content = canonicalSerialize(catalog);
    const copiesAreCurrent =
      invalidPaths.length === 0 &&
      candidates.length === paths.length &&
      candidates.every(({ catalog: candidate }) => canonicalSerialize(candidate) === content);
    if (!copiesAreCurrent) {
      await atomicWriteFile(paths[1]!, content);
      await atomicWriteFile(paths[0]!, content);
      await this.#faultInjector("after_catalog_durable");
    }
    return locators;
  }

  async #quarantineInvalidCatalogs(
    paths: readonly string[],
    recoveredFrom?: string,
  ): Promise<void> {
    const quarantineDirectory = join(this.#activeRoot, "quarantine");
    const quarantineMoves = paths.map((path) => ({
      path,
      target: join(quarantineDirectory, `source-catalog-${basename(path)}-${randomUUID()}.json`),
    }));
    const reportsDirectory = join(this.#activeRoot, "reports");
    await assertManagedDirectory(this.#activeRoot, reportsDirectory);
    await atomicWriteFile(
      join(reportsDirectory, `source-catalog-recovery-${randomUUID()}.json`),
      canonicalSerialize({
        format: "open-chords/source-catalog-recovery",
        quarantineTargets: quarantineMoves.map(({ target }) => basename(target)),
        recoveredFrom: recoveredFrom === undefined ? null : basename(recoveredFrom),
        recoveredAt: this.#now().toISOString(),
        schemaVersion: "1.0",
      }),
    );
    await this.#faultInjector("after_catalog_recovery_report");
    for (const { path, target } of quarantineMoves) await rename(path, target);
    await syncDirectory(quarantineDirectory);
    await syncDirectory(this.#activeRoot);
  }

  async #runReconciledLifecycleMutation<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof ProjectLifecycleDurabilityError) {
        try {
          await this.#refreshEntries();
        } catch (recoveryError) {
          this.#mutationBlockedError = new Error(
            "Project Library must be reopened after an unreconciled lifecycle failure",
            { cause: recoveryError },
          );
          throw new Error("Project lifecycle mutation failed and reconciliation also failed", {
            cause: recoveryError,
          });
        }
        this.#mutationBlockedError = new Error(
          "Project Library must be reopened after an uncertain lifecycle durability failure",
          { cause: error },
        );
        throw error;
      }
      try {
        await this.#refreshEntries();
        await this.#collectUnreferencedObjects();
      } catch (recoveryError) {
        this.#mutationBlockedError = new Error(
          "Project Library must be reopened after an unreconciled lifecycle failure",
          { cause: recoveryError },
        );
        throw new Error("Project lifecycle mutation failed and reconciliation also failed", {
          cause: recoveryError,
        });
      }
      throw error;
    }
  }

  async #serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
    const prior = this.#mutationTail;
    let release!: () => void;
    this.#mutationTail = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    await prior.catch(() => undefined);
    try {
      if (this.#mutationBlockedError !== undefined) throw this.#mutationBlockedError;
      return await operation();
    } finally {
      release();
    }
  }
}

function migrateStoredPayloadV1AnalysisProvenance(input: unknown): unknown {
  const legacy = z
    .object({
      envelope: z
        .object({
          payload: z
            .object({ analysisRevisions: z.array(z.object({ id: StableIdSchema }).loose()) })
            .loose(),
        })
        .loose(),
      format: z.literal("open-chords/project-library-payload"),
      records: z.object({}).loose(),
      schemaVersion: z.literal("1.0"),
    })
    .loose()
    .safeParse(input);
  if (!legacy.success) return input;
  const hasManifests = Object.hasOwn(legacy.data.records, "analysisManifests");
  const hasLegacyIds = Object.hasOwn(legacy.data.records, "legacyManifestlessAnalysisRevisionIds");
  if (hasManifests || hasLegacyIds) return input;
  return {
    ...legacy.data,
    records: {
      ...legacy.data.records,
      analysisManifests: [],
      legacyManifestlessAnalysisRevisionIds: legacy.data.envelope.payload.analysisRevisions.map(
        ({ id }) => id,
      ),
    },
  };
}

function validateStoredPayload(input: unknown): StoredProjectPayload {
  const payload = StoredProjectPayloadSchema.parse(input);
  const supportedMajor = parseSchemaVersion(CONTRACT_VERSION).major;
  const envelopeMajor = parseSchemaVersion(payload.envelope.schemaVersion).major;
  const projectMajor = parseSchemaVersion(payload.envelope.payload.schemaVersion).major;
  if (envelopeMajor !== supportedMajor)
    throw new ProjectLibraryIncompatibleSchemaError(payload.envelope.schemaVersion);
  if (projectMajor !== supportedMajor)
    throw new ProjectLibraryIncompatibleSchemaError(payload.envelope.payload.schemaVersion);
  parseContractEnvelope(payload.envelope);
  const manifestsByRevision = new Map(
    payload.records.analysisManifests.map((record) => [record.analysisRevisionId, record]),
  );
  const legacyManifestless = new Set(payload.records.legacyManifestlessAnalysisRevisionIds);
  for (const revision of payload.envelope.payload.analysisRevisions) {
    const record = manifestsByRevision.get(revision.id);
    if ((record === undefined) === !legacyManifestless.has(revision.id)) {
      throw new Error("Analysis Revision must have exactly one Manifest or explicit legacy state");
    }
    if (record !== undefined && revision.manifestHash !== record.hash) {
      throw new Error("Analysis Manifest record does not match its Analysis Revision");
    }
    if (record !== undefined) {
      validateAnalysisManifestProvenance({
        digest: hashContent,
        manifest: record.manifest,
        revision,
      });
      if (!analysisManifestSourceIsVerified(payload.records, record.manifest)) {
        throw new Error("Analysis Manifest Source identity is not retained by Project authority");
      }
    }
  }
  for (const revisionId of [...manifestsByRevision.keys(), ...legacyManifestless]) {
    if (!payload.envelope.payload.analysisRevisions.some(({ id }) => id === revisionId)) {
      throw new Error("Analysis Manifest provenance references an unknown Analysis Revision");
    }
  }
  const { projectRange } = payload.records;
  if (
    projectRange.endSourceSample - projectRange.startSourceSample !==
    payload.envelope.payload.durationSamples
  ) {
    throw new Error("Project Range length must equal Project durationSamples");
  }
  const source = payload.records.sources.find(({ id }) => id === projectRange.sourceId);
  if (
    source === undefined ||
    !source.snapshots.some(({ durationSamples }) => durationSamples >= projectRange.endSourceSample)
  ) {
    throw new Error("Project Range must fit a retained Source Snapshot");
  }
  return payload;
}

function inspectStoredPayloadCompatibility(input: unknown): { futureMinor: boolean } {
  const versions = z
    .object({
      envelope: z.object({
        payload: z.object({ schemaVersion: z.string() }),
        schemaVersion: z.string(),
      }),
    })
    .parse(input).envelope;
  const supported = parseSchemaVersion(CONTRACT_VERSION);
  for (const version of [versions.schemaVersion, versions.payload.schemaVersion]) {
    if (parseSchemaVersion(version).major !== supported.major)
      throw new ProjectLibraryIncompatibleSchemaError(version);
  }
  return {
    futureMinor: [versions.schemaVersion, versions.payload.schemaVersion].some(
      (version) => compareSchemaVersions(version, CONTRACT_VERSION) > 0,
    ),
  };
}

function buildStoredPayload(input: {
  envelope: unknown;
  records: ProjectOwnedRecords;
}): StoredProjectPayload {
  return validateStoredPayload({
    envelope: input.envelope,
    format: "open-chords/project-library-payload",
    records: input.records,
    schemaVersion: "1.0",
  });
}

function analysisManifestSourceIsVerified(
  records: ProjectOwnedRecords,
  manifest: AnalysisManifest,
): boolean {
  const identity = manifest.candidateIdentity;
  const source = records.sources.find(({ id }) => id === records.projectRange.sourceId);
  const snapshot = source?.snapshots.find((candidate) =>
    identity.sourceIdentityKind === "source_snapshot"
      ? candidate.id === identity.sourceSnapshotId
      : candidate.canonicalAudioFingerprint === identity.canonicalAudioFingerprint,
  );
  return snapshot?.canonicalAudioFingerprint === identity.canonicalAudioFingerprint;
}

function validateLibrarySourceAuthority(entries: ReadonlyMap<string, LibraryEntry>): void {
  const accumulated = new Map<string, LibraryEntry>();
  for (const [projectId, entry] of entries) {
    if (entry.revision !== undefined)
      assertSourceAuthorityAgainstEntries(entry.revision.payload.records, accumulated);
    accumulated.set(projectId, entry);
  }
}

function assertSourceAuthorityAgainstEntries(
  records: ProjectOwnedRecords,
  entries: ReadonlyMap<string, LibraryEntry>,
): void {
  const sourceIdToIdentity = new Map<string, string>();
  const identityToSourceId = new Map<string, string>();
  const snapshotById = new Map<string, string>();
  const observationById = new Map<string, string>();
  for (const entry of entries.values()) {
    if (entry.revision === undefined) continue;
    for (const source of entry.revision.payload.records.sources) {
      const identity = sourceIdentityKey(source.identity);
      sourceIdToIdentity.set(source.id, identity);
      identityToSourceId.set(identity, source.id);
      for (const snapshot of source.snapshots)
        snapshotById.set(snapshot.id, canonicalSerialize(snapshot));
      for (const observation of source.metadataObservations)
        observationById.set(observation.id, canonicalSerialize(observation));
    }
  }
  for (const source of records.sources) {
    const identity = sourceIdentityKey(source.identity);
    const establishedIdentity = sourceIdToIdentity.get(source.id);
    if (establishedIdentity !== undefined && establishedIdentity !== identity)
      throw new Error(`Source ${source.id} conflicts with Library Source identity`);
    const establishedId = identityToSourceId.get(identity);
    if (establishedId !== undefined && establishedId !== source.id)
      throw new Error(`Source identity is already owned by ${establishedId}`);
    for (const snapshot of source.snapshots) {
      const content = canonicalSerialize(snapshot);
      const established = snapshotById.get(snapshot.id);
      if (established !== undefined && established !== content)
        throw new Error(`Source Snapshot ${snapshot.id} conflicts with its immutable record`);
      snapshotById.set(snapshot.id, content);
    }
    for (const observation of source.metadataObservations) {
      const content = canonicalSerialize(observation);
      const established = observationById.get(observation.id);
      if (established !== undefined && established !== content)
        throw new Error(
          `Source Metadata Observation ${observation.id} conflicts with its immutable record`,
        );
      observationById.set(observation.id, content);
    }
    sourceIdToIdentity.set(source.id, identity);
    identityToSourceId.set(identity, source.id);
  }
}

function sourceIdentityKey(identity: ProjectOwnedRecords["sources"][number]["identity"]): string {
  return identity.kind === "local_file"
    ? `local_file:${identity.fingerprint}`
    : `youtube:${identity.videoId}`;
}

function locatorObservationTime(
  locator: ProjectOwnedRecords["sources"][number]["locators"][number],
): number {
  return Date.parse(locator.kind === "local_file" ? locator.verifiedAt : locator.observedAt);
}

function materializeCurrentLocators(
  records: ProjectOwnedRecords,
  catalog: ReadonlyMap<string, LocatorRecords>,
): ProjectOwnedRecords {
  const materialized = structuredClone(records);
  for (const source of materialized.sources) {
    const locators = catalog.get(source.id);
    if (locators !== undefined) source.locators = structuredClone(locators);
  }
  return ProjectOwnedRecordsSchema.parse(materialized);
}

function mergeCatalogWithEntries(
  stored: Readonly<Record<string, LocatorRecords>>,
  entries: ReadonlyMap<string, LibraryEntry>,
): LocatorCatalog {
  type Locator = LocatorRecords[number];
  const bySource = new Map<string, Map<string, Locator>>();
  for (const [sourceId, locators] of Object.entries(stored)) {
    const byId = new Map<string, Locator>();
    mergeLocatorRecords(byId, locators);
    bySource.set(sourceId, byId);
  }
  const referenced = new Set<string>();
  for (const entry of entries.values()) {
    if (entry.revision === undefined) continue;
    for (const source of entry.revision.payload.records.sources) {
      referenced.add(source.id);
      const locators = bySource.get(source.id) ?? new Map<string, Locator>();
      mergeLocatorRecords(locators, source.locators);
      bySource.set(source.id, locators);
    }
  }
  const hasOpaqueDamagedProject = [...entries.values()].some(
    (entry) => entry.status === "damaged" && entry.revision === undefined,
  );
  if (!hasOpaqueDamagedProject)
    for (const sourceId of bySource.keys())
      if (!referenced.has(sourceId)) bySource.delete(sourceId);
  const catalog = new Map(
    [...bySource].map(([sourceId, locators]) => [
      sourceId,
      [...locators.values()].toSorted((left, right) => left.id.localeCompare(right.id)),
    ]),
  );
  for (const entry of entries.values()) {
    if (entry.revision !== undefined)
      materializeCurrentLocators(entry.revision.payload.records, catalog);
  }
  return catalog;
}

function mergeLocatorRecords(
  current: Map<string, ProjectOwnedRecords["sources"][number]["locators"][number]>,
  candidates: ProjectOwnedRecords["sources"][number]["locators"],
): void {
  for (const locator of candidates) {
    const existing = current.get(locator.id);
    if (existing === undefined) {
      current.set(locator.id, structuredClone(locator));
      continue;
    }
    const comparison = locatorObservationTime(locator) - locatorObservationTime(existing);
    if (comparison === 0 && canonicalSerialize(locator) !== canonicalSerialize(existing))
      throw new Error(`Source Locator ${locator.id} has conflicting equal-time observations`);
    if (comparison > 0) current.set(locator.id, structuredClone(locator));
  }
}

function assertLocatorUpdates(
  records: ProjectOwnedRecords,
  catalog: ReadonlyMap<string, ProjectOwnedRecords["sources"][number]["locators"]>,
): void {
  for (const source of records.sources) {
    const current = new Map((catalog.get(source.id) ?? []).map((locator) => [locator.id, locator]));
    mergeLocatorRecords(current, source.locators);
  }
}

async function readLibraryLocation(path: string, fallback: string): Promise<string> {
  if (!(await pathExists(path))) return resolve(fallback);
  const location = await parseJsonFile(path, LibraryLocationSchema);
  if (!isAbsolute(location.activeRoot)) throw new Error("Project Library location is not absolute");
  return resolve(location.activeRoot);
}

async function readRelocationJournal(
  stateRoot: string,
): Promise<z.infer<typeof RelocationJournalSchema> | undefined> {
  const path = join(stateRoot, RELOCATION_JOURNAL_FILE);
  if (!(await pathExists(path))) return undefined;
  const journal = await parseJsonFile(path, RelocationJournalSchema);
  if (
    ![
      journal.previousRoot,
      journal.stagingCleanupTarget,
      journal.stagingTarget,
      journal.target,
      journal.targetCleanupTarget,
    ].every(isAbsolute) ||
    !isAbsolute(journal.targetParent) ||
    dirname(journal.stagingTarget) !== journal.targetParent ||
    dirname(journal.stagingCleanupTarget) !== journal.targetParent ||
    dirname(journal.target) !== journal.targetParent ||
    dirname(journal.targetCleanupTarget) !== journal.targetParent ||
    !basename(journal.stagingTarget).startsWith(".open-chords-library-relocation-") ||
    !basename(journal.stagingCleanupTarget).startsWith(
      ".open-chords-library-relocation-cleanup-",
    ) ||
    !basename(journal.targetCleanupTarget).startsWith(".open-chords-library-target-cleanup-") ||
    new Set([
      journal.stagingCleanupTarget,
      journal.stagingTarget,
      journal.target,
      journal.targetCleanupTarget,
    ]).size !== 4
  )
    throw new Error("Project Library relocation journal contains unsafe paths");
  return journal;
}

async function readDirectoryIdentity(
  path: string,
): Promise<z.infer<typeof DirectoryIdentitySchema>> {
  const metadata = await lstat(path, { bigint: true });
  if (metadata.isSymbolicLink() || !metadata.isDirectory())
    throw new Error("Project Library relocation parent must be a real directory");
  return DirectoryIdentitySchema.parse({
    device: metadata.dev.toString(),
    inode: metadata.ino.toString(),
  });
}

async function assertRelocationParent(
  journal: z.infer<typeof RelocationJournalSchema>,
): Promise<void> {
  const actual = await readDirectoryIdentity(journal.targetParent);
  if (
    actual.device !== journal.targetParentIdentity.device ||
    actual.inode !== journal.targetParentIdentity.inode ||
    (await realpath(journal.targetParent)) !== journal.targetParent
  )
    throw new Error("Project Library relocation target parent changed during operation");
}

async function assertRealDirectory(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory() || (await realpath(path)) !== path)
    throw new Error("Project Library relocation path is not a real canonical directory");
}

async function validateRelocationOwnedDirectory(
  path: string,
  relocationId: string,
  allowEmptyWithoutMarker: boolean,
): Promise<void> {
  await assertRealDirectory(path);
  const markerPath = join(path, RELOCATION_MARKER_FILE);
  if (!(await pathEntryExists(markerPath))) {
    if (allowEmptyWithoutMarker && (await readdir(path)).length === 0) return;
    throw new Error("Project Library relocation staging marker is missing");
  }
  const marker = await parseJsonFile(markerPath, RelocationMarkerSchema);
  if (marker.id !== relocationId)
    throw new Error("Project Library relocation ownership is ambiguous");
}

async function inspectRelocationJournal(stateRoot: string): Promise<void> {
  await readRelocationJournal(stateRoot);
}

async function readLatestRecoveryReport(
  activeRoot: string,
  projectDirectory: string,
): Promise<ProjectRecoveryReport | undefined> {
  const reportsDirectory = join(projectDirectory, "reports");
  if (!(await pathExists(reportsDirectory))) return undefined;
  await assertManagedDirectory(activeRoot, reportsDirectory);
  const reports = (await readdir(reportsDirectory))
    .filter((file) => file.endsWith(".json"))
    .toSorted();
  const latest = reports.at(-1);
  if (latest === undefined) return undefined;
  try {
    return await parseJsonFile(join(reportsDirectory, latest), RecoveryReportSchema);
  } catch (error) {
    if (error instanceof ProjectStorageCorruptionError) return undefined;
    throw error;
  }
}

async function parseJsonFile<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  let content: string;
  try {
    content = await readRegularStorageFile(path);
  } catch (error) {
    if (isMissingPathError(error))
      throw new ProjectStorageCorruptionError(
        `Required storage file is missing: ${basename(path)}`,
        error,
      );
    throw error;
  }
  try {
    return schema.parse(JSON.parse(content));
  } catch (error) {
    throw new ProjectStorageCorruptionError(`Storage file is invalid: ${basename(path)}`, error);
  }
}

async function readRegularStorageFile(path: string): Promise<string> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isFile())
    throw new ProjectStorageCorruptionError(
      `Storage path must be a regular file: ${basename(path)}`,
    );
  return readFile(path, "utf8");
}

function hashContent(content: string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

async function writeDurableFile(
  path: string,
  content: string,
  flag: "w" | "wx" = "w",
): Promise<void> {
  const handle = await open(path, flag, 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function ensureDurableDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await syncDirectory(path);
  const parent = dirname(path);
  if (parent !== path) await syncDirectory(parent);
}

async function ensureManagedDirectory(activeRoot: string, path: string): Promise<void> {
  try {
    await mkdir(path);
  } catch (error) {
    if (!(isNodeError(error) && error.code === "EEXIST")) throw error;
  }
  await assertManagedDirectory(activeRoot, path);
  await syncDirectory(path);
  const parent = dirname(path);
  if (parent !== path) await syncDirectory(parent);
}

async function assertManagedDirectory(activeRoot: string, path: string): Promise<void> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory())
    throw new Error(`Managed Project Library path must be a real directory: ${basename(path)}`);
  const canonicalRoot = await realpath(activeRoot);
  const canonicalPath = await realpath(path);
  if (canonicalPath !== canonicalRoot && !isNestedPath(canonicalRoot, canonicalPath))
    throw new Error("Managed Project Library directory escapes the active root");
}

async function atomicWriteFile(
  path: string,
  content: string,
  afterReplace: () => void | Promise<void> = () => undefined,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    await writeDurableFile(temporaryPath, content, "wx");
    await rename(temporaryPath, path);
    await afterReplace();
    await syncFile(path);
    await syncDirectory(dirname(path));
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function syncFile(path: string): Promise<void> {
  const handle = await open(path, process.platform === "win32" ? "r+" : "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  try {
    const handle = await open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (
      process.platform === "win32" &&
      isNodeError(error) &&
      error.code !== undefined &&
      ["EISDIR", "EINVAL", "ENOTSUP", "EPERM"].includes(error.code)
    ) {
      return;
    }
    throw error;
  }
}

async function scavengeDirectory(activeRoot: string, path: string): Promise<void> {
  await assertManagedDirectory(activeRoot, path);
  for (const entry of await readdir(path))
    await rm(join(path, entry), { force: true, recursive: true });
  await syncDirectory(path);
}

async function syncTree(path: string): Promise<void> {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const entryPath = join(path, entry.name);
    if (entry.isDirectory()) await syncTree(entryPath);
    else if (entry.isFile()) await syncFile(entryPath);
    else throw new Error("Project Library contains an unsupported filesystem entry");
  }
  await syncDirectory(path);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
}

async function pathEntryExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
}

async function classifyLibraryPath(path: string): Promise<"local" | "unsupported"> {
  const normalized = resolve(path);
  if (hasCloudPathSegment(normalized)) return "unsupported";
  if (process.platform === "win32" && /^\\\\/.test(path)) return "unsupported";

  const canonicalCandidate = await canonicalizeLibraryPath(normalized);
  if (hasCloudPathSegment(canonicalCandidate)) return "unsupported";
  return (await isPlatformLocalVolume(canonicalCandidate)) ? "local" : "unsupported";
}

async function canonicalizeLibraryPath(path: string): Promise<string> {
  const normalized = resolve(path);
  let probe = normalized;
  while (!(await pathExists(probe))) {
    const parent = dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  const stats = await stat(probe);
  if (!stats.isDirectory()) probe = dirname(probe);
  const canonicalProbe = await realpath(probe);
  return resolve(canonicalProbe, relative(probe, normalized));
}

function hasCloudPathSegment(path: string): boolean {
  const cloudSegments = [
    "cloudstorage",
    "dropbox",
    "google drive",
    "icloud drive",
    "mobile documents",
    "onedrive",
  ];
  return path
    .split(sep)
    .map((segment) => segment.toLowerCase())
    .some((segment) => cloudSegments.some((cloud) => segment.includes(cloud)));
}

async function isPlatformLocalVolume(path: string): Promise<boolean> {
  if (process.platform === "darwin") {
    const { stdout } = await execFileAsync("/sbin/mount", [], { encoding: "utf8" });
    const mounts = stdout
      .split("\n")
      .flatMap((line) => {
        const match = /^.+ on (.+) \(([^)]+)\)$/.exec(line);
        return match?.[1] === undefined || match[2] === undefined
          ? []
          : [{ mountPoint: match[1], options: match[2].split(", ") }];
      })
      .filter(({ mountPoint }) => isAtOrBelow(path, mountPoint))
      .toSorted((left, right) => right.mountPoint.length - left.mountPoint.length);
    return mounts[0]?.options.includes("local") === true;
  }
  if (process.platform === "win32") {
    const root = parse(path).root.replace(/[\\/]$/, "");
    if (!/^[A-Za-z]:$/.test(root)) return false;
    const escapedRoot = root.replace("'", "''");
    const { stdout } = await execFileAsync(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$drive = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='${escapedRoot}'"; if ($null -eq $drive) { exit 2 }; [Console]::Out.Write($drive.DriveType)`,
      ],
      {
        encoding: "utf8",
      },
    );
    const driveType = Number.parseInt(stdout.trim(), 10);
    if (!Number.isInteger(driveType))
      throw new Error("Windows volume classifier returned an invalid drive type");
    return driveType === 2 || driveType === 3;
  }
  if (process.platform === "linux") {
    const mountInfo = await readFile("/proc/self/mountinfo", "utf8");
    const mounts = mountInfo
      .split("\n")
      .flatMap((line) => {
        const [beforeSeparator, afterSeparator] = line.split(" - ");
        const fields = beforeSeparator?.split(" ");
        const filesystem = afterSeparator?.split(" ")[0];
        return fields?.[4] === undefined || filesystem === undefined
          ? []
          : [{ filesystem, mountPoint: decodeMountInfoPath(fields[4]) }];
      })
      .filter(({ mountPoint }) => isAtOrBelow(path, mountPoint))
      .toSorted((left, right) => right.mountPoint.length - left.mountPoint.length);
    const localFilesystems = new Set([
      "apfs",
      "btrfs",
      "ext2",
      "ext3",
      "ext4",
      "overlay",
      "xfs",
      "zfs",
    ]);
    return mounts[0] !== undefined && localFilesystems.has(mounts[0].filesystem);
  }
  return false;
}

function decodeMountInfoPath(path: string): string {
  return path.replaceAll(/\\([0-7]{3})/g, (_, octal: string) =>
    String.fromCodePoint(Number.parseInt(octal, 8)),
  );
}

function isAtOrBelow(path: string, parent: string): boolean {
  return path === parent || path.startsWith(parent === sep ? sep : `${parent}${sep}`);
}

function parseSchemaVersion(version: string): { major: number; minor: number } {
  const match = /^(\d+)\.(\d+)$/.exec(version);
  if (match?.[1] === undefined || match[2] === undefined) throw new Error("Invalid schema version");
  return { major: Number(match[1]), minor: Number(match[2]) };
}

function compareSchemaVersions(left: string, right: string): number {
  const leftVersion = parseSchemaVersion(left);
  const rightVersion = parseSchemaVersion(right);
  if (leftVersion.major !== rightVersion.major) return leftVersion.major - rightVersion.major;
  return leftVersion.minor - rightVersion.minor;
}

function isOlderCompatibleSchema(
  envelope: z.infer<typeof ProjectEnvelopeSchema>,
  currentVersion: string,
): boolean {
  const current = parseSchemaVersion(currentVersion);
  const versions = [envelope.schemaVersion, envelope.payload.schemaVersion];
  return (
    versions.every((version) => {
      const candidate = parseSchemaVersion(version);
      return candidate.major === current.major && candidate.minor <= current.minor;
    }) &&
    versions.some((version) => {
      const candidate = parseSchemaVersion(version);
      return candidate.minor < current.minor;
    })
  );
}

function oldestEnvelopeSchemaVersion(envelope: z.infer<typeof ProjectEnvelopeSchema>): string {
  return compareSchemaVersions(envelope.schemaVersion, envelope.payload.schemaVersion) <= 0
    ? envelope.schemaVersion
    : envelope.payload.schemaVersion;
}

function validateMigrationGraph(migrations: readonly ProjectMigration[]): void {
  const fromVersions = new Set<string>();
  for (const migration of migrations) {
    parseSchemaVersion(migration.fromVersion);
    parseSchemaVersion(migration.toVersion);
    if (fromVersions.has(migration.fromVersion))
      throw new Error(`Duplicate Project migration from ${migration.fromVersion}`);
    if (compareSchemaVersions(migration.toVersion, migration.fromVersion) <= 0)
      throw new Error("Project migrations must advance to a newer schema version");
    fromVersions.add(migration.fromVersion);
  }
}

function isMissingPathError(error: unknown): boolean {
  return (
    isNodeError(error) &&
    error.code !== undefined &&
    ["EISDIR", "ENOENT", "ENOTDIR"].includes(error.code)
  );
}

function isNestedPath(parent: string, candidate: string): boolean {
  const difference = relative(parent, candidate);
  return (
    difference !== "" &&
    !difference.startsWith(`..${sep}`) &&
    difference !== ".." &&
    !isAbsolute(difference)
  );
}

function safeFileName(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9_-]/g, "_");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  ANALYSIS_CAPABILITY_STAGES as CAPABILITY_STAGES,
  ANALYSIS_MAIN_STAGES as MAIN_STAGES,
  ANALYSIS_RUNNER_PREFIX_STAGES as RUNNER_PREFIX_STAGES,
  ANALYSIS_RUNNER_SUFFIX_STAGES as RUNNER_SUFFIX_STAGES,
  AnalysisPipelineStageSchema as PipelineStageSchema,
  AnalysisRecipeSchema,
  AnalysisStageOutcomeSchema,
  canonicalAnalysisRecipeContent,
  canonicalSerialize,
  validateAnalysisManifestProvenance,
  type AnalysisManifest,
  type AnalysisRecipe,
  type AnalysisRevision,
  type ProjectContract,
} from "@open-chords/domain";
import { z } from "zod";

const STATE_FILE = "analysis-jobs/state.json";
const OPERATIONAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const Sha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const TimestampSchema = z.iso.datetime({ offset: true });
const BlockedDependencySchema = z.strictObject({
  id: z.string().min(1),
  kind: z.enum(["consent", "dictionary", "license", "media", "model"]),
});
const AnalysisProgressSchema = z.strictObject({
  completedFraction: z.number().min(0).max(1),
  elapsedMs: z.number().int().nonnegative(),
  estimateKind: z.literal("benchmark_approximate"),
  profile: z.enum(["eco", "balanced", "fast"]),
  stage: PipelineStageSchema,
});
const AnalysisProjectRangeSchema = z
  .strictObject({
    endSourceSample: z.number().int().positive(),
    sourceId: z.string().min(1),
    startSourceSample: z.number().int().nonnegative(),
  })
  .refine(
    ({ endSourceSample, startSourceSample }) => endSourceSample > startSourceSample,
    "Analysis Project Range must be non-empty",
  );

const AnalysisJobSchema = z.strictObject({
  attemptIds: z.array(z.string().min(1)),
  blockedDependencies: z.array(BlockedDependencySchema),
  canonicalAudioFingerprint: Sha256Schema,
  createdAt: TimestampSchema,
  id: z.string().min(1),
  key: Sha256Schema,
  profile: z.enum(["eco", "balanced", "fast"]),
  progress: AnalysisProgressSchema.optional(),
  projectId: z.string().min(1),
  projectRange: AnalysisProjectRangeSchema,
  publishedAnalysisRevisionId: z.string().min(1).optional(),
  queuePosition: z.number().int().nonnegative(),
  recipe: AnalysisRecipeSchema,
  recipeHash: Sha256Schema,
  sourceIdentityKind: z.enum(["canonical_audio", "source_snapshot"]),
  sourceSnapshotId: z.string().min(1),
  state: z.enum([
    "awaiting_confirmation",
    "blocked",
    "cancelled",
    "cancelling",
    "queued",
    "retryable",
    "running",
    "succeeded",
  ]),
  updatedAt: TimestampSchema,
});
const RunnerStageOutcomeSchema = z.strictObject({
  stage: z.enum([...RUNNER_PREFIX_STAGES, ...CAPABILITY_STAGES, ...RUNNER_SUFFIX_STAGES]),
  state: z.enum(["completed", "completed_with_abstentions"]),
});
const AnalysisFailureSchema = z.strictObject({
  classification: z.enum([
    "blocked_input",
    "blocked_dependency",
    "unsupported_input",
    "resource_limit",
    "deadline",
    "component_failure",
    "invalid_output",
    "interrupted",
    "cancelled",
    "containment_violation",
    "protocol_violation",
    "integrity_violation",
    "internal_error",
    "stale_result",
  ]),
  message: z.string().min(1).max(2048),
  nextAction: z.enum(["check_input", "repair_installation", "restart_application", "retry"]),
  retryable: z.boolean(),
  stage: AnalysisStageOutcomeSchema.shape.stage,
});
const CheckpointDocumentSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    format: z.literal("open-chords/analysis-checkpoint"),
    frames: z
      .array(
        z.strictObject({
          atSample: z.number().int().nonnegative(),
          chroma: z.array(z.number().finite().min(0).max(1)).length(12),
          onsetStrength: z.number().finite().min(0).max(1),
        }),
      )
      .min(1)
      .max(4096),
    kind: z.literal("shared_features"),
  }),
  z.strictObject({
    beats: z
      .array(
        z.strictObject({
          atSample: z.number().int().nonnegative(),
          confidence: z.number().finite().min(0).max(1),
          role: z.enum(["beat", "downbeat"]),
        }),
      )
      .min(1)
      .max(20_000),
    format: z.literal("open-chords/analysis-checkpoint"),
    kind: z.literal("rhythm"),
  }),
  z.strictObject({
    format: z.literal("open-chords/analysis-checkpoint"),
    kind: z.literal("harmony"),
    regions: z
      .array(
        z.strictObject({
          candidate: z.string().regex(/^[A-G](?:#|b)?(?::[a-z0-9()+#-]+)?$/u),
          confidence: z.number().finite().min(0).max(1),
          endSample: z.number().int().positive(),
          startSample: z.number().int().nonnegative(),
        }),
      )
      .min(1)
      .max(20_000),
  }),
  z.strictObject({
    boundaries: z
      .array(
        z.strictObject({
          atSample: z.number().int().nonnegative(),
          confidence: z.number().finite().min(0).max(1),
        }),
      )
      .min(1)
      .max(10_000),
    format: z.literal("open-chords/analysis-checkpoint"),
    kind: z.literal("sections"),
  }),
]);
const AnalysisCheckpointCandidateSchema = z.strictObject({
  document: CheckpointDocumentSchema,
  kind: z.enum(["shared_features", "rhythm", "harmony", "sections"]),
  stage: z.enum(["shared_features", ...CAPABILITY_STAGES]),
});

function validateCheckpointDocument(
  document: z.infer<typeof CheckpointDocumentSchema>,
  projectDurationSamples: number,
): void {
  if (!Number.isSafeInteger(projectDurationSamples) || projectDurationSamples <= 0) {
    throw new Error("Analysis Checkpoint requires a positive Project duration");
  }
  if (document.kind === "harmony") {
    for (const [index, region] of document.regions.entries()) {
      const previous = document.regions[index - 1];
      if (
        region.startSample >= region.endSample ||
        region.endSample > projectDurationSamples ||
        (previous !== undefined && region.startSample < previous.endSample)
      ) {
        throw new Error(
          "Harmony Checkpoint regions must be ordered, non-overlapping, and in range",
        );
      }
    }
    return;
  }
  const points =
    document.kind === "shared_features"
      ? document.frames
      : document.kind === "rhythm"
        ? document.beats
        : document.boundaries;
  for (const [index, point] of points.entries()) {
    const previous = points[index - 1];
    if (
      point.atSample >= projectDurationSamples ||
      (previous !== undefined && point.atSample <= previous.atSample)
    ) {
      throw new Error("Analysis Checkpoint samples must be strictly ordered and in Project range");
    }
  }
}

const AnalysisCheckpointSchema = AnalysisCheckpointCandidateSchema.omit({ document: true })
  .extend({
    artifactHash: Sha256Schema,
    byteSize: z
      .number()
      .int()
      .positive()
      .max(1024 * 1024),
    createdAt: TimestampSchema,
    expiresAt: TimestampSchema,
    id: z.string().min(1),
    jobId: z.string().min(1),
    predecessorArtifactHashes: z.array(Sha256Schema).max(1),
    projectRangeHash: Sha256Schema,
    upstreamIdentityHash: Sha256Schema,
  })
  .refine(
    ({ predecessorArtifactHashes, stage }) =>
      predecessorArtifactHashes.length === (stage === "shared_features" ? 0 : 1),
    "Checkpoint predecessor lineage must match its DAG stage",
  );
const AnalysisCircuitBreakerSchema = z.strictObject({
  classification: z.enum(["containment_violation", "integrity_violation", "protocol_violation"]),
  openedAt: TimestampSchema,
});
const AnalysisAttemptSchema = z.strictObject({
  cancelRequestedAt: TimestampSchema.optional(),
  checkpointIds: z.array(z.string().min(1)),
  candidateAnalysisRevisionId: z.string().min(1).optional(),
  candidateManifestHash: Sha256Schema.optional(),
  deadlineAt: TimestampSchema,
  expectedProjectRevisionId: z.string().min(1),
  failure: AnalysisFailureSchema.optional(),
  finishedAt: TimestampSchema.optional(),
  id: z.string().min(1),
  jobId: z.string().min(1),
  publishedProjectRevisionId: z.string().min(1).optional(),
  stageOutcomes: z.array(AnalysisStageOutcomeSchema),
  startedAt: TimestampSchema,
  state: z.enum(["cancelled", "cancelling", "failed", "running", "succeeded"]),
});
const AnalysisJobStateSchema = z.strictObject({
  attempts: z.array(AnalysisAttemptSchema),
  checkpoints: z.array(AnalysisCheckpointSchema),
  circuitBreaker: AnalysisCircuitBreakerSchema.nullable(),
  format: z.literal("open-chords/analysis-jobs"),
  jobs: z.array(AnalysisJobSchema),
  runtimeSessionId: z.string().uuid(),
  schemaVersion: z.literal("1.0"),
});

export type AnalysisJobSnapshot = z.infer<typeof AnalysisJobSchema>;
export type AnalysisAttemptSnapshot = z.infer<typeof AnalysisAttemptSchema>;
export type AnalysisFailure = z.infer<typeof AnalysisFailureSchema>;
export type AnalysisCheckpoint = z.infer<typeof AnalysisCheckpointSchema>;
export type AnalysisCheckpointCandidate = z.infer<typeof AnalysisCheckpointCandidateSchema>;
type ReusableAnalysisCheckpoint = AnalysisCheckpoint & {
  document: z.infer<typeof AnalysisCheckpointCandidateSchema>["document"];
};

export class AnalysisRunError extends Error {
  readonly failure: AnalysisFailure;

  constructor(failure: AnalysisFailure) {
    const parsed = AnalysisFailureSchema.parse(failure);
    super(parsed.message);
    this.name = "AnalysisRunError";
    this.failure = parsed;
  }
}

type AnalysisProjectAuthority = {
  getProjectRange(projectId: string): Promise<{
    endSourceSample: number;
    sourceId: string;
    startSourceSample: number;
  } | null>;
  getSnapshot(projectId: string): Promise<{
    eventSequence: number;
    project: ProjectContract;
    projectRevisionId: string;
  } | null>;
  publishAnalysisRevision(input: {
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
  >;
};

type AnalysisJobRunner = {
  run(input: {
    attemptId: string;
    checkpoints: readonly ReusableAnalysisCheckpoint[];
    job: AnalysisJobSnapshot;
    reportProgress: (progress: {
      completedFraction: number;
      elapsedMs: number;
      stage: z.infer<typeof AnalysisProgressSchema>["stage"];
    }) => Promise<void>;
    saveCheckpoint: (checkpoint: AnalysisCheckpointCandidate) => Promise<void>;
    signal: AbortSignal;
  }): Promise<{
    manifest: AnalysisManifest;
    revision: AnalysisRevision;
  }>;
  terminateAndWait(input: {
    attemptId: string;
    reason: "cancelled" | "deadline" | "interrupted";
  }): Promise<void>;
};

type AnalysisJobsOptions = {
  authority: AnalysisProjectAuthority;
  attemptTimeoutMs?: number;
  dependencies: AnalysisDependencyAuthority;
  idFactory?: () => string;
  now?: () => Date;
  runner: AnalysisJobRunner;
  stateRoot: string;
};

type AnalysisDependencyAuthority = {
  resolveBlockedDependencies(input: {
    canonicalAudioFingerprint: string;
    projectId: string;
    recipe: AnalysisRecipe;
    sourceIdentityKind: "canonical_audio" | "source_snapshot";
    sourceSnapshotId: string;
  }): Promise<z.infer<typeof BlockedDependencySchema>[]>;
};

export class AnalysisJobs {
  #active: { attemptId: string; controller: AbortController; jobId: string } | undefined;
  readonly #authority: AnalysisProjectAuthority;
  readonly #attemptTimeoutMs: number;
  readonly #dependencies: AnalysisDependencyAuthority;
  readonly #idFactory: () => string;
  #mutationTail: Promise<void> = Promise.resolve();
  readonly #now: () => Date;
  readonly #path: string;
  readonly #runner: AnalysisJobRunner;
  #state: z.infer<typeof AnalysisJobStateSchema>;

  private constructor(
    options: AnalysisJobsOptions,
    path: string,
    state: z.infer<typeof AnalysisJobStateSchema>,
  ) {
    this.#authority = options.authority;
    this.#attemptTimeoutMs = options.attemptTimeoutMs ?? 30 * 60 * 1_000;
    if (!Number.isSafeInteger(this.#attemptTimeoutMs) || this.#attemptTimeoutMs <= 0) {
      throw new Error("Analysis Attempt timeout must be a positive integer");
    }
    this.#dependencies = options.dependencies;
    this.#idFactory = options.idFactory ?? (() => `job_${randomUUID().replaceAll("-", "")}`);
    this.#now = options.now ?? (() => new Date());
    this.#path = path;
    this.#runner = options.runner;
    this.#state = state;
  }

  static async open(options: AnalysisJobsOptions): Promise<AnalysisJobs> {
    const path = join(options.stateRoot, STATE_FILE);
    const state = await readState(path);
    await terminatePersistedAttempts(state, options.runner);
    const recovered = await recoverStateAfterRestart(
      state,
      options.authority,
      options.now?.() ?? new Date(),
    );
    recovered.runtimeSessionId = randomUUID();
    const analysisJobs = new AnalysisJobs(options, path, recovered);
    await analysisJobs.#persist();
    await analysisJobs.#removeUnreferencedCheckpointArtifacts();
    return analysisJobs;
  }

  async confirmQueued(jobId: string): Promise<AnalysisJobSnapshot> {
    return this.#serializeMutation(async () => {
      const job = this.#requireJob(jobId);
      if (job.state !== "awaiting_confirmation") {
        throw new Error("Analysis Job is not awaiting restart confirmation");
      }
      job.state = "queued";
      job.updatedAt = this.#now().toISOString();
      await this.#persist();
      return structuredClone(job);
    });
  }

  async interruptForSleep(): Promise<void> {
    const active = this.#active;
    if (active === undefined) return;
    const failure = AnalysisFailureSchema.parse({
      classification: "interrupted",
      message: "Analysis Attempt was interrupted by system sleep",
      nextAction: "retry",
      retryable: true,
      stage: "preflight",
    });
    await this.#serializeMutation(async () => {
      const job = this.#requireJob(active.jobId);
      const attempt = this.#requireAttempt(active.attemptId);
      if (job.state !== "running" || attempt.state !== "running") return;
      const timestamp = this.#now().toISOString();
      attempt.failure = failure;
      attempt.finishedAt = timestamp;
      attempt.state = "failed";
      job.state = "retryable";
      job.updatedAt = timestamp;
      await this.#persist();
    });
    active.controller.abort(new AnalysisRunError(failure));
  }

  async cancel(jobId: string): Promise<AnalysisJobSnapshot> {
    const cancelled = await this.#serializeMutation(async () => {
      const job = this.#requireJob(jobId);
      const timestamp = this.#now().toISOString();
      if (job.state === "queued" || job.state === "awaiting_confirmation") {
        job.state = "cancelled";
      } else if (job.state === "running") {
        const attempt = this.#state.attempts.find(
          ({ id, state }) => job.attemptIds.includes(id) && state === "running",
        );
        if (attempt === undefined) throw new Error("Running Analysis Attempt is missing");
        attempt.cancelRequestedAt = timestamp;
        attempt.state = "cancelling";
        job.state = "cancelling";
      } else {
        throw new Error("Analysis Job cannot be cancelled from its current state");
      }
      job.updatedAt = timestamp;
      await this.#persist();
      return structuredClone(job);
    });
    if (this.#active?.jobId === jobId) {
      this.#active.controller.abort(
        new AnalysisRunError({
          classification: "cancelled",
          message: "Analysis Attempt was cancelled",
          nextAction: "retry",
          retryable: true,
          stage: cancelled.progress?.stage ?? "preflight",
        }),
      );
    }
    return cancelled;
  }

  circuitBreaker(): z.infer<typeof AnalysisCircuitBreakerSchema> | null {
    return structuredClone(this.#state.circuitBreaker);
  }

  list(): AnalysisJobSnapshot[] {
    return structuredClone(
      this.#state.jobs.toSorted(
        (left, right) =>
          left.queuePosition - right.queuePosition || left.id.localeCompare(right.id),
      ),
    );
  }

  async moveBefore(jobId: string, beforeJobId: string): Promise<void> {
    await this.#serializeMutation(async () => {
      const job = this.#requireJob(jobId);
      const before = this.#requireJob(beforeJobId);
      if (job.state !== "queued" || before.state !== "queued") {
        throw new Error("Only queued Analysis Jobs can be reordered");
      }
      const queued = this.#state.jobs
        .filter(({ state }) => state === "queued")
        .toSorted((left, right) => left.queuePosition - right.queuePosition);
      const withoutJob = queued.filter(({ id }) => id !== jobId);
      const insertion = withoutJob.findIndex(({ id }) => id === beforeJobId);
      if (insertion < 0) throw new Error("Queue target was not found");
      withoutJob.splice(insertion, 0, job);
      for (const [position, queuedJob] of withoutJob.entries()) {
        queuedJob.queuePosition = position;
        queuedJob.updatedAt = this.#now().toISOString();
      }
      await this.#persist();
    });
  }

  get(jobId: string): {
    attempts: AnalysisAttemptSnapshot[];
    checkpoints: AnalysisCheckpoint[];
    job: AnalysisJobSnapshot;
  } {
    const job = this.#requireJob(jobId);
    return {
      attempts: structuredClone(this.#state.attempts.filter((attempt) => attempt.jobId === jobId)),
      checkpoints: structuredClone(
        this.#state.checkpoints.filter((checkpoint) => checkpoint.jobId === jobId),
      ),
      job: structuredClone(job),
    };
  }

  async #persist(): Promise<void> {
    await atomicWrite(this.#path, canonicalSerialize(AnalysisJobStateSchema.parse(this.#state)));
  }

  async pruneOperationalEvidence(): Promise<void> {
    await this.#serializeMutation(async () => {
      const cutoff = this.#now().getTime() - OPERATIONAL_RETENTION_MS;
      const retainedAttempts = this.#state.attempts.filter(
        ({ finishedAt }) => finishedAt === undefined || Date.parse(finishedAt) > cutoff,
      );
      const retainedAttemptIds = new Set(retainedAttempts.map(({ id }) => id));
      const retainedCheckpoints = this.#state.checkpoints.filter(
        ({ expiresAt }) => Date.parse(expiresAt) > this.#now().getTime(),
      );
      const retainedCheckpointIds = new Set(retainedCheckpoints.map(({ id }) => id));
      for (const attempt of retainedAttempts) {
        attempt.checkpointIds = attempt.checkpointIds.filter((id) => retainedCheckpointIds.has(id));
      }
      for (const job of this.#state.jobs) {
        job.attemptIds = job.attemptIds.filter((id) => retainedAttemptIds.has(id));
      }
      this.#state.attempts = retainedAttempts;
      this.#state.checkpoints = retainedCheckpoints;
      await this.#persist();
      await this.#removeUnreferencedCheckpointArtifacts();
    });
  }

  async #removeUnreferencedCheckpointArtifacts(): Promise<void> {
    const directory = join(dirname(this.#path), "checkpoints");
    let entries: string[];
    try {
      entries = await readdir(directory);
    } catch (error) {
      if (isMissingPathError(error)) return;
      throw error;
    }
    const referencedFiles = new Set(
      this.#state.checkpoints.map(({ artifactHash }) => `${artifactHash.slice(7)}.json`),
    );
    for (const entry of entries) {
      if (/^[a-f0-9]{64}\.json$/u.test(entry) && !referencedFiles.has(entry)) {
        await rm(join(directory, entry), { force: true });
      }
    }
  }

  async submit(input: {
    canonicalAudioFingerprint: string;
    projectId: string;
    recipe: AnalysisRecipe;
    sourceIdentityKind?: "canonical_audio" | "source_snapshot";
    sourceSnapshotId: string;
  }): Promise<AnalysisJobSnapshot> {
    return this.#serializeMutation(async () => {
      const recipe = AnalysisRecipeSchema.parse(input.recipe);
      const sourceIdentityKind = input.sourceIdentityKind ?? "source_snapshot";
      const recipeHash = hashContent(canonicalAnalysisRecipeContent(recipe));
      const rawProjectRange = await this.#authority.getProjectRange(input.projectId);
      if (rawProjectRange === null) throw new Error(`Project ${input.projectId} was not found`);
      const projectRange = AnalysisProjectRangeSchema.parse(rawProjectRange);
      const existingProjectJob = this.#state.jobs.find(
        ({ projectId }) => projectId === input.projectId,
      );
      if (
        existingProjectJob !== undefined &&
        canonicalSerialize(existingProjectJob.projectRange) !== canonicalSerialize(projectRange)
      ) {
        const failure = projectRangeIntegrityFailure();
        const timestamp = this.#now().toISOString();
        existingProjectJob.state = "blocked";
        existingProjectJob.updatedAt = timestamp;
        this.#state.circuitBreaker = {
          classification: "integrity_violation",
          openedAt: timestamp,
        };
        await this.#persist();
        throw failure;
      }
      const key = hashIdentity({
        projectId: input.projectId,
        projectRange,
        recipeHash,
        sourceIdentity:
          sourceIdentityKind === "source_snapshot"
            ? { id: input.sourceSnapshotId, kind: "source_snapshot" }
            : {
                fingerprint: Sha256Schema.parse(input.canonicalAudioFingerprint),
                kind: "canonical_audio",
              },
      });
      const existing = this.#state.jobs.find((job) => job.key === key);
      if (existing !== undefined) return structuredClone(existing);
      const timestamp = this.#now().toISOString();
      const blockedDependencies = await this.#resolveBlockedDependencies({
        ...input,
        projectRange,
        sourceIdentityKind,
      });
      const job = AnalysisJobSchema.parse({
        attemptIds: [],
        blockedDependencies,
        canonicalAudioFingerprint: input.canonicalAudioFingerprint,
        createdAt: timestamp,
        id: this.#idFactory(),
        key,
        profile: recipe.profile.name,
        projectId: input.projectId,
        projectRange,
        queuePosition: nextQueuePosition(this.#state.jobs),
        recipe,
        recipeHash,
        sourceIdentityKind,
        sourceSnapshotId: input.sourceSnapshotId,
        state: blockedDependencies.length === 0 ? "queued" : "blocked",
        updatedAt: timestamp,
      });
      this.#state.jobs.push(job);
      await this.#persist();
      return structuredClone(job);
    });
  }

  async runNext(): Promise<AnalysisJobSnapshot | null> {
    const started = await this.#serializeMutation(async () => {
      if (this.#active !== undefined) return null;
      if (this.#state.circuitBreaker !== null) return null;
      if (this.#state.jobs.some(({ state }) => state === "running" || state === "cancelling")) {
        return null;
      }
      const job = this.#state.jobs
        .filter(({ state }) => state === "queued")
        .toSorted((left, right) => left.queuePosition - right.queuePosition)[0];
      if (job === undefined) return null;
      let blockedDependencies: z.infer<typeof BlockedDependencySchema>[];
      try {
        blockedDependencies = await this.#resolveBlockedDependencies(job);
      } catch (error) {
        if (error instanceof AnalysisRunError && isCircuitBreakerFailure(error.failure)) {
          const timestamp = this.#now().toISOString();
          job.state = "blocked";
          job.updatedAt = timestamp;
          this.#state.circuitBreaker = {
            classification: error.failure.classification,
            openedAt: timestamp,
          };
          await this.#persist();
        }
        throw error;
      }
      if (blockedDependencies.length > 0) {
        job.blockedDependencies = blockedDependencies;
        job.state = "blocked";
        job.updatedAt = this.#now().toISOString();
        await this.#persist();
        return { blockedJob: structuredClone(job) };
      }
      const project = await this.#authority.getSnapshot(job.projectId);
      if (project === null) throw new Error(`Project ${job.projectId} was not found`);
      const timestamp = this.#now().toISOString();
      const attempt = AnalysisAttemptSchema.parse({
        checkpointIds: [],
        deadlineAt: new Date(this.#now().getTime() + this.#attemptTimeoutMs).toISOString(),
        expectedProjectRevisionId: project.projectRevisionId,
        id: this.#idFactory(),
        jobId: job.id,
        stageOutcomes: [],
        startedAt: timestamp,
        state: "running",
      });
      job.attemptIds.push(attempt.id);
      job.progress = {
        completedFraction: 0,
        elapsedMs: 0,
        estimateKind: "benchmark_approximate",
        profile: job.profile,
        stage: "preflight",
      };
      job.state = "running";
      job.updatedAt = timestamp;
      this.#state.attempts.push(attempt);
      await this.#persist();
      return {
        attempt: structuredClone(attempt),
        job: structuredClone(job),
        projectDurationSamples: project.project.durationSamples,
      };
    });
    if (started === null) return null;
    if ("blockedJob" in started) return started.blockedJob;

    const controller = new AbortController();
    this.#active = {
      attemptId: started.attempt.id,
      controller,
      jobId: started.job.id,
    };
    try {
      const reusableCheckpoints = await this.#matchingCheckpoints(
        started.job,
        started.projectDurationSamples,
      );
      if (reusableCheckpoints.length > 0) {
        await this.#serializeMutation(async () => {
          const attempt = this.#requireAttempt(started.attempt.id);
          attempt.checkpointIds = reusableCheckpoints.map(({ id }) => id);
          await this.#persist();
        });
      }
      const availableCheckpoints = new Map<
        AnalysisCheckpointCandidate["stage"],
        AnalysisCheckpoint
      >(reusableCheckpoints.map((checkpoint) => [checkpoint.stage, checkpoint]));
      const result = await this.#runWithDeadline(
        started.attempt,
        controller,
        this.#runner.run({
          attemptId: started.attempt.id,
          checkpoints: reusableCheckpoints,
          job: started.job,
          reportProgress: (progress) => this.#reportProgress(started.job.id, progress),
          saveCheckpoint: async (checkpoint) => {
            const saved = await this.#saveCheckpoint(
              started.job.id,
              started.attempt.id,
              started.projectDurationSamples,
              availableCheckpoints,
              checkpoint,
            );
            availableCheckpoints.set(saved.stage, saved);
          },
          signal: controller.signal,
        }),
      );
      const candidate = validateAnalysisCandidate(started.job, started.attempt.id, result);
      return await this.#serializeMutation(async () => {
        await this.#assertCurrentAttempt(started.job.id, started.attempt.id, controller.signal);
        const job = this.#requireJob(started.job.id);
        const attempt = this.#requireAttempt(started.attempt.id);
        attempt.candidateAnalysisRevisionId = candidate.revision.id;
        attempt.candidateManifestHash = candidate.revision.manifestHash;
        attempt.stageOutcomes = candidate.stageOutcomes;
        await this.#persist();
        const publication = await this.#authority.publishAnalysisRevision({
          attemptId: attempt.id,
          canonicalAudioFingerprint: job.canonicalAudioFingerprint,
          expectedProjectRevisionId: attempt.expectedProjectRevisionId,
          jobKey: job.key,
          manifest: candidate.manifest,
          projectId: job.projectId,
          recipeHash: job.recipeHash,
          revision: candidate.revision,
          sourceIdentityKind: job.sourceIdentityKind,
          sourceSnapshotId: job.sourceSnapshotId,
        });
        if (!("projectRevisionId" in publication)) {
          throw new AnalysisRunError({
            classification: "stale" in publication ? "stale_result" : "blocked_input",
            message: "Analysis candidate was not published by the Project authority",
            nextAction: "stale" in publication ? "retry" : "check_input",
            retryable: "stale" in publication,
            stage: "publish",
          });
        }
        this.#completePublication(job, attempt, publication.projectRevisionId);
        await this.#persist();
        return structuredClone(job);
      });
    } catch (error) {
      if (error instanceof SupersededRuntimeError) return error.currentJob;
      const failure = enforceCircuitBreakerFailure(normalizeRunFailure(error));
      return this.#serializeMutation(async () => {
        const job = this.#requireJob(started.job.id);
        const attempt = this.#requireAttempt(started.attempt.id);
        const snapshot = await this.#authority.getSnapshot(job.projectId);
        const published = snapshot?.project.analysisRevisions.find(
          ({ id }) => id === attempt.candidateAnalysisRevisionId,
        );
        if (
          snapshot !== null &&
          published !== undefined &&
          published.manifestHash === attempt.candidateManifestHash
        ) {
          this.#completePublication(job, attempt, snapshot.projectRevisionId);
          await this.#persist();
          return structuredClone(job);
        }
        const timestamp = this.#now().toISOString();
        attempt.failure = failure;
        attempt.finishedAt = timestamp;
        attempt.state = failure.classification === "cancelled" ? "cancelled" : "failed";
        job.state =
          failure.classification === "cancelled"
            ? "cancelled"
            : failure.retryable
              ? "retryable"
              : "blocked";
        if (isCircuitBreakerFailure(failure)) {
          this.#state.circuitBreaker = {
            classification: failure.classification,
            openedAt: timestamp,
          };
        }
        job.updatedAt = timestamp;
        await this.#persist();
        return structuredClone(job);
      });
    } finally {
      if (this.#active?.attemptId === started.attempt.id) this.#active = undefined;
    }
  }

  async retry(jobId: string): Promise<AnalysisJobSnapshot> {
    return this.#serializeMutation(async () => {
      const job = this.#requireJob(jobId);
      if (job.state !== "retryable" && job.state !== "cancelled") {
        throw new Error("Analysis Job is not retryable");
      }
      job.state = "queued";
      job.queuePosition = nextQueuePosition(this.#state.jobs);
      job.updatedAt = this.#now().toISOString();
      await this.#persist();
      return structuredClone(job);
    });
  }

  async refreshBlockedDependencies(jobId: string): Promise<AnalysisJobSnapshot> {
    return this.#serializeMutation(async () => {
      const job = this.#requireJob(jobId);
      if (job.state !== "blocked") throw new Error("Analysis Job is not blocked");
      const blockedDependencies = await this.#resolveBlockedDependencies(job);
      job.blockedDependencies = blockedDependencies;
      if (blockedDependencies.length === 0) {
        job.state = "queued";
        job.queuePosition = nextQueuePosition(this.#state.jobs);
      }
      job.updatedAt = this.#now().toISOString();
      await this.#persist();
      return structuredClone(job);
    });
  }

  async #resolveBlockedDependencies(input: {
    canonicalAudioFingerprint: string;
    projectId: string;
    projectRange: z.infer<typeof AnalysisProjectRangeSchema>;
    recipe: AnalysisRecipe;
    sourceIdentityKind: "canonical_audio" | "source_snapshot";
    sourceSnapshotId: string;
  }): Promise<z.infer<typeof BlockedDependencySchema>[]> {
    const currentRange = await this.#authority.getProjectRange(input.projectId);
    if (
      currentRange !== null &&
      canonicalSerialize(AnalysisProjectRangeSchema.parse(currentRange)) !==
        canonicalSerialize(input.projectRange)
    ) {
      throw projectRangeIntegrityFailure();
    }
    if (currentRange === null) return [{ id: input.sourceSnapshotId, kind: "media" }];
    return z
      .array(BlockedDependencySchema)
      .parse(await this.#dependencies.resolveBlockedDependencies(input))
      .toSorted(
        (left, right) => left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id),
      );
  }

  async #runWithDeadline<T>(
    attempt: AnalysisAttemptSnapshot,
    controller: AbortController,
    execution: Promise<T>,
  ): Promise<T> {
    const remainingMs = Math.max(0, Date.parse(attempt.deadlineAt) - this.#now().getTime());
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        const error = new AnalysisRunError({
          classification: "deadline",
          message: "Analysis Attempt exceeded its main-owned deadline",
          nextAction: "retry",
          retryable: true,
          stage: "preflight",
        });
        controller.abort(error);
        reject(error);
      }, remainingMs);
    });
    const interrupted = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener("abort", () => reject(controller.signal.reason), {
        once: true,
      });
    });
    try {
      return await Promise.race([execution, deadline, interrupted]);
    } catch (error) {
      if (controller.signal.aborted) {
        const reason = normalizeTerminationReason(controller.signal.reason);
        try {
          await this.#runner.terminateAndWait({ attemptId: attempt.id, reason });
        } catch {
          throw new AnalysisRunError({
            classification: "containment_violation",
            message: "Analysis runner did not acknowledge termination and process cleanup",
            nextAction: "repair_installation",
            retryable: false,
            stage: "preflight",
          });
        }
      }
      throw error;
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  #completePublication(
    job: AnalysisJobSnapshot,
    attempt: AnalysisAttemptSnapshot,
    projectRevisionId: string,
  ): void {
    if (
      attempt.candidateAnalysisRevisionId === undefined ||
      attempt.candidateManifestHash === undefined
    ) {
      throw new Error("Published Analysis Attempt has no validated candidate identity");
    }
    const timestamp = this.#now().toISOString();
    delete attempt.failure;
    attempt.finishedAt = timestamp;
    attempt.publishedProjectRevisionId = projectRevisionId;
    attempt.stageOutcomes = [
      ...attempt.stageOutcomes.filter(
        ({ stage }) => !MAIN_STAGES.some((mainStage) => mainStage === stage),
      ),
      { stage: "main_validation", state: "completed" },
      { stage: "publish", state: "completed" },
    ];
    attempt.state = "succeeded";
    job.publishedAnalysisRevisionId = attempt.candidateAnalysisRevisionId;
    job.progress = {
      completedFraction: 1,
      elapsedMs: job.progress?.elapsedMs ?? 0,
      estimateKind: "benchmark_approximate",
      profile: job.profile,
      stage: "publish",
    };
    job.state = "succeeded";
    job.updatedAt = timestamp;
  }

  #requireJob(jobId: string): AnalysisJobSnapshot {
    const job = this.#state.jobs.find(({ id }) => id === jobId);
    if (job === undefined) throw new Error(`Analysis Job ${jobId} was not found`);
    return job;
  }

  #requireAttempt(attemptId: string): AnalysisAttemptSnapshot {
    const attempt = this.#state.attempts.find(({ id }) => id === attemptId);
    if (attempt === undefined) throw new Error(`Analysis Attempt ${attemptId} was not found`);
    return attempt;
  }

  async #matchingCheckpoints(
    job: AnalysisJobSnapshot,
    projectDurationSamples: number,
  ): Promise<ReusableAnalysisCheckpoint[]> {
    const now = this.#now().getTime();
    const matching: ReusableAnalysisCheckpoint[] = [];
    const projectRangeHash = hashIdentity(job.projectRange);
    for (const stage of checkpointStagesForJob(job)) {
      const sharedFeatures = matching.find(
        ({ stage: retainedStage }) => retainedStage === "shared_features",
      );
      const predecessorArtifactHashes =
        stage === "shared_features"
          ? []
          : sharedFeatures === undefined
            ? undefined
            : [sharedFeatures.artifactHash];
      if (predecessorArtifactHashes === undefined) continue;
      const upstreamIdentityHash = checkpointIdentity(
        job,
        stage,
        projectRangeHash,
        predecessorArtifactHashes,
      );
      const candidates = this.#state.checkpoints.filter(
        (checkpoint) =>
          checkpoint.jobId === job.id &&
          checkpoint.stage === stage &&
          checkpoint.projectRangeHash === projectRangeHash &&
          checkpoint.upstreamIdentityHash === upstreamIdentityHash &&
          Date.parse(checkpoint.expiresAt) > now,
      );
      if (candidates.length > 1) {
        throw checkpointIntegrityFailure(stage, "Checkpoint lineage has multiple stage artifacts");
      }
      const checkpoint = candidates[0];
      if (checkpoint === undefined) continue;
      try {
        const content = await readFile(checkpointArtifactPath(this.#path, checkpoint.artifactHash));
        if (
          content.byteLength !== checkpoint.byteSize ||
          hashBytes(content) !== checkpoint.artifactHash
        ) {
          throw new Error("Checkpoint bytes do not match retained metadata");
        }
        const document = AnalysisCheckpointCandidateSchema.shape.document.parse(
          JSON.parse(content.toString("utf8")),
        );
        validateCheckpointDocument(document, projectDurationSamples);
        if (document.kind !== checkpoint.kind) {
          throw new Error("Checkpoint document kind does not match retained metadata");
        }
        matching.push({ ...checkpoint, document });
      } catch {
        throw checkpointIntegrityFailure(
          checkpoint.stage,
          "Analysis Checkpoint artifact failed main-owned integrity validation",
        );
      }
    }
    return structuredClone(matching);
  }

  async #reportProgress(
    jobId: string,
    rawProgress: {
      completedFraction: number;
      elapsedMs: number;
      stage: z.infer<typeof AnalysisProgressSchema>["stage"];
    },
  ): Promise<void> {
    await this.#serializeMutation(async () => {
      const job = this.#requireJob(jobId);
      const progress = AnalysisProgressSchema.parse({
        ...rawProgress,
        estimateKind: "benchmark_approximate",
        profile: job.profile,
      });
      if (job.state !== "running") {
        throw new Error("Analysis progress arrived outside its active Attempt");
      }
      if (
        job.progress !== undefined &&
        (progress.completedFraction < job.progress.completedFraction ||
          progress.elapsedMs < job.progress.elapsedMs)
      ) {
        throw new Error("Analysis progress must be monotonic");
      }
      job.progress = progress;
      job.updatedAt = this.#now().toISOString();
      await this.#persist();
    });
  }

  async #saveCheckpoint(
    jobId: string,
    attemptId: string,
    projectDurationSamples: number,
    availableCheckpoints: ReadonlyMap<AnalysisCheckpointCandidate["stage"], AnalysisCheckpoint>,
    rawCheckpoint: AnalysisCheckpointCandidate,
  ): Promise<AnalysisCheckpoint> {
    const parsed = AnalysisCheckpointCandidateSchema.safeParse(rawCheckpoint);
    if (!parsed.success) {
      throw new Error("Analysis Checkpoint must be a validated non-media stage artifact");
    }
    if (parsed.data.document.kind !== parsed.data.kind) {
      throw new Error("Analysis Checkpoint document kind does not match its stage artifact kind");
    }
    if (parsed.data.stage !== parsed.data.kind) {
      throw new Error("Analysis Checkpoint kind must match its completed pipeline stage");
    }
    validateCheckpointDocument(parsed.data.document, projectDurationSamples);
    if (!checkpointStagesForJob(this.#requireJob(jobId)).includes(parsed.data.stage)) {
      throw new Error("Analysis Checkpoint stage is not part of the Job Recipe");
    }
    const content = canonicalSerialize(parsed.data.document);
    const byteSize = Buffer.byteLength(content);
    if (byteSize > 1024 * 1024) throw new Error("Analysis Checkpoint artifact exceeds 1 MiB");
    const artifactHash = hashBytes(Buffer.from(content, "utf8"));
    const existingAvailable = availableCheckpoints.get(parsed.data.stage);
    if (existingAvailable !== undefined) {
      if (existingAvailable.artifactHash === artifactHash) return existingAvailable;
      throw new Error("Analysis Checkpoint lineage already has a different stage artifact");
    }
    const sharedFeatures = availableCheckpoints.get("shared_features");
    const predecessorArtifactHashes =
      parsed.data.stage === "shared_features"
        ? []
        : sharedFeatures === undefined
          ? undefined
          : [sharedFeatures.artifactHash];
    if (predecessorArtifactHashes === undefined) {
      throw new Error("Analysis Checkpoint is missing its exact shared-features predecessor");
    }
    return this.#serializeMutation(async () => {
      const job = this.#requireJob(jobId);
      const attempt = this.#requireAttempt(attemptId);
      if (job.state !== "running" || attempt.state !== "running") {
        throw new Error("Analysis Checkpoint arrived outside its active Attempt");
      }
      const createdAt = this.#now();
      const projectRangeHash = hashIdentity(job.projectRange);
      const upstreamIdentityHash = checkpointIdentity(
        job,
        parsed.data.stage,
        projectRangeHash,
        predecessorArtifactHashes,
      );
      const checkpoint = AnalysisCheckpointSchema.parse({
        artifactHash,
        byteSize,
        createdAt: createdAt.toISOString(),
        expiresAt: new Date(createdAt.getTime() + OPERATIONAL_RETENTION_MS).toISOString(),
        id: `checkpoint_${hashIdentity({ artifactHash, jobId, upstreamIdentityHash }).slice("sha256:".length)}`,
        jobId,
        kind: parsed.data.kind,
        predecessorArtifactHashes,
        projectRangeHash,
        stage: parsed.data.stage,
        upstreamIdentityHash,
      });
      const existingLineage = this.#state.checkpoints.find(
        (retained) =>
          retained.jobId === job.id &&
          retained.stage === checkpoint.stage &&
          retained.upstreamIdentityHash === checkpoint.upstreamIdentityHash,
      );
      if (existingLineage !== undefined && existingLineage.artifactHash !== artifactHash) {
        throw new Error("Analysis Checkpoint lineage already has a different stage artifact");
      }
      await atomicWrite(checkpointArtifactPath(this.#path, artifactHash), content);
      if (!this.#state.checkpoints.some(({ id }) => id === checkpoint.id)) {
        this.#state.checkpoints.push(checkpoint);
      }
      if (!attempt.checkpointIds.includes(checkpoint.id)) attempt.checkpointIds.push(checkpoint.id);
      await this.#persist();
      return checkpoint;
    });
  }

  async #assertCurrentAttempt(
    jobId: string,
    attemptId: string,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) throw signal.reason;
    const durable = await readState(this.#path);
    const currentJob = durable.jobs.find(({ id }) => id === jobId);
    if (
      durable.runtimeSessionId !== this.#state.runtimeSessionId ||
      currentJob?.state !== "running"
    ) {
      if (currentJob === undefined) {
        throw new AnalysisRunError({
          classification: "interrupted",
          message: "Analysis Job disappeared during its Attempt",
          nextAction: "retry",
          retryable: true,
          stage: "preflight",
        });
      }
      throw new SupersededRuntimeError(structuredClone(currentJob));
    }
    const currentAttempt = durable.attempts.find(({ id }) => id === attemptId);
    if (currentAttempt?.state !== "running") {
      throw new SupersededRuntimeError(structuredClone(currentJob));
    }
  }

  async #serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#mutationTail.then(operation, operation);
    this.#mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function emptyState(): z.infer<typeof AnalysisJobStateSchema> {
  return {
    attempts: [],
    checkpoints: [],
    circuitBreaker: null,
    format: "open-chords/analysis-jobs",
    jobs: [],
    runtimeSessionId: randomUUID(),
    schemaVersion: "1.0",
  };
}

async function readState(path: string): Promise<z.infer<typeof AnalysisJobStateSchema>> {
  try {
    return AnalysisJobStateSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (isMissingPathError(error)) return emptyState();
    throw error;
  }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true });
  const temporary = join(parent, `.state-${randomUUID()}.tmp`);
  const file = await open(temporary, "wx");
  try {
    await file.writeFile(content, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
  const directory = await open(parent, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

function hashIdentity(value: unknown): string {
  return hashContent(canonicalSerialize(value));
}

function hashContent(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function hashBytes(value: Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function checkpointArtifactPath(statePath: string, artifactHash: string): string {
  return join(
    dirname(statePath),
    "checkpoints",
    `${Sha256Schema.parse(artifactHash).slice(7)}.json`,
  );
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function nextQueuePosition(jobs: readonly AnalysisJobSnapshot[]): number {
  return Math.max(-1, ...jobs.map(({ queuePosition }) => queuePosition)) + 1;
}

function validateAnalysisCandidate(
  job: AnalysisJobSnapshot,
  attemptId: string,
  raw: {
    manifest: AnalysisManifest;
    revision: AnalysisRevision;
  },
): {
  manifest: AnalysisManifest;
  revision: AnalysisRevision;
  stageOutcomes: z.infer<typeof RunnerStageOutcomeSchema>[];
} {
  try {
    const verified = validateAnalysisManifestProvenance({
      digest: hashContent,
      expectedCandidateIdentity: {
        attemptId,
        canonicalAudioFingerprint: job.canonicalAudioFingerprint,
        jobKey: job.key,
        projectId: job.projectId,
        recipeHash: job.recipeHash,
        sourceIdentityKind: job.sourceIdentityKind,
        sourceSnapshotId: job.sourceSnapshotId,
      },
      expectedRecipe: job.recipe,
      manifest: raw.manifest,
      revision: raw.revision,
    });
    return {
      manifest: verified.manifest,
      revision: verified.revision,
      stageOutcomes: z.array(RunnerStageOutcomeSchema).parse(verified.manifest.stageOutcomes),
    };
  } catch {
    throw new AnalysisRunError({
      classification: "integrity_violation",
      message: "Analysis Manifest identity, provenance, or accepted output hashes are invalid",
      nextAction: "repair_installation",
      retryable: false,
      stage: "main_validation",
    });
  }
}

function normalizeRunFailure(error: unknown): AnalysisFailure {
  if (error instanceof AnalysisRunError) return error.failure;
  return AnalysisFailureSchema.parse({
    classification: "internal_error",
    message: "Analysis Attempt failed internally",
    nextAction: "restart_application",
    retryable: false,
    stage: "preflight",
  });
}

function normalizeTerminationReason(reason: unknown): "cancelled" | "deadline" | "interrupted" {
  if (reason instanceof AnalysisRunError) {
    if (reason.failure.classification === "cancelled") return "cancelled";
    if (reason.failure.classification === "deadline") return "deadline";
  }
  return "interrupted";
}

function checkpointIdentity(
  job: AnalysisJobSnapshot,
  stage: AnalysisCheckpointCandidate["stage"],
  projectRangeHash: string,
  predecessorArtifactHashes: readonly string[],
): string {
  return hashIdentity({
    canonicalAudioFingerprint: job.canonicalAudioFingerprint,
    predecessorArtifactHashes,
    projectRangeHash,
    recipeHash: job.recipeHash,
    stage,
  });
}

function checkpointStagesForJob(job: AnalysisJobSnapshot): AnalysisCheckpointCandidate["stage"][] {
  const capabilities = new Set(job.recipe.capabilities);
  return [
    "shared_features",
    ...CAPABILITY_STAGES.filter(
      (stage) =>
        (stage === "rhythm" && (capabilities.has("rhythm") || capabilities.has("meter"))) ||
        (stage === "harmony" && (capabilities.has("key") || capabilities.has("chords"))) ||
        (stage === "sections" && capabilities.has("sections")),
    ),
  ];
}

function checkpointIntegrityFailure(
  stage: AnalysisCheckpointCandidate["stage"],
  message: string,
): AnalysisRunError {
  return new AnalysisRunError({
    classification: "integrity_violation",
    message,
    nextAction: "repair_installation",
    retryable: false,
    stage,
  });
}

function projectRangeIntegrityFailure(): AnalysisRunError {
  return new AnalysisRunError({
    classification: "integrity_violation",
    message: "Project Range authority changed for an existing Project",
    nextAction: "repair_installation",
    retryable: false,
    stage: "preflight",
  });
}

class SupersededRuntimeError extends Error {
  readonly currentJob: AnalysisJobSnapshot;

  constructor(currentJob: AnalysisJobSnapshot) {
    super("Analysis Attempt belongs to an obsolete runtime session");
    this.currentJob = currentJob;
  }
}

async function terminatePersistedAttempts(
  state: z.infer<typeof AnalysisJobStateSchema>,
  runner: AnalysisJobRunner,
): Promise<void> {
  const activeAttempts = state.attempts.filter(
    ({ state: attemptState }) => attemptState === "running" || attemptState === "cancelling",
  );
  for (const attempt of activeAttempts) {
    await runner.terminateAndWait({
      attemptId: attempt.id,
      reason: attempt.state === "cancelling" ? "cancelled" : "interrupted",
    });
  }
}

async function recoverStateAfterRestart(
  state: z.infer<typeof AnalysisJobStateSchema>,
  authority: AnalysisProjectAuthority,
  now: Date,
): Promise<z.infer<typeof AnalysisJobStateSchema>> {
  const recovered = structuredClone(state);
  recovered.circuitBreaker = null;
  const timestamp = now.toISOString();
  for (const job of recovered.jobs) {
    if (job.state === "queued") {
      job.state = "awaiting_confirmation";
      job.updatedAt = timestamp;
      continue;
    }
    if (job.state !== "running" && job.state !== "cancelling") continue;
    const attempt = recovered.attempts.find(
      ({ id, state: attemptState }) =>
        job.attemptIds.includes(id) &&
        (attemptState === "running" || attemptState === "cancelling"),
    );
    if (attempt === undefined) continue;
    if (
      attempt.candidateAnalysisRevisionId !== undefined &&
      attempt.candidateManifestHash !== undefined
    ) {
      const snapshot = await authority.getSnapshot(job.projectId);
      const published = snapshot?.project.analysisRevisions.find(
        ({ id }) => id === attempt.candidateAnalysisRevisionId,
      );
      if (
        snapshot !== null &&
        published !== undefined &&
        published.manifestHash === attempt.candidateManifestHash
      ) {
        delete attempt.failure;
        attempt.finishedAt = timestamp;
        attempt.publishedProjectRevisionId = snapshot.projectRevisionId;
        attempt.stageOutcomes = [
          ...attempt.stageOutcomes,
          { stage: "main_validation", state: "completed" },
          { stage: "publish", state: "completed" },
        ];
        attempt.state = "succeeded";
        job.publishedAnalysisRevisionId = published.id;
        job.progress = {
          completedFraction: 1,
          elapsedMs: job.progress?.elapsedMs ?? 0,
          estimateKind: "benchmark_approximate",
          profile: job.profile,
          stage: "publish",
        };
        job.state = "succeeded";
        job.updatedAt = timestamp;
        continue;
      }
    }
    const wasCancelling = job.state === "cancelling";
    attempt.failure = AnalysisFailureSchema.parse({
      classification: wasCancelling ? "cancelled" : "interrupted",
      message: wasCancelling
        ? "Analysis cancellation completed during restart"
        : "Analysis Attempt was interrupted by restart",
      nextAction: "retry",
      retryable: true,
      stage: "preflight",
    });
    attempt.finishedAt = timestamp;
    attempt.state = wasCancelling ? "cancelled" : "failed";
    job.state = wasCancelling ? "cancelled" : "retryable";
    job.updatedAt = timestamp;
  }
  return recovered;
}

function isCircuitBreakerFailure(failure: AnalysisFailure): failure is AnalysisFailure & {
  classification: "containment_violation" | "integrity_violation" | "protocol_violation";
} {
  return ["containment_violation", "integrity_violation", "protocol_violation"].includes(
    failure.classification,
  );
}

function enforceCircuitBreakerFailure(failure: AnalysisFailure): AnalysisFailure {
  if (!isCircuitBreakerFailure(failure)) return failure;
  return AnalysisFailureSchema.parse({
    ...failure,
    nextAction: "repair_installation",
    retryable: false,
  });
}

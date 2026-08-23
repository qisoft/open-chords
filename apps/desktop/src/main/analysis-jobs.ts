import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  canonicalSerialize,
  type AnalysisRevision,
  type ProjectContract,
} from "@open-chords/domain";
import { z } from "zod";

const STATE_FILE = "analysis-jobs/state.json";
const OPERATIONAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const Sha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const TimestampSchema = z.iso.datetime({ offset: true });
const PipelineSchema = z.tuple([
  z.literal("preflight"),
  z.literal("canonical_decode"),
  z.literal("shared_features"),
  z.literal("analysis"),
  z.literal("assemble"),
  z.literal("main_validation"),
  z.literal("publish"),
]);
const VersionedComponentSchema = z.strictObject({
  hash: Sha256Schema,
  id: z.string().min(1),
  version: z.string().min(1),
});
const AnalysisRecipeSchema = z.strictObject({
  capabilities: z
    .array(z.enum(["rhythm", "meter", "key", "chords", "sections"]))
    .min(1)
    .refine((values) => new Set(values).size === values.length, "Capabilities must be unique"),
  components: z
    .array(VersionedComponentSchema)
    .min(1)
    .refine(
      (components) => new Set(components.map(({ id }) => id)).size === components.length,
      "Component IDs must be unique",
    ),
  numericalBackend: VersionedComponentSchema,
  pipeline: PipelineSchema,
  profile: VersionedComponentSchema.extend({
    name: z.enum(["eco", "balanced", "fast"]),
  }),
  seeds: z.record(z.string().min(1), z.number().int()),
  settings: z.record(z.string().min(1), z.union([z.boolean(), z.number().finite(), z.string()])),
});
const BlockedDependencySchema = z.strictObject({
  id: z.string().min(1),
  kind: z.enum(["consent", "dictionary", "license", "media", "model"]),
});
const AnalysisProgressSchema = z.strictObject({
  completedFraction: z.number().min(0).max(1),
  elapsedMs: z.number().int().nonnegative(),
  estimateKind: z.literal("benchmark_approximate"),
  profile: z.enum(["eco", "balanced", "fast"]),
  stage: z.enum([
    "preflight",
    "canonical_decode",
    "shared_features",
    "analysis",
    "assemble",
    "main_validation",
    "publish",
  ]),
});

export type AnalysisRecipe = z.infer<typeof AnalysisRecipeSchema>;

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
  publishedAnalysisRevisionId: z.string().min(1).optional(),
  queuePosition: z.number().int().nonnegative(),
  recipe: AnalysisRecipeSchema,
  recipeHash: Sha256Schema,
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
  stage: z.enum(["preflight", "canonical_decode", "shared_features", "analysis", "assemble"]),
  state: z.enum(["completed", "completed_with_abstentions"]),
});
const AnalysisStageOutcomeSchema = z.strictObject({
  stage: z.enum([
    "preflight",
    "canonical_decode",
    "shared_features",
    "analysis",
    "assemble",
    "main_validation",
    "publish",
  ]),
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
const AnalysisCheckpointCandidateSchema = z.strictObject({
  artifactHash: Sha256Schema,
  byteSize: z
    .number()
    .int()
    .positive()
    .max(1024 * 1024 * 1024),
  kind: z.enum(["shared_features", "rhythm", "harmony", "sections"]),
  stage: z.enum(["shared_features", "analysis"]),
});
const AnalysisCheckpointSchema = AnalysisCheckpointCandidateSchema.extend({
  createdAt: TimestampSchema,
  expiresAt: TimestampSchema,
  id: z.string().min(1),
  jobId: z.string().min(1),
  upstreamIdentityHash: Sha256Schema,
});
const AnalysisCircuitBreakerSchema = z.strictObject({
  classification: z.enum(["containment_violation", "integrity_violation", "protocol_violation"]),
  openedAt: TimestampSchema,
});
const AnalysisAttemptSchema = z.strictObject({
  cancelRequestedAt: TimestampSchema.optional(),
  checkpointIds: z.array(z.string().min(1)),
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

export class AnalysisRunError extends Error {
  readonly failure: AnalysisFailure;

  constructor(failure: AnalysisFailure) {
    const parsed = AnalysisFailureSchema.parse(failure);
    super(parsed.message);
    this.name = "AnalysisRunError";
    this.failure = parsed;
  }
}

export type AnalysisProjectAuthority = {
  getSnapshot(projectId: string): Promise<{
    eventSequence: number;
    project: ProjectContract;
    projectRevisionId: string;
  } | null>;
  publishAnalysisRevision(input: {
    expectedProjectRevisionId: string;
    projectId: string;
    revision: AnalysisRevision;
  }): Promise<
    { notFound: true } | { projectRevisionId: string } | { readOnly: true } | { stale: true }
  >;
};

export type AnalysisJobRunner = {
  run(input: {
    attemptId: string;
    checkpoints: readonly AnalysisCheckpoint[];
    job: AnalysisJobSnapshot;
    reportProgress: (progress: {
      completedFraction: number;
      elapsedMs: number;
      stage: z.infer<typeof AnalysisProgressSchema>["stage"];
    }) => Promise<void>;
    saveCheckpoint: (checkpoint: AnalysisCheckpointCandidate) => Promise<void>;
    signal: AbortSignal;
  }): Promise<{
    revision: AnalysisRevision;
    stageOutcomes: z.infer<typeof RunnerStageOutcomeSchema>[];
  }>;
};

type AnalysisJobsOptions = {
  authority: AnalysisProjectAuthority;
  idFactory?: () => string;
  now?: () => Date;
  runner: AnalysisJobRunner;
  stateRoot: string;
};

export async function openAnalysisJobs(options: AnalysisJobsOptions): Promise<AnalysisJobs> {
  const path = join(options.stateRoot, STATE_FILE);
  const loaded = await readState(path);
  const state = recoverStateAfterRestart(loaded.state, options.now?.() ?? new Date());
  state.runtimeSessionId = randomUUID();
  const analysisJobs = new AnalysisJobs(options, path, state);
  await analysisJobs.persist();
  return analysisJobs;
}

export class AnalysisJobs {
  #active: { attemptId: string; controller: AbortController; jobId: string } | undefined;
  readonly #authority: AnalysisProjectAuthority;
  readonly #idFactory: () => string;
  #mutationTail: Promise<void> = Promise.resolve();
  readonly #now: () => Date;
  readonly #path: string;
  readonly #runner: AnalysisJobRunner;
  #state: z.infer<typeof AnalysisJobStateSchema>;

  constructor(
    options: AnalysisJobsOptions,
    path: string,
    state: z.infer<typeof AnalysisJobStateSchema>,
  ) {
    this.#authority = options.authority;
    this.#idFactory = options.idFactory ?? (() => `job_${randomUUID().replaceAll("-", "")}`);
    this.#now = options.now ?? (() => new Date());
    this.#path = path;
    this.#runner = options.runner;
    this.#state = state;
  }

  async confirmQueued(jobId: string): Promise<AnalysisJobSnapshot> {
    return this.#serializeMutation(async () => {
      const job = this.#requireJob(jobId);
      if (job.state !== "awaiting_confirmation") {
        throw new Error("Analysis Job is not awaiting restart confirmation");
      }
      job.state = "queued";
      job.updatedAt = this.#now().toISOString();
      await this.persist();
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
      stage: "analysis",
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
      await this.persist();
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
      await this.persist();
      return structuredClone(job);
    });
    if (this.#active?.jobId === jobId) {
      this.#active.controller.abort(
        new AnalysisRunError({
          classification: "cancelled",
          message: "Analysis Attempt was cancelled",
          nextAction: "retry",
          retryable: true,
          stage: "analysis",
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
      await this.persist();
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

  async persist(): Promise<void> {
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
      await this.persist();
    });
  }

  async submit(input: {
    blockedDependencies?: readonly z.infer<typeof BlockedDependencySchema>[];
    canonicalAudioFingerprint: string;
    projectId: string;
    recipe: AnalysisRecipe;
    sourceSnapshotId: string;
  }): Promise<AnalysisJobSnapshot> {
    return this.#serializeMutation(async () => {
      const recipe = AnalysisRecipeSchema.parse(input.recipe);
      const recipeHash = hashIdentity(recipe);
      const key = hashIdentity({
        canonicalAudioFingerprint: Sha256Schema.parse(input.canonicalAudioFingerprint),
        projectId: input.projectId,
        recipeHash,
        sourceSnapshotId: input.sourceSnapshotId,
      });
      const existing = this.#state.jobs.find(
        (job) => job.key === key && !["cancelled"].includes(job.state),
      );
      if (existing !== undefined) return structuredClone(existing);
      const timestamp = this.#now().toISOString();
      const blockedDependencies = z
        .array(BlockedDependencySchema)
        .parse(input.blockedDependencies ?? []);
      const job = AnalysisJobSchema.parse({
        attemptIds: [],
        blockedDependencies,
        canonicalAudioFingerprint: input.canonicalAudioFingerprint,
        createdAt: timestamp,
        id: this.#idFactory(),
        key,
        profile: recipe.profile.name,
        projectId: input.projectId,
        queuePosition: nextQueuePosition(this.#state.jobs),
        recipe,
        recipeHash,
        sourceSnapshotId: input.sourceSnapshotId,
        state: blockedDependencies.length === 0 ? "queued" : "blocked",
        updatedAt: timestamp,
      });
      this.#state.jobs.push(job);
      await this.persist();
      return structuredClone(job);
    });
  }

  async runNext(): Promise<AnalysisJobSnapshot | null> {
    const started = await this.#serializeMutation(async () => {
      if (this.#state.circuitBreaker !== null) return null;
      if (this.#state.jobs.some(({ state }) => state === "running" || state === "cancelling")) {
        return null;
      }
      const job = this.#state.jobs
        .filter(({ state }) => state === "queued")
        .toSorted((left, right) => left.queuePosition - right.queuePosition)[0];
      if (job === undefined) return null;
      const project = await this.#authority.getSnapshot(job.projectId);
      if (project === null) throw new Error(`Project ${job.projectId} was not found`);
      const timestamp = this.#now().toISOString();
      const attempt = AnalysisAttemptSchema.parse({
        checkpointIds: [],
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
      await this.persist();
      return { attempt: structuredClone(attempt), job: structuredClone(job) };
    });
    if (started === null) return null;

    const controller = new AbortController();
    this.#active = {
      attemptId: started.attempt.id,
      controller,
      jobId: started.job.id,
    };
    try {
      const result = await this.#runner.run({
        attemptId: started.attempt.id,
        checkpoints: this.#matchingCheckpoints(started.job),
        job: started.job,
        reportProgress: (progress) => this.#reportProgress(started.job.id, progress),
        saveCheckpoint: (checkpoint) =>
          this.#saveCheckpoint(started.job.id, started.attempt.id, checkpoint),
        signal: controller.signal,
      });
      await this.#assertCurrentAttempt(started.job.id, started.attempt.id, controller.signal);
      const stageOutcomes = validateRunnerStageOutcomes(result.stageOutcomes);
      const publication = await this.#authority.publishAnalysisRevision({
        expectedProjectRevisionId: started.attempt.expectedProjectRevisionId,
        projectId: started.job.projectId,
        revision: result.revision,
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
      return this.#serializeMutation(async () => {
        const job = this.#requireJob(started.job.id);
        const attempt = this.#requireAttempt(started.attempt.id);
        const timestamp = this.#now().toISOString();
        attempt.finishedAt = timestamp;
        attempt.publishedProjectRevisionId = publication.projectRevisionId;
        attempt.stageOutcomes = [
          ...stageOutcomes,
          { stage: "main_validation", state: "completed" },
          { stage: "publish", state: "completed" },
        ];
        attempt.state = "succeeded";
        job.publishedAnalysisRevisionId = result.revision.id;
        job.progress = {
          completedFraction: 1,
          elapsedMs: job.progress?.elapsedMs ?? 0,
          estimateKind: "benchmark_approximate",
          profile: job.profile,
          stage: "publish",
        };
        job.state = "succeeded";
        job.updatedAt = timestamp;
        await this.persist();
        return structuredClone(job);
      });
    } catch (error) {
      if (error instanceof SupersededRuntimeError) return error.currentJob;
      const failure = enforceCircuitBreakerFailure(normalizeRunFailure(error));
      return this.#serializeMutation(async () => {
        const job = this.#requireJob(started.job.id);
        const attempt = this.#requireAttempt(started.attempt.id);
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
        await this.persist();
        return structuredClone(job);
      });
    } finally {
      if (this.#active?.attemptId === started.attempt.id) this.#active = undefined;
    }
  }

  async retry(jobId: string): Promise<AnalysisJobSnapshot> {
    return this.#serializeMutation(async () => {
      const job = this.#requireJob(jobId);
      if (job.state !== "retryable") throw new Error("Analysis Job is not retryable");
      job.state = "queued";
      job.queuePosition = nextQueuePosition(this.#state.jobs);
      job.updatedAt = this.#now().toISOString();
      await this.persist();
      return structuredClone(job);
    });
  }

  async refreshBlockedDependencies(
    jobId: string,
    rawDependencies: readonly z.infer<typeof BlockedDependencySchema>[],
  ): Promise<AnalysisJobSnapshot> {
    return this.#serializeMutation(async () => {
      const job = this.#requireJob(jobId);
      if (job.state !== "blocked") throw new Error("Analysis Job is not blocked");
      const blockedDependencies = z.array(BlockedDependencySchema).parse(rawDependencies);
      job.blockedDependencies = blockedDependencies;
      if (blockedDependencies.length === 0) {
        job.state = "queued";
        job.queuePosition = nextQueuePosition(this.#state.jobs);
      }
      job.updatedAt = this.#now().toISOString();
      await this.persist();
      return structuredClone(job);
    });
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

  #matchingCheckpoints(job: AnalysisJobSnapshot): AnalysisCheckpoint[] {
    const now = this.#now().getTime();
    return structuredClone(
      this.#state.checkpoints.filter(
        (checkpoint) =>
          checkpoint.jobId === job.id &&
          checkpoint.upstreamIdentityHash === checkpointIdentity(job, checkpoint.stage) &&
          Date.parse(checkpoint.expiresAt) > now,
      ),
    );
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
      await this.persist();
    });
  }

  async #saveCheckpoint(
    jobId: string,
    attemptId: string,
    rawCheckpoint: AnalysisCheckpointCandidate,
  ): Promise<void> {
    const parsed = AnalysisCheckpointCandidateSchema.safeParse(rawCheckpoint);
    if (!parsed.success) {
      throw new Error("Analysis Checkpoint must be a validated non-media stage artifact");
    }
    await this.#serializeMutation(async () => {
      const job = this.#requireJob(jobId);
      const attempt = this.#requireAttempt(attemptId);
      if (job.state !== "running" || attempt.state !== "running") {
        throw new Error("Analysis Checkpoint arrived outside its active Attempt");
      }
      const createdAt = this.#now();
      const checkpoint = AnalysisCheckpointSchema.parse({
        ...parsed.data,
        createdAt: createdAt.toISOString(),
        expiresAt: new Date(createdAt.getTime() + OPERATIONAL_RETENTION_MS).toISOString(),
        id: `checkpoint_${hashIdentity(parsed.data).slice("sha256:".length)}`,
        jobId,
        upstreamIdentityHash: checkpointIdentity(job, parsed.data.stage),
      });
      if (!this.#state.checkpoints.some(({ id }) => id === checkpoint.id)) {
        this.#state.checkpoints.push(checkpoint);
      }
      if (!attempt.checkpointIds.includes(checkpoint.id)) attempt.checkpointIds.push(checkpoint.id);
      await this.persist();
    });
  }

  async #assertCurrentAttempt(
    jobId: string,
    attemptId: string,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) throw signal.reason;
    const durable = await readState(this.#path);
    const currentJob = durable.state.jobs.find(({ id }) => id === jobId);
    if (
      durable.state.runtimeSessionId !== this.#state.runtimeSessionId ||
      currentJob?.state !== "running"
    ) {
      if (currentJob === undefined) {
        throw new AnalysisRunError({
          classification: "interrupted",
          message: "Analysis Job disappeared during its Attempt",
          nextAction: "retry",
          retryable: true,
          stage: "analysis",
        });
      }
      throw new SupersededRuntimeError(structuredClone(currentJob));
    }
    const currentAttempt = durable.state.attempts.find(({ id }) => id === attemptId);
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

async function readState(
  path: string,
): Promise<{ existed: boolean; state: z.infer<typeof AnalysisJobStateSchema> }> {
  try {
    return {
      existed: true,
      state: AnalysisJobStateSchema.parse(JSON.parse(await readFile(path, "utf8"))),
    };
  } catch (error) {
    if (isMissingPathError(error)) return { existed: false, state: emptyState() };
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
  return `sha256:${createHash("sha256").update(canonicalSerialize(value)).digest("hex")}`;
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function nextQueuePosition(jobs: readonly AnalysisJobSnapshot[]): number {
  return Math.max(-1, ...jobs.map(({ queuePosition }) => queuePosition)) + 1;
}

function validateRunnerStageOutcomes(
  rawOutcomes: readonly z.infer<typeof RunnerStageOutcomeSchema>[],
): z.infer<typeof RunnerStageOutcomeSchema>[] {
  const outcomes = z.array(RunnerStageOutcomeSchema).length(5).parse(rawOutcomes);
  const expected = ["preflight", "canonical_decode", "shared_features", "analysis", "assemble"];
  if (outcomes.some(({ stage }, index) => stage !== expected[index])) {
    throw new Error("Analysis runner did not complete the declared DAG in order");
  }
  return outcomes;
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

function checkpointIdentity(
  job: AnalysisJobSnapshot,
  stage: AnalysisCheckpointCandidate["stage"],
): string {
  return hashIdentity({
    canonicalAudioFingerprint: job.canonicalAudioFingerprint,
    recipeHash: job.recipeHash,
    stage,
  });
}

class SupersededRuntimeError extends Error {
  readonly currentJob: AnalysisJobSnapshot;

  constructor(currentJob: AnalysisJobSnapshot) {
    super("Analysis Attempt belongs to an obsolete runtime session");
    this.currentJob = currentJob;
  }
}

function recoverStateAfterRestart(
  state: z.infer<typeof AnalysisJobStateSchema>,
  now: Date,
): z.infer<typeof AnalysisJobStateSchema> {
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
    const wasCancelling = job.state === "cancelling";
    attempt.failure = AnalysisFailureSchema.parse({
      classification: wasCancelling ? "cancelled" : "interrupted",
      message: wasCancelling
        ? "Analysis cancellation completed during restart"
        : "Analysis Attempt was interrupted by restart",
      nextAction: "retry",
      retryable: true,
      stage: "analysis",
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

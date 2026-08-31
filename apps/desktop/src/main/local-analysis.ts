import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

import {
  AnalysisRecipeSchema,
  AnalysisStageOutcomeSchema,
  canonicalSerialize,
  parseAnalysisTimeline,
  type AnalysisManifest,
  type AnalysisRecipe,
  type MusicalTimeline,
} from "@open-chords/domain";
import { z } from "zod";

import { AnalysisJobs, AnalysisRunError, type AnalysisJobSnapshot } from "./analysis-jobs.ts";
import {
  LocalMediaCapabilityUnavailableError,
  LocalMediaChangedError,
  LocalMediaRangeError,
  LocalMediaReadLimitError,
  type LocalMediaService,
} from "./local-media.ts";
import type { ProjectLibrary } from "./project-library.ts";
import {
  parseSidecarSessionRequest,
  SidecarSessionError,
  type SidecarClient,
} from "./sidecar-session.ts";

const AnalyzerResultSchema = z.strictObject({
  durationSamples: z.number().int().positive(),
  recipe: AnalysisRecipeSchema,
  sampleRate: z.number().int().positive(),
  stageOutcomes: z.array(AnalysisStageOutcomeSchema),
  supportClaimIds: z.array(z.string().min(1)).max(100),
  timeline: z.unknown(),
  warnings: z.array(z.string().min(1).max(512)).max(100),
});

type AnalyzerResult = z.infer<typeof AnalyzerResultSchema>;

export type LocalContainedAnalyzer = {
  analyze(input: {
    attemptId: string;
    inputPath: string;
    jobId: string;
    recipe: AnalysisRecipe;
    reportProgress: (progress: {
      completedFraction: number;
      elapsedMs: number;
      stage: AnalysisManifest["stageOutcomes"][number]["stage"];
    }) => Promise<void>;
    signal: AbortSignal;
  }): Promise<AnalyzerResult>;
  terminateAndWait(input: {
    attemptId: string;
    reason: "cancelled" | "deadline" | "interrupted";
  }): Promise<void>;
};

export function createSidecarContainedAnalyzer(options: {
  clientForWorkspace: (workspace: string) => SidecarClient | Promise<SidecarClient>;
  idFactory?: () => string;
  runtimeManifestHash: string;
}): LocalContainedAnalyzer {
  const active = new Map<string, { client: SidecarClient; finished: Promise<void> }>();
  const idFactory = options.idFactory ?? (() => randomUUID().replaceAll("-", ""));
  return {
    async analyze(input) {
      const startedAt = Date.now();
      const workspace = dirname(dirname(input.inputPath));
      const recipePath = join(workspace, "input", "analysis-recipe.json");
      await writeFile(recipePath, canonicalSerialize(input.recipe), {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      const client = await options.clientForWorkspace(workspace);
      let finish!: () => void;
      const finished = new Promise<void>((resolve) => {
        finish = resolve;
      });
      active.set(input.attemptId, { client, finished });
      let candidate: AnalyzerResult | undefined;
      let failure: AnalysisRunError | undefined;
      try {
        const identity = idFactory();
        const result = await client.runSession(
          parseSidecarSessionRequest({
            jobId: input.jobId,
            manifestHash: options.runtimeManifestHash,
            nonce: `nonce-${identity}`,
            requestId: `request-${identity}`,
            signal: input.signal,
            timeoutMs: 30 * 60 * 1_000,
          }),
        );
        candidate = await readAnalysisResult(workspace, result.artifact);
        await input.reportProgress({
          completedFraction: 0.9,
          elapsedMs: Date.now() - startedAt,
          stage: "assemble",
        });
      } catch (error) {
        failure = normalizeAnalyzerFailure(error, input.signal);
      }
      try {
        await client.dispose();
      } catch (error) {
        if (failure === undefined) failure = normalizeAnalyzerFailure(error, input.signal);
      }
      active.delete(input.attemptId);
      finish();
      if (failure !== undefined) throw failure;
      if (candidate === undefined) throw new Error("Contained analyzer produced no candidate");
      return candidate;
    },
    async terminateAndWait(input) {
      const running = active.get(input.attemptId);
      if (running === undefined) return;
      await running.client.dispose();
      await running.finished;
    },
  };
}

type LocalAnalysisOptions = {
  analyzer: LocalContainedAnalyzer;
  attemptTimeoutMs?: number;
  idFactory?: () => string;
  library: ProjectLibrary;
  media: LocalMediaService;
  now?: () => Date;
  stateRoot: string;
  workspaceRoot: string;
};

export class LocalAnalysisService {
  readonly #jobs: AnalysisJobs;
  readonly #media: LocalMediaService;

  private constructor(jobs: AnalysisJobs, media: LocalMediaService) {
    this.#jobs = jobs;
    this.#media = media;
  }

  static async open(options: LocalAnalysisOptions): Promise<LocalAnalysisService> {
    const runner = createLocalAnalysisRunner(options);
    const jobs = await AnalysisJobs.open({
      authority: options.library,
      ...(options.attemptTimeoutMs === undefined
        ? {}
        : { attemptTimeoutMs: options.attemptTimeoutMs }),
      dependencies: {
        resolveBlockedDependencies: (input) =>
          options.library.resolveBlockedDependencies({
            ...input,
            modelStore: { resolveBlockedRecipeArtifacts: async () => [] },
          }),
      },
      ...(options.idFactory === undefined ? {} : { idFactory: options.idFactory }),
      ...(options.now === undefined ? {} : { now: options.now }),
      runner,
      stateRoot: options.stateRoot,
    });
    return new LocalAnalysisService(jobs, options.media);
  }

  async analyzeProject(input: {
    projectId: string;
    recipe: AnalysisRecipe;
  }): Promise<ReturnType<AnalysisJobs["get"]>> {
    const job = await this.submitProject(input);
    if (job.state === "queued") await this.#jobs.runNext();
    return this.#jobs.get(job.id);
  }

  async cancel(jobId: string): Promise<AnalysisJobSnapshot> {
    return this.#jobs.cancel(jobId);
  }

  get(jobId: string): ReturnType<AnalysisJobs["get"]> {
    return this.#jobs.get(jobId);
  }

  list(): AnalysisJobSnapshot[] {
    return this.#jobs.list();
  }

  async runNext(): Promise<AnalysisJobSnapshot | null> {
    return this.#jobs.runNext();
  }

  async submitProject(input: {
    projectId: string;
    recipe: AnalysisRecipe;
  }): Promise<AnalysisJobSnapshot> {
    const source = await this.#media.getAnalysisSource(input.projectId);
    return this.#jobs.submit({
      ...source,
      projectId: input.projectId,
      recipe: input.recipe,
    });
  }
}

function createLocalAnalysisRunner(options: LocalAnalysisOptions) {
  return {
    async run(input: {
      attemptId: string;
      job: AnalysisJobSnapshot;
      reportProgress: Parameters<LocalContainedAnalyzer["analyze"]>[0]["reportProgress"];
      signal: AbortSignal;
    }) {
      const workspace = join(options.workspaceRoot, input.attemptId);
      const inputPath = join(workspace, "input", "source-media");
      await mkdir(workspace, { recursive: true, mode: 0o700 });
      try {
        let staged: { durationSamples: number; sampleRate: number };
        try {
          staged = await options.media.stageAnalysisInput({
            destinationPath: inputPath,
            projectId: input.job.projectId,
          });
        } catch (error) {
          if (
            error instanceof LocalMediaCapabilityUnavailableError ||
            error instanceof LocalMediaChangedError
          ) {
            throw new AnalysisRunError({
              classification: "blocked_input",
              message: "Verified Project Source is unavailable or changed",
              nextAction: "check_input",
              retryable: true,
              stage: "preflight",
            });
          }
          if (error instanceof LocalMediaRangeError || error instanceof LocalMediaReadLimitError) {
            throw new AnalysisRunError({
              classification: "unsupported_input",
              message: "Project Range cannot be staged within local analysis limits",
              nextAction: "check_input",
              retryable: false,
              stage: "preflight",
            });
          }
          throw error;
        }
        const analyzerOutput = await options.analyzer.analyze({
          attemptId: input.attemptId,
          inputPath,
          jobId: input.job.id,
          recipe: input.job.recipe,
          reportProgress: input.reportProgress,
          signal: input.signal,
        });
        let raw: AnalyzerResult;
        let timeline: MusicalTimeline;
        try {
          raw = AnalyzerResultSchema.parse(analyzerOutput);
          if (
            raw.durationSamples !== staged.durationSamples ||
            raw.sampleRate !== staged.sampleRate ||
            canonicalSerialize(raw.recipe) !== canonicalSerialize(input.job.recipe)
          ) {
            throw new Error("Contained analyzer result does not match its staged Project input");
          }
          timeline = parseAnalysisTimeline(raw.timeline, raw.durationSamples);
        } catch {
          throw new AnalysisRunError({
            classification: "invalid_output",
            message: "Contained analyzer result failed main validation",
            nextAction: "repair_installation",
            retryable: false,
            stage: "main_validation",
          });
        }
        return buildCandidate(input, raw, timeline, options.now?.() ?? new Date());
      } finally {
        await rm(workspace, { force: true, recursive: true });
      }
    },
    terminateAndWait: (input: {
      attemptId: string;
      reason: "cancelled" | "deadline" | "interrupted";
    }) => options.analyzer.terminateAndWait(input),
  };
}

function buildCandidate(
  input: { attemptId: string; job: AnalysisJobSnapshot },
  result: AnalyzerResult,
  timeline: MusicalTimeline,
  createdAt: Date,
) {
  const manifest: AnalysisManifest = {
    acceptedOutputHashes: {
      supportClaimIds: hashCanonical(result.supportClaimIds),
      timeline: hashCanonical(timeline),
    },
    candidateIdentity: {
      attemptId: input.attemptId,
      canonicalAudioFingerprint: input.job.canonicalAudioFingerprint,
      jobKey: input.job.key,
      projectId: input.job.projectId,
      recipeHash: input.job.recipeHash,
      sourceIdentityKind: input.job.sourceIdentityKind,
      sourceSnapshotId: input.job.sourceSnapshotId,
    },
    format: "open-chords/analysis-manifest",
    recipe: result.recipe,
    reproducibilityConditions: {
      componentHashes: result.recipe.components.map(({ hash }) => hash),
      numericalBackendHash: result.recipe.numericalBackend.hash,
      profileHash: result.recipe.profile.hash,
      seedsHash: hashCanonical(result.recipe.seeds),
      settingsHash: hashCanonical(result.recipe.settings),
    },
    stageOutcomes: result.stageOutcomes,
    warnings: result.warnings,
  };
  const manifestHash = hashCanonical(manifest);
  return {
    manifest,
    revision: {
      createdAt: createdAt.toISOString(),
      id: `revision_${manifestHash.slice("sha256:".length)}`,
      manifestHash,
      projectId: input.job.projectId,
      supportClaimIds: result.supportClaimIds,
      timeline,
    },
  };
}

function hashCanonical(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalSerialize(value)).digest("hex")}`;
}

async function readAnalysisResult(
  workspace: string,
  artifact: { byteSize: number; path: string; sha256: string },
): Promise<AnalyzerResult> {
  if (artifact.path !== "artifacts/analysis-result.json" || artifact.byteSize > 16 * 1024 * 1024) {
    throw new AnalysisRunError({
      classification: "invalid_output",
      message: "Contained analyzer returned an unexpected result artifact",
      nextAction: "repair_installation",
      retryable: false,
      stage: "assemble",
    });
  }
  const path = join(workspace, artifact.path);
  const workspaceRoot = await realpath(workspace);
  const parent = await realpath(dirname(path));
  const pathStat = await lstat(path);
  if (
    pathStat.isSymbolicLink() ||
    !pathStat.isFile() ||
    relative(workspaceRoot, parent).startsWith("..")
  ) {
    throw new AnalysisRunError({
      classification: "integrity_violation",
      message: "Contained analyzer result escaped its immutable workspace",
      nextAction: "repair_installation",
      retryable: false,
      stage: "main_validation",
    });
  }
  const bytes = await readFile(path);
  const actualHash = createHash("sha256").update(bytes).digest("hex");
  if (bytes.byteLength !== artifact.byteSize || actualHash !== artifact.sha256) {
    throw new AnalysisRunError({
      classification: "integrity_violation",
      message: "Contained analyzer result does not match its descriptor",
      nextAction: "repair_installation",
      retryable: false,
      stage: "main_validation",
    });
  }
  try {
    return AnalyzerResultSchema.parse(JSON.parse(bytes.toString("utf8")));
  } catch {
    throw new AnalysisRunError({
      classification: "invalid_output",
      message: "Contained analyzer result is malformed",
      nextAction: "repair_installation",
      retryable: false,
      stage: "main_validation",
    });
  }
}

function normalizeAnalyzerFailure(error: unknown, signal: AbortSignal): AnalysisRunError {
  if (error instanceof AnalysisRunError) return error;
  if (signal.aborted && signal.reason instanceof AnalysisRunError) return signal.reason;
  if (error instanceof SidecarSessionError) {
    if (error.code === "timeout") {
      return new AnalysisRunError({
        classification: "deadline",
        message: "Contained analyzer exceeded its deadline",
        nextAction: "retry",
        retryable: true,
        stage: "preflight",
      });
    }
    if (error.code === "protocol_violation" || error.code === "frame_too_large") {
      return new AnalysisRunError({
        classification: "protocol_violation",
        message: "Contained analyzer violated its bounded protocol",
        nextAction: "repair_installation",
        retryable: false,
        stage: "preflight",
      });
    }
    if (error.code === "launch_failure" && error.remoteCode?.startsWith("native_") === true) {
      return new AnalysisRunError({
        classification: "containment_violation",
        message: "Native containment could not be established",
        nextAction: "repair_installation",
        retryable: false,
        stage: "preflight",
      });
    }
    if (error.code === "remote_failure" && error.remoteCode === "analysis_failed") {
      return new AnalysisRunError({
        classification: "component_failure",
        message: "CPU analyzer rejected the staged Project input",
        nextAction: "retry",
        retryable: true,
        stage: "shared_features",
      });
    }
    return new AnalysisRunError({
      classification: "component_failure",
      message: "Contained analyzer process failed",
      nextAction: "retry",
      retryable: true,
      stage: "preflight",
    });
  }
  return new AnalysisRunError({
    classification: "internal_error",
    message: "Local analysis orchestration failed",
    nextAction: "restart_application",
    retryable: false,
    stage: "preflight",
  });
}

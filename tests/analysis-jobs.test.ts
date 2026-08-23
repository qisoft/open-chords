import { createHash } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ProjectEnvelopeSchema } from "@open-chords/contracts";
import { canonicalSerialize } from "@open-chords/domain";
import { afterEach, describe, expect, it } from "vitest";

import {
  AnalysisRunError,
  openAnalysisJobs as openProductionAnalysisJobs,
  type AnalysisCandidateManifest,
  type AnalysisJobRunner,
  type AnalysisProjectAuthority,
  type AnalysisRecipe,
} from "../apps/desktop/src/main/analysis-jobs.ts";

const temporaryRoots: string[] = [];

type TestAuthority = Omit<AnalysisProjectAuthority, "resolveBlockedDependencies"> &
  Partial<Pick<AnalysisProjectAuthority, "resolveBlockedDependencies">>;
type RunnerInput = Parameters<AnalysisJobRunner["run"]>[0];
type RunnerOutput = Awaited<ReturnType<AnalysisJobRunner["run"]>>;
type TestRunner = {
  run(
    input: RunnerInput,
  ): Promise<Omit<RunnerOutput, "manifest"> & { manifest?: AnalysisCandidateManifest }>;
};

async function openAnalysisJobs(options: {
  authority: TestAuthority;
  idFactory?: () => string;
  now?: () => Date;
  runner: TestRunner;
  stateRoot: string;
}) {
  const testRunner: AnalysisJobRunner = {
    run: async (input) => {
      const result = await options.runner.run(input);
      const manifest =
        result.manifest ??
        ({
          attemptId: input.attemptId,
          canonicalAudioFingerprint: input.job.canonicalAudioFingerprint,
          jobKey: input.job.key,
          projectId: input.job.projectId,
          recipeHash: input.job.recipeHash,
          sourceSnapshotId: input.job.sourceSnapshotId,
        } satisfies AnalysisCandidateManifest);
      const manifestHash = `sha256:${createHash("sha256")
        .update(canonicalSerialize(manifest))
        .digest("hex")}`;
      return {
        ...result,
        manifest,
        revision: {
          ...result.revision,
          id: `revision_${manifestHash.slice("sha256:".length)}`,
          manifestHash,
          projectId: input.job.projectId,
        },
      };
    },
  };
  return openProductionAnalysisJobs({
    ...options,
    authority: {
      ...options.authority,
      resolveBlockedDependencies: options.authority.resolveBlockedDependencies ?? (async () => []),
    },
    runner: testRunner,
  });
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

async function temporaryDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "open-chords-analysis-jobs-"));
  temporaryRoots.push(root);
  return root;
}

const recipe: AnalysisRecipe = {
  capabilities: ["rhythm", "chords"],
  components: [
    {
      hash: `sha256:${"1".repeat(64)}`,
      id: "open-chords-dsp",
      version: "1.0.0",
    },
  ],
  numericalBackend: {
    hash: `sha256:${"2".repeat(64)}`,
    id: "numpy",
    version: "2.4.2",
  },
  pipeline: [
    "preflight",
    "canonical_decode",
    "shared_features",
    "rhythm",
    "harmony",
    "assemble",
    "main_validation",
    "publish",
  ],
  profile: {
    hash: `sha256:${"3".repeat(64)}`,
    id: "balanced",
    name: "balanced",
    version: "1.0.0",
  },
  seeds: { decoder: 7 },
  settings: { hopLength: 512 },
};

const authority: TestAuthority = {
  getSnapshot: async () => null,
  publishAnalysisRevision: async () => ({ notFound: true }),
};

const runner: TestRunner = {
  run: async () => new Promise(() => undefined),
};

const goldenProject = ProjectEnvelopeSchema.parse(
  JSON.parse(
    readFileSync(
      join(import.meta.dirname, "../packages/testkit/contracts/v1/valid/project-envelope.json"),
      "utf8",
    ),
  ),
).payload;

describe("AnalysisJobs", () => {
  it("durably reuses one Job Key and requires confirmation after restart", async () => {
    const stateRoot = await temporaryDirectory();
    const ids = ["job_first", "job_duplicate"];
    const firstRuntime = await openAnalysisJobs({
      authority,
      idFactory: () => ids.shift()!,
      runner,
      stateRoot,
    });
    const request = {
      canonicalAudioFingerprint: `sha256:${"a".repeat(64)}`,
      projectId: "project_fixture",
      recipe,
      sourceSnapshotId: "snapshot_fixture",
    } as const;

    const first = await firstRuntime.submit(request);
    const duplicate = await firstRuntime.submit(request);

    expect(duplicate.id).toBe(first.id);
    expect(firstRuntime.list()).toMatchObject([
      {
        attemptIds: [],
        id: "job_first",
        profile: "balanced",
        state: "queued",
      },
    ]);

    const reopened = await openAnalysisJobs({ authority, runner, stateRoot });
    expect(reopened.list()).toMatchObject([{ id: "job_first", state: "awaiting_confirmation" }]);

    await reopened.confirmQueued("job_first");
    expect(reopened.list()).toMatchObject([{ id: "job_first", state: "queued" }]);
  });

  it("publishes a successful Attempt only through the main Project authority", async () => {
    const stateRoot = await temporaryDirectory();
    const published: string[] = [];
    const candidate = {
      ...structuredClone(goldenProject.analysisRevisions[0]!),
      id: "revision_candidate",
    };
    const successfulAuthority: TestAuthority = {
      getSnapshot: async () => ({
        eventSequence: 1,
        project: structuredClone(goldenProject),
        projectRevisionId: "projectrevision_current",
      }),
      publishAnalysisRevision: async (input) => {
        published.push(input.revision.id);
        return { projectRevisionId: "projectrevision_published" };
      },
    };
    const successfulRunner: TestRunner = {
      run: async () => ({
        revision: candidate,
        stageOutcomes: [
          { stage: "preflight", state: "completed" },
          { stage: "canonical_decode", state: "completed" },
          { stage: "shared_features", state: "completed" },
          { stage: "rhythm", state: "completed" },
          { stage: "harmony", state: "completed_with_abstentions" },
          { stage: "assemble", state: "completed" },
        ],
      }),
    };
    const ids = ["job_success", "attempt_success"];
    const jobs = await openAnalysisJobs({
      authority: successfulAuthority,
      idFactory: () => ids.shift()!,
      runner: successfulRunner,
      stateRoot,
    });
    await jobs.submit({
      canonicalAudioFingerprint: `sha256:${"a".repeat(64)}`,
      projectId: "project_golden",
      recipe,
      sourceSnapshotId: "snapshot_fixture",
    });

    await jobs.runNext();

    expect(published).toHaveLength(1);
    const publishedRevisionId = published[0]!;
    expect(jobs.get("job_success")).toMatchObject({
      attempts: [
        {
          id: "attempt_success",
          publishedProjectRevisionId: "projectrevision_published",
          state: "succeeded",
        },
      ],
      job: {
        attemptIds: ["attempt_success"],
        publishedAnalysisRevisionId: publishedRevisionId,
        state: "succeeded",
      },
    });
  });

  it("publishes nothing on stage failure and retries with a new immutable Attempt", async () => {
    const stateRoot = await temporaryDirectory();
    const candidate = {
      ...structuredClone(goldenProject.analysisRevisions[0]!),
      id: "revision_retry",
    };
    let publications = 0;
    const retryAuthority: TestAuthority = {
      getSnapshot: async () => ({
        eventSequence: 1,
        project: structuredClone(goldenProject),
        projectRevisionId: "projectrevision_current",
      }),
      publishAnalysisRevision: async () => {
        publications += 1;
        return { projectRevisionId: "projectrevision_published" };
      },
    };
    let runs = 0;
    const retryRunner: TestRunner = {
      run: async () => {
        runs += 1;
        if (runs === 1) {
          throw new AnalysisRunError({
            classification: "component_failure",
            message: "Harmony decoder rejected its bounded output",
            nextAction: "retry",
            retryable: true,
            stage: "harmony",
          });
        }
        return {
          revision: candidate,
          stageOutcomes: [
            { stage: "preflight", state: "completed" },
            { stage: "canonical_decode", state: "completed" },
            { stage: "shared_features", state: "completed" },
            { stage: "rhythm", state: "completed" },
            { stage: "harmony", state: "completed" },
            { stage: "assemble", state: "completed" },
          ],
        };
      },
    };
    const ids = ["job_retry", "attempt_failed", "attempt_retried"];
    const jobs = await openAnalysisJobs({
      authority: retryAuthority,
      idFactory: () => ids.shift()!,
      runner: retryRunner,
      stateRoot,
    });
    const submitted = await jobs.submit({
      canonicalAudioFingerprint: `sha256:${"a".repeat(64)}`,
      projectId: "project_golden",
      recipe,
      sourceSnapshotId: "snapshot_fixture",
    });

    await expect(jobs.runNext()).resolves.toMatchObject({ state: "retryable" });
    expect(publications).toBe(0);
    const failed = jobs.get("job_retry");
    expect(failed).toMatchObject({
      attempts: [
        {
          failure: {
            classification: "component_failure",
            retryable: true,
            stage: "harmony",
          },
          id: "attempt_failed",
          state: "failed",
        },
      ],
      job: { recipeHash: submitted.recipeHash, state: "retryable" },
    });

    await jobs.retry("job_retry");
    await expect(jobs.runNext()).resolves.toMatchObject({ state: "succeeded" });
    expect(publications).toBe(1);
    const retried = jobs.get("job_retry");
    expect(retried.job.recipeHash).toBe(submitted.recipeHash);
    expect(retried.attempts.map(({ id }) => id)).toEqual(["attempt_failed", "attempt_retried"]);
    expect(retried.attempts[0]).toEqual(failed.attempts[0]);
  });

  it("reuses only exact non-media Checkpoints on a new Attempt", async () => {
    const stateRoot = await temporaryDirectory();
    const seenCheckpointCounts: number[] = [];
    let rejectedMediaCheckpoint = false;
    let runs = 0;
    const checkpointRunner: TestRunner = {
      run: async (input) => {
        seenCheckpointCounts.push(input.checkpoints.length);
        runs += 1;
        if (runs === 1) {
          try {
            await Reflect.apply(input.saveCheckpoint, undefined, [
              {
                artifactHash: `sha256:${"9".repeat(64)}`,
                byteSize: 192_000,
                kind: "canonical_pcm",
                stage: "canonical_decode",
              },
            ]);
          } catch (error) {
            rejectedMediaCheckpoint = /non-media/iu.test(String(error));
          }
          await input.saveCheckpoint({
            artifactHash: `sha256:${"8".repeat(64)}`,
            byteSize: 4096,
            kind: "shared_features",
            stage: "shared_features",
          });
          throw new AnalysisRunError({
            classification: "component_failure",
            message: "Harmony failed after reusable features",
            nextAction: "retry",
            retryable: true,
            stage: "harmony",
          });
        }
        return {
          revision: {
            ...structuredClone(goldenProject.analysisRevisions[0]!),
            id: "revision_checkpoint_retry",
          },
          stageOutcomes: [
            { stage: "preflight", state: "completed" },
            { stage: "canonical_decode", state: "completed" },
            { stage: "shared_features", state: "completed" },
            { stage: "rhythm", state: "completed" },
            { stage: "harmony", state: "completed" },
            { stage: "assemble", state: "completed" },
          ],
        };
      },
    };
    const ids = ["job_checkpoint", "attempt_checkpoint_failed", "attempt_checkpoint_retry"];
    const jobs = await openAnalysisJobs({
      authority: {
        getSnapshot: async () => ({
          eventSequence: 1,
          project: structuredClone(goldenProject),
          projectRevisionId: "projectrevision_current",
        }),
        publishAnalysisRevision: async () => ({
          projectRevisionId: "projectrevision_published",
        }),
      },
      idFactory: () => ids.shift()!,
      runner: checkpointRunner,
      stateRoot,
    });
    await jobs.submit({
      canonicalAudioFingerprint: `sha256:${"a".repeat(64)}`,
      projectId: "project_golden",
      recipe,
      sourceSnapshotId: "snapshot_fixture",
    });

    await jobs.runNext();
    expect(rejectedMediaCheckpoint).toBe(true);
    expect(jobs.get("job_checkpoint").checkpoints).toMatchObject([
      { kind: "shared_features", stage: "shared_features" },
    ]);
    await jobs.retry("job_checkpoint");
    await jobs.runNext();

    expect(seenCheckpointCounts).toEqual([0, 1]);
  });

  it("persists cancellation and ignores a late successful result", async () => {
    const stateRoot = await temporaryDirectory();
    let publications = 0;
    let releaseResult!: () => void;
    let reportStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      reportStarted = resolve;
    });
    const resultReleased = new Promise<void>((resolve) => {
      releaseResult = resolve;
    });
    const cancellableRunner: TestRunner = {
      run: async ({ signal }) => {
        reportStarted();
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        await resultReleased;
        return {
          revision: {
            ...structuredClone(goldenProject.analysisRevisions[0]!),
            id: "revision_too_late",
          },
          stageOutcomes: [
            { stage: "preflight", state: "completed" },
            { stage: "canonical_decode", state: "completed" },
            { stage: "shared_features", state: "completed" },
            { stage: "rhythm", state: "completed" },
            { stage: "harmony", state: "completed" },
            { stage: "assemble", state: "completed" },
          ],
        };
      },
    };
    const cancelAuthority: TestAuthority = {
      getSnapshot: async () => ({
        eventSequence: 1,
        project: structuredClone(goldenProject),
        projectRevisionId: "projectrevision_current",
      }),
      publishAnalysisRevision: async () => {
        publications += 1;
        return { projectRevisionId: "projectrevision_forbidden" };
      },
    };
    const ids = ["job_cancel", "attempt_cancel"];
    const jobs = await openAnalysisJobs({
      authority: cancelAuthority,
      idFactory: () => ids.shift()!,
      runner: cancellableRunner,
      stateRoot,
    });
    await jobs.submit({
      canonicalAudioFingerprint: `sha256:${"a".repeat(64)}`,
      projectId: "project_golden",
      recipe,
      sourceSnapshotId: "snapshot_fixture",
    });

    const running = jobs.runNext();
    await started;
    await jobs.cancel("job_cancel");
    const reopened = await openAnalysisJobs({
      authority: cancelAuthority,
      runner: cancellableRunner,
      stateRoot,
    });
    expect(reopened.get("job_cancel")).toMatchObject({
      attempts: [{ state: "cancelled" }],
      job: { state: "cancelled" },
    });
    releaseResult();
    await expect(running).resolves.toMatchObject({ state: "cancelled" });
    expect(publications).toBe(0);
  });

  it("recovers a running Attempt as interrupted and rejects its late result after restart", async () => {
    const stateRoot = await temporaryDirectory();
    let publications = 0;
    let releaseResult!: () => void;
    let reportStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      reportStarted = resolve;
    });
    const resultReleased = new Promise<void>((resolve) => {
      releaseResult = resolve;
    });
    const crashingRunner: TestRunner = {
      run: async () => {
        reportStarted();
        await resultReleased;
        return {
          revision: {
            ...structuredClone(goldenProject.analysisRevisions[0]!),
            id: "revision_from_old_session",
          },
          stageOutcomes: [
            { stage: "preflight", state: "completed" },
            { stage: "canonical_decode", state: "completed" },
            { stage: "shared_features", state: "completed" },
            { stage: "rhythm", state: "completed" },
            { stage: "harmony", state: "completed" },
            { stage: "assemble", state: "completed" },
          ],
        };
      },
    };
    const crashAuthority: TestAuthority = {
      getSnapshot: async () => ({
        eventSequence: 1,
        project: structuredClone(goldenProject),
        projectRevisionId: "projectrevision_current",
      }),
      publishAnalysisRevision: async () => {
        publications += 1;
        return { projectRevisionId: "projectrevision_forbidden" };
      },
    };
    const ids = ["job_restart", "attempt_interrupted"];
    const jobs = await openAnalysisJobs({
      authority: crashAuthority,
      idFactory: () => ids.shift()!,
      runner: crashingRunner,
      stateRoot,
    });
    await jobs.submit({
      canonicalAudioFingerprint: `sha256:${"a".repeat(64)}`,
      projectId: "project_golden",
      recipe,
      sourceSnapshotId: "snapshot_fixture",
    });
    const obsoleteRun = jobs.runNext();
    await started;

    const restarted = await openAnalysisJobs({
      authority: crashAuthority,
      runner: crashingRunner,
      stateRoot,
    });
    expect(restarted.get("job_restart")).toMatchObject({
      attempts: [{ failure: { classification: "interrupted" }, state: "failed" }],
      job: { state: "retryable" },
    });
    releaseResult();
    await expect(obsoleteRun).resolves.toMatchObject({ state: "retryable" });
    expect(publications).toBe(0);
  });

  it("keeps missing dependencies blocked and runs confirmed work FIFO with monotonic progress", async () => {
    const stateRoot = await temporaryDirectory();
    const runOrder: string[] = [];
    let modelReady = false;
    const schedulerRunner: TestRunner = {
      run: async (input) => {
        runOrder.push(input.job.id);
        await input.reportProgress({
          completedFraction: 0.25,
          elapsedMs: 100,
          stage: "canonical_decode",
        });
        await input.reportProgress({
          completedFraction: 0.75,
          elapsedMs: 300,
          stage: "harmony",
        });
        await expect(
          input.reportProgress({ completedFraction: 0.5, elapsedMs: 301, stage: "assemble" }),
        ).rejects.toThrow(/monotonic/i);
        return {
          revision: {
            ...structuredClone(goldenProject.analysisRevisions[0]!),
            id: `revision_${input.job.id}`,
          },
          stageOutcomes: [
            { stage: "preflight", state: "completed" },
            { stage: "canonical_decode", state: "completed" },
            { stage: "shared_features", state: "completed" },
            { stage: "rhythm", state: "completed" },
            { stage: "harmony", state: "completed" },
            { stage: "assemble", state: "completed" },
          ],
        };
      },
    };
    const ids = ["job_blocked", "job_ready", "attempt_ready", "attempt_unblocked"];
    const jobs = await openAnalysisJobs({
      authority: {
        getSnapshot: async () => ({
          eventSequence: 1,
          project: structuredClone(goldenProject),
          projectRevisionId: "projectrevision_current",
        }),
        resolveBlockedDependencies: async ({ sourceSnapshotId }) =>
          sourceSnapshotId === "snapshot_fixture" && !modelReady
            ? [{ id: "model_missing", kind: "model" as const }]
            : [],
        publishAnalysisRevision: async () => ({ projectRevisionId: "projectrevision_next" }),
      },
      idFactory: () => ids.shift()!,
      runner: schedulerRunner,
      stateRoot,
    });
    await jobs.submit({
      canonicalAudioFingerprint: `sha256:${"a".repeat(64)}`,
      projectId: "project_golden",
      recipe,
      sourceSnapshotId: "snapshot_fixture",
    });
    await jobs.submit({
      canonicalAudioFingerprint: `sha256:${"b".repeat(64)}`,
      projectId: "project_golden",
      recipe,
      sourceSnapshotId: "snapshot_other",
    });

    await jobs.runNext();
    expect(runOrder).toEqual(["job_ready"]);
    expect(jobs.get("job_blocked")).toMatchObject({
      attempts: [],
      job: { blockedDependencies: [{ id: "model_missing", kind: "model" }], state: "blocked" },
    });
    expect(jobs.get("job_ready").job.progress).toMatchObject({
      completedFraction: 1,
      estimateKind: "benchmark_approximate",
      profile: "balanced",
      stage: "publish",
    });

    modelReady = true;
    await jobs.refreshBlockedDependencies("job_blocked");
    await jobs.runNext();
    expect(runOrder).toEqual(["job_ready", "job_blocked"]);
  });

  it("rechecks main-owned dependencies immediately before creating an Attempt", async () => {
    const stateRoot = await temporaryDirectory();
    let dependencyMissing = false;
    let runs = 0;
    const jobs = await openAnalysisJobs({
      authority: {
        getSnapshot: async () => ({
          eventSequence: 1,
          project: structuredClone(goldenProject),
          projectRevisionId: "projectrevision_current",
        }),
        publishAnalysisRevision: async () => ({ projectRevisionId: "projectrevision_forbidden" }),
        resolveBlockedDependencies: async () =>
          dependencyMissing ? [{ id: "dictionary_chords", kind: "dictionary" as const }] : [],
      },
      idFactory: () => "job_dependency_recheck",
      runner: {
        run: async () => {
          runs += 1;
          return new Promise(() => undefined);
        },
      },
      stateRoot,
    });
    await jobs.submit({
      canonicalAudioFingerprint: `sha256:${"a".repeat(64)}`,
      projectId: "project_golden",
      recipe,
      sourceSnapshotId: "snapshot_fixture",
    });

    dependencyMissing = true;
    await expect(jobs.runNext()).resolves.toMatchObject({ state: "blocked" });
    expect(jobs.get("job_dependency_recheck")).toMatchObject({
      attempts: [],
      job: {
        blockedDependencies: [{ id: "dictionary_chords", kind: "dictionary" }],
        state: "blocked",
      },
    });
    expect(runs).toBe(0);
  });

  it("rejects a candidate whose manifest belongs to another Job identity", async () => {
    const stateRoot = await temporaryDirectory();
    let publications = 0;
    const jobs = await openAnalysisJobs({
      authority: {
        getSnapshot: async () => ({
          eventSequence: 1,
          project: structuredClone(goldenProject),
          projectRevisionId: "projectrevision_current",
        }),
        publishAnalysisRevision: async () => {
          publications += 1;
          return { projectRevisionId: "projectrevision_forbidden" };
        },
      },
      idFactory: (() => {
        const ids = ["job_identity", "attempt_identity"];
        return () => ids.shift()!;
      })(),
      runner: {
        run: async (input) => ({
          manifest: {
            attemptId: input.attemptId,
            canonicalAudioFingerprint: input.job.canonicalAudioFingerprint,
            jobKey: `sha256:${"f".repeat(64)}`,
            projectId: input.job.projectId,
            recipeHash: input.job.recipeHash,
            sourceSnapshotId: input.job.sourceSnapshotId,
          },
          revision: structuredClone(goldenProject.analysisRevisions[0]!),
          stageOutcomes: [
            { stage: "preflight", state: "completed" },
            { stage: "canonical_decode", state: "completed" },
            { stage: "shared_features", state: "completed" },
            { stage: "rhythm", state: "completed" },
            { stage: "harmony", state: "completed" },
            { stage: "assemble", state: "completed" },
          ],
        }),
      },
      stateRoot,
    });
    await jobs.submit({
      canonicalAudioFingerprint: `sha256:${"a".repeat(64)}`,
      projectId: "project_golden",
      recipe,
      sourceSnapshotId: "snapshot_fixture",
    });

    await expect(jobs.runNext()).resolves.toMatchObject({ state: "blocked" });
    expect(jobs.get("job_identity").attempts).toMatchObject([
      { failure: { classification: "integrity_violation" }, state: "failed" },
    ]);
    expect(publications).toBe(0);
  });

  it("reconciles a committed candidate when the publication acknowledgement is lost", async () => {
    const stateRoot = await temporaryDirectory();
    const project = structuredClone(goldenProject);
    const jobs = await openAnalysisJobs({
      authority: {
        getSnapshot: async () => ({
          eventSequence: project.analysisRevisions.length,
          project: structuredClone(project),
          projectRevisionId:
            project.analysisRevisions.length > goldenProject.analysisRevisions.length
              ? "projectrevision_committed"
              : "projectrevision_current",
        }),
        publishAnalysisRevision: async ({ revision }) => {
          project.analysisRevisions.push(structuredClone(revision));
          throw new Error("Publication acknowledgement was lost after durable commit");
        },
      },
      idFactory: (() => {
        const ids = ["job_ack", "attempt_ack"];
        return () => ids.shift()!;
      })(),
      runner: {
        run: async () => ({
          revision: structuredClone(goldenProject.analysisRevisions[0]!),
          stageOutcomes: [
            { stage: "preflight", state: "completed" },
            { stage: "canonical_decode", state: "completed" },
            { stage: "shared_features", state: "completed" },
            { stage: "rhythm", state: "completed" },
            { stage: "harmony", state: "completed" },
            { stage: "assemble", state: "completed" },
          ],
        }),
      },
      stateRoot,
    });
    await jobs.submit({
      canonicalAudioFingerprint: `sha256:${"a".repeat(64)}`,
      projectId: "project_golden",
      recipe,
      sourceSnapshotId: "snapshot_fixture",
    });

    await expect(jobs.runNext()).resolves.toMatchObject({ state: "succeeded" });
    expect(jobs.get("job_ack")).toMatchObject({
      attempts: [{ publishedProjectRevisionId: "projectrevision_committed", state: "succeeded" }],
      job: { state: "succeeded" },
    });
  });

  it("persists sleep interruption before abort and requires an explicit retry", async () => {
    const stateRoot = await temporaryDirectory();
    let reportStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      reportStarted = resolve;
    });
    const sleepingRunner: TestRunner = {
      run: async ({ signal }) => {
        reportStarted();
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
        throw new Error("unreachable");
      },
    };
    const ids = ["job_sleep", "attempt_sleep"];
    const jobs = await openAnalysisJobs({
      authority: {
        getSnapshot: async () => ({
          eventSequence: 1,
          project: structuredClone(goldenProject),
          projectRevisionId: "projectrevision_current",
        }),
        publishAnalysisRevision: async () => ({ projectRevisionId: "projectrevision_forbidden" }),
      },
      idFactory: () => ids.shift()!,
      runner: sleepingRunner,
      stateRoot,
    });
    await jobs.submit({
      canonicalAudioFingerprint: `sha256:${"a".repeat(64)}`,
      projectId: "project_golden",
      recipe,
      sourceSnapshotId: "snapshot_fixture",
    });
    const running = jobs.runNext();
    await started;

    await jobs.interruptForSleep();
    const reopened = await openAnalysisJobs({
      authority,
      runner,
      stateRoot,
    });
    expect(reopened.get("job_sleep")).toMatchObject({
      attempts: [{ failure: { classification: "interrupted" }, state: "failed" }],
      job: { state: "retryable" },
    });
    await expect(running).resolves.toMatchObject({ state: "retryable" });
  });

  it("expires failed Attempt evidence and reusable Checkpoints after seven days", async () => {
    const stateRoot = await temporaryDirectory();
    let now = new Date("2026-08-23T12:00:00Z");
    const retentionRunner: TestRunner = {
      run: async (input) => {
        await input.saveCheckpoint({
          artifactHash: `sha256:${"7".repeat(64)}`,
          byteSize: 2048,
          kind: "shared_features",
          stage: "shared_features",
        });
        throw new AnalysisRunError({
          classification: "component_failure",
          message: "Analysis failed after features",
          nextAction: "retry",
          retryable: true,
          stage: "harmony",
        });
      },
    };
    const ids = ["job_retention", "attempt_expiring"];
    const jobs = await openAnalysisJobs({
      authority: {
        getSnapshot: async () => ({
          eventSequence: 1,
          project: structuredClone(goldenProject),
          projectRevisionId: "projectrevision_current",
        }),
        publishAnalysisRevision: async () => ({ projectRevisionId: "projectrevision_forbidden" }),
      },
      idFactory: () => ids.shift()!,
      now: () => now,
      runner: retentionRunner,
      stateRoot,
    });
    const submitted = await jobs.submit({
      canonicalAudioFingerprint: `sha256:${"a".repeat(64)}`,
      projectId: "project_golden",
      recipe,
      sourceSnapshotId: "snapshot_fixture",
    });
    await jobs.runNext();
    expect(jobs.get("job_retention")).toMatchObject({
      attempts: [{ id: "attempt_expiring" }],
      checkpoints: [{ kind: "shared_features" }],
    });

    now = new Date("2026-08-30T12:00:00.001Z");
    await jobs.pruneOperationalEvidence();

    expect(jobs.get("job_retention")).toMatchObject({
      attempts: [],
      checkpoints: [],
      job: { attemptIds: [], recipeHash: submitted.recipeHash, state: "retryable" },
    });
  });

  it("opens the circuit on integrity failure until restart", async () => {
    const stateRoot = await temporaryDirectory();
    let runs = 0;
    const circuitRunner: TestRunner = {
      run: async ({ job }) => {
        runs += 1;
        if (runs === 1) {
          throw new AnalysisRunError({
            classification: "integrity_violation",
            message: "Candidate artifact hash mismatched its declaration",
            nextAction: "retry",
            retryable: true,
            stage: "main_validation",
          });
        }
        return {
          revision: {
            ...structuredClone(goldenProject.analysisRevisions[0]!),
            id: `revision_${job.id}`,
          },
          stageOutcomes: [
            { stage: "preflight", state: "completed" },
            { stage: "canonical_decode", state: "completed" },
            { stage: "shared_features", state: "completed" },
            { stage: "rhythm", state: "completed" },
            { stage: "harmony", state: "completed" },
            { stage: "assemble", state: "completed" },
          ],
        };
      },
    };
    const ids = ["job_integrity", "job_waiting", "attempt_integrity", "attempt_after_restart"];
    const options = {
      authority: {
        getSnapshot: async () => ({
          eventSequence: 1,
          project: structuredClone(goldenProject),
          projectRevisionId: "projectrevision_current",
        }),
        publishAnalysisRevision: async () => ({ projectRevisionId: "projectrevision_next" }),
      },
      idFactory: () => ids.shift()!,
      runner: circuitRunner,
      stateRoot,
    } satisfies Parameters<typeof openAnalysisJobs>[0];
    const jobs = await openAnalysisJobs(options);
    for (const [fingerprint, snapshot] of [
      ["a", "snapshot_integrity"],
      ["b", "snapshot_waiting"],
    ] as const) {
      await jobs.submit({
        canonicalAudioFingerprint: `sha256:${fingerprint.repeat(64)}`,
        projectId: "project_golden",
        recipe,
        sourceSnapshotId: snapshot,
      });
    }

    await jobs.runNext();
    expect(jobs.get("job_integrity")).toMatchObject({
      attempts: [
        { failure: { classification: "integrity_violation", retryable: false }, state: "failed" },
      ],
      job: { state: "blocked" },
    });
    expect(jobs.circuitBreaker()).toMatchObject({ classification: "integrity_violation" });
    await expect(jobs.runNext()).resolves.toBeNull();
    expect(runs).toBe(1);

    const restarted = await openAnalysisJobs(options);
    expect(restarted.circuitBreaker()).toBeNull();
    await restarted.confirmQueued("job_waiting");
    await restarted.runNext();
    expect(runs).toBe(2);
  });

  it("durably reorders queued Jobs without changing their identities", async () => {
    const stateRoot = await temporaryDirectory();
    const runOrder: string[] = [];
    const ids = ["job_first_fifo", "job_promoted", "attempt_promoted"];
    const jobs = await openAnalysisJobs({
      authority: {
        getSnapshot: async () => ({
          eventSequence: 1,
          project: structuredClone(goldenProject),
          projectRevisionId: "projectrevision_current",
        }),
        publishAnalysisRevision: async () => ({ projectRevisionId: "projectrevision_next" }),
      },
      idFactory: () => ids.shift()!,
      runner: {
        run: async ({ job }) => {
          runOrder.push(job.id);
          return {
            revision: {
              ...structuredClone(goldenProject.analysisRevisions[0]!),
              id: `revision_${job.id}`,
            },
            stageOutcomes: [
              { stage: "preflight", state: "completed" },
              { stage: "canonical_decode", state: "completed" },
              { stage: "shared_features", state: "completed" },
              { stage: "rhythm", state: "completed" },
              { stage: "harmony", state: "completed" },
              { stage: "assemble", state: "completed" },
            ],
          };
        },
      },
      stateRoot,
    });
    for (const [fingerprint, snapshot] of [
      ["a", "snapshot_first"],
      ["b", "snapshot_promoted"],
    ] as const) {
      await jobs.submit({
        canonicalAudioFingerprint: `sha256:${fingerprint.repeat(64)}`,
        projectId: "project_golden",
        recipe,
        sourceSnapshotId: snapshot,
      });
    }

    await jobs.moveBefore("job_promoted", "job_first_fifo");
    await jobs.runNext();

    expect(runOrder).toEqual(["job_promoted"]);
    expect(jobs.list().map(({ id }) => id)).toEqual(["job_promoted", "job_first_fifo"]);
  });
});

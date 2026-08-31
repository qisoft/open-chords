import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { materializeEffectiveTimeline, type AnalysisRecipe } from "@open-chords/domain";
import { monoPcmWav } from "@open-chords/testkit/media";
import { afterEach, describe, expect, it } from "vitest";

import {
  createSidecarContainedAnalyzer,
  LocalAnalysisService,
} from "../apps/desktop/src/main/local-analysis.ts";
import { LocalMediaService } from "../apps/desktop/src/main/local-media.ts";
import { openProjectLibrary } from "../apps/desktop/src/main/project-library.ts";
import {
  parseSidecarSessionResult,
  SidecarSessionError,
} from "../apps/desktop/src/main/sidecar-session.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("LocalAnalysisService", () => {
  it("publishes a benchmarkable first Analysis Revision from a verified local file", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "open-chords-local-analysis-")));
    temporaryRoots.push(root);
    const sourcePath = join(root, "source.wav");
    await writeFile(sourcePath, monoPcmWav(Array.from({ length: 48_000 }, () => 0)));
    const library = await openProjectLibrary({ stateRoot: join(root, "library-state") });
    const media = new LocalMediaService({ library, pickFile: async () => sourcePath });
    media.activateGeneration("generation_test");
    const selection = await media.pickLocalFile("generation_test");
    if (selection.kind !== "selected") throw new Error("Fixture selection failed");
    const created = await media.createProject({
      capabilityId: selection.capabilityId,
      endSourceSample: 48_000,
      generationId: "generation_test",
      startSourceSample: 0,
    });
    const ids = ["job_first", "attempt_first"];
    const analysis = await LocalAnalysisService.open({
      analyzer: {
        analyze: async ({ inputPath, recipe: requestedRecipe, reportProgress }) => {
          expect(inputPath).toMatch(
            new RegExp(
              `^${join(root, "analysis-workspaces")}/attempt_(?:first|second)/input/source-media$`,
              "u",
            ),
          );
          expect(requestedRecipe.capabilities).toEqual(recipe.capabilities);
          await reportProgress({ completedFraction: 0.8, elapsedMs: 20, stage: "assemble" });
          return {
            durationSamples: 48_000,
            recipe: requestedRecipe,
            sampleRate: 48_000,
            stageOutcomes: [
              { stage: "preflight", state: "completed" },
              { stage: "canonical_decode", state: "completed" },
              { stage: "shared_features", state: "completed" },
              { stage: "rhythm", state: "completed_with_abstentions" },
              { stage: "harmony", state: "completed_with_abstentions" },
              { stage: "sections", state: "completed_with_abstentions" },
              { stage: "assemble", state: "completed" },
            ],
            supportClaimIds: [],
            timeline: {
              bars: [],
              chordEvents: [
                {
                  assertion: {
                    evidence: [],
                    reasonCodes: ["silence"],
                    state: "abstained",
                  },
                  endSample: 48_000,
                  id: "chord_0000",
                  startSample: 0,
                  value: { kind: "no_chord" },
                },
              ],
              keyRegions: [
                {
                  assertion: {
                    evidence: [],
                    reasonCodes: ["silence"],
                    state: "abstained",
                  },
                  endSample: 48_000,
                  id: "key_0000",
                  startSample: 0,
                  value: { kind: "unknown" },
                },
              ],
              sectionRegions: [
                {
                  assertion: {
                    evidence: [],
                    reasonCodes: ["silence"],
                    state: "abstained",
                  },
                  endSample: 48_000,
                  id: "section_0000",
                  label: "unknown",
                  startSample: 0,
                },
              ],
              unmeteredRegions: [
                {
                  endSample: 48_000,
                  id: "unmetered_0000",
                  reasonCode: "meter_insufficient_evidence",
                  startSample: 0,
                },
              ],
            },
            warnings: ["Input contains no measurable musical evidence"],
          };
        },
        terminateAndWait: async () => undefined,
      },
      idFactory: () => ids.shift()!,
      library,
      media,
      stateRoot: join(root, "analysis-state"),
      workspaceRoot: join(root, "analysis-workspaces"),
    });

    const completed = await analysis.analyzeProject({ projectId: created.projectId, recipe });

    expect(completed.job.state).toBe("succeeded");
    expect(completed.attempts).toMatchObject([{ id: "attempt_first", state: "succeeded" }]);
    const snapshot = await library.getSnapshot(created.projectId);
    expect(snapshot?.project.analysisRevisions).toHaveLength(1);
    expect(snapshot?.project.activeView?.analysisRevisionId).toBe(
      snapshot?.project.analysisRevisions[0]?.id,
    );
    expect(snapshot?.project.analysisRevisions[0]?.supportClaimIds).toEqual([]);
    expect(snapshot?.project.activeView).toMatchObject({ editHistoryPosition: 0 });
    if (snapshot === null) throw new Error("Published Project snapshot is missing");
    const effectiveTimeline = materializeEffectiveTimeline(snapshot.project);
    expect(effectiveTimeline.chordEvents).toHaveLength(1);
    expect(effectiveTimeline.chordEvents[0]).toMatchObject({
      assertion: { reasonCodes: ["silence"], state: "abstained" },
      endSample: 48_000,
      startSample: 0,
    });
    const persisted = await library.readProject(created.projectId);
    expect(persisted.records.analysisManifests).toHaveLength(1);
    expect(persisted.records.analysisManifests[0]?.manifest.warnings).toEqual([
      "Input contains no measurable musical evidence",
    ]);

    const firstRevisionId = snapshot?.project.analysisRevisions[0]?.id;
    ids.push("job_second", "attempt_second");
    const secondRecipe: AnalysisRecipe = {
      ...recipe,
      profile: {
        hash: `sha256:${"4".repeat(64)}`,
        id: "fast",
        name: "fast",
        version: "1.0.0",
      },
    };
    const reviewable = await analysis.analyzeProject({
      projectId: created.projectId,
      recipe: secondRecipe,
    });
    const afterReviewable = await library.getSnapshot(created.projectId);

    expect(reviewable.job.state).toBe("succeeded");
    expect(afterReviewable?.project.analysisRevisions).toHaveLength(2);
    expect(afterReviewable?.project.activeView?.analysisRevisionId).toBe(firstRevisionId);
    expect(afterReviewable?.project.editLayers).toHaveLength(1);
  });

  it("publishes nothing when the contained analyzer returns a malformed timeline", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "open-chords-invalid-analysis-")));
    temporaryRoots.push(root);
    const sourcePath = join(root, "source.wav");
    await writeFile(sourcePath, monoPcmWav(Array.from({ length: 48_000 }, () => 0)));
    const library = await openProjectLibrary({ stateRoot: join(root, "library-state") });
    const media = new LocalMediaService({ library, pickFile: async () => sourcePath });
    media.activateGeneration("generation_test");
    const selection = await media.pickLocalFile("generation_test");
    if (selection.kind !== "selected") throw new Error("Fixture selection failed");
    const created = await media.createProject({
      capabilityId: selection.capabilityId,
      endSourceSample: 48_000,
      generationId: "generation_test",
      startSourceSample: 0,
    });
    const ids = ["job_invalid", "attempt_invalid"];
    const analysis = await LocalAnalysisService.open({
      analyzer: {
        analyze: async () => ({
          durationSamples: 48_000,
          recipe,
          sampleRate: 48_000,
          stageOutcomes: [
            { stage: "preflight", state: "completed" },
            { stage: "canonical_decode", state: "completed" },
            { stage: "shared_features", state: "completed" },
            { stage: "rhythm", state: "completed" },
            { stage: "harmony", state: "completed" },
            { stage: "sections", state: "completed" },
            { stage: "assemble", state: "completed" },
          ],
          supportClaimIds: [],
          timeline: {},
          warnings: [],
        }),
        terminateAndWait: async () => undefined,
      },
      idFactory: () => ids.shift()!,
      library,
      media,
      stateRoot: join(root, "analysis-state"),
      workspaceRoot: join(root, "analysis-workspaces"),
    });

    const completed = await analysis.analyzeProject({ projectId: created.projectId, recipe });

    expect(completed).toMatchObject({
      attempts: [
        {
          failure: { classification: "invalid_output", stage: "main_validation" },
          state: "failed",
        },
      ],
      job: { state: "blocked" },
    });
    expect((await library.getSnapshot(created.projectId))?.project.analysisRevisions).toEqual([]);
  });

  it("blocks a changed Source before DSP and publishes nothing", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "open-chords-changed-analysis-")));
    temporaryRoots.push(root);
    const sourcePath = join(root, "source.wav");
    await writeFile(sourcePath, monoPcmWav(Array.from({ length: 48_000 }, () => 0)));
    const library = await openProjectLibrary({ stateRoot: join(root, "library-state") });
    const media = new LocalMediaService({ library, pickFile: async () => sourcePath });
    media.activateGeneration("generation_test");
    const selection = await media.pickLocalFile("generation_test");
    if (selection.kind !== "selected") throw new Error("Fixture selection failed");
    const created = await media.createProject({
      capabilityId: selection.capabilityId,
      endSourceSample: 48_000,
      generationId: "generation_test",
      startSourceSample: 0,
    });
    await writeFile(sourcePath, monoPcmWav(Array.from({ length: 48_000 }, () => 1)));
    const ids = ["job_changed", "attempt_changed"];
    const analysis = await LocalAnalysisService.open({
      analyzer: {
        analyze: async () => {
          throw new Error("DSP must not receive changed media");
        },
        terminateAndWait: async () => undefined,
      },
      idFactory: () => ids.shift()!,
      library,
      media,
      stateRoot: join(root, "analysis-state"),
      workspaceRoot: join(root, "analysis-workspaces"),
    });

    const completed = await analysis.analyzeProject({ projectId: created.projectId, recipe });

    expect(completed).toMatchObject({
      attempts: [
        {
          failure: { classification: "blocked_input", stage: "preflight" },
          state: "failed",
        },
      ],
      job: { state: "retryable" },
    });
    expect((await library.getSnapshot(created.projectId))?.project.analysisRevisions).toEqual([]);
  });

  it("persists cancellation before terminating analysis and publishes nothing", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "open-chords-cancel-analysis-")));
    temporaryRoots.push(root);
    const sourcePath = join(root, "source.wav");
    await writeFile(sourcePath, monoPcmWav(Array.from({ length: 48_000 }, () => 0)));
    const library = await openProjectLibrary({ stateRoot: join(root, "library-state") });
    const media = new LocalMediaService({ library, pickFile: async () => sourcePath });
    media.activateGeneration("generation_test");
    const selection = await media.pickLocalFile("generation_test");
    if (selection.kind !== "selected") throw new Error("Fixture selection failed");
    const created = await media.createProject({
      capabilityId: selection.capabilityId,
      endSourceSample: 48_000,
      generationId: "generation_test",
      startSourceSample: 0,
    });
    let reportStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      reportStarted = resolve;
    });
    const terminations: string[] = [];
    const ids = ["job_cancel", "attempt_cancel"];
    const analysis = await LocalAnalysisService.open({
      analyzer: {
        analyze: async ({ signal }) => {
          reportStarted();
          return new Promise((_, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        },
        terminateAndWait: async ({ attemptId }) => {
          terminations.push(attemptId);
        },
      },
      idFactory: () => ids.shift()!,
      library,
      media,
      stateRoot: join(root, "analysis-state"),
      workspaceRoot: join(root, "analysis-workspaces"),
    });
    const submitted = await analysis.submitProject({ projectId: created.projectId, recipe });
    const running = analysis.runNext();
    await started;

    await analysis.cancel(submitted.id);
    await expect(running).resolves.toMatchObject({ state: "cancelled" });

    expect(analysis.get(submitted.id)).toMatchObject({
      attempts: [{ failure: { classification: "cancelled" }, state: "cancelled" }],
      job: { state: "cancelled" },
    });
    expect(terminations).toEqual(["attempt_cancel"]);
    expect((await library.getSnapshot(created.projectId))?.project.analysisRevisions).toEqual([]);
  });

  it.each([
    [new SidecarSessionError("timeout", "fixture timeout"), "deadline", "preflight"],
    [new SidecarSessionError("unexpected_eof", "fixture crash"), "component_failure", "preflight"],
    [
      new SidecarSessionError("launch_failure", "fixture containment failure", {
        remoteCode: "native_containment_denied",
      }),
      "containment_violation",
      "preflight",
    ],
    [
      new SidecarSessionError("remote_failure", "fixture analysis failure", {
        remoteCode: "analysis_failed",
      }),
      "component_failure",
      "shared_features",
    ],
  ] as const)(
    "maps %s to a stable %s Analysis Failure",
    async (sidecarFailure, classification, stage) => {
      const workspace = await realpath(
        await mkdtemp(join(tmpdir(), "open-chords-sidecar-failure-")),
      );
      temporaryRoots.push(workspace);
      const inputPath = join(workspace, "input", "source-media");
      await mkdir(join(workspace, "input"), { recursive: true });
      await writeFile(inputPath, monoPcmWav([0, 0, 0, 0]));
      const analyzer = createSidecarContainedAnalyzer({
        clientForWorkspace: () => ({
          dispose: async () => undefined,
          runSession: async () => {
            throw sidecarFailure;
          },
        }),
        idFactory: () => "fixture",
        runtimeManifestHash: "a".repeat(64),
      });

      await expect(
        analyzer.analyze({
          attemptId: "attempt_fixture",
          inputPath,
          jobId: "job_fixture",
          recipe,
          reportProgress: async () => undefined,
          signal: new AbortController().signal,
        }),
      ).rejects.toMatchObject({ failure: { classification, stage } });
    },
  );

  it("accepts only the hash-matched analysis artifact from the sidecar workspace", async () => {
    const workspace = await realpath(
      await mkdtemp(join(tmpdir(), "open-chords-sidecar-analysis-")),
    );
    temporaryRoots.push(workspace);
    const inputPath = join(workspace, "input", "source-media");
    await mkdir(join(workspace, "input"), { recursive: true });
    await writeFile(inputPath, monoPcmWav([0, 0, 0, 0]));
    let disposed = 0;
    const candidate = {
      durationSamples: 4,
      recipe,
      sampleRate: 48_000,
      stageOutcomes: [
        { stage: "preflight", state: "completed" as const },
        { stage: "canonical_decode", state: "completed" as const },
        { stage: "shared_features", state: "completed" as const },
        { stage: "rhythm", state: "completed_with_abstentions" as const },
        { stage: "harmony", state: "completed_with_abstentions" as const },
        { stage: "sections", state: "completed_with_abstentions" as const },
        { stage: "assemble", state: "completed" as const },
      ],
      supportClaimIds: [],
      timeline: {},
      warnings: [],
    };
    const analyzer = createSidecarContainedAnalyzer({
      clientForWorkspace: () => ({
        dispose: async () => {
          disposed += 1;
        },
        runSession: async (request) => {
          expect(
            JSON.parse(await readFile(join(workspace, "input", "analysis-recipe.json"), "utf8")),
          ).toEqual(recipe);
          const bytes = Buffer.from(JSON.stringify(candidate));
          const resultPath = join(workspace, "artifacts", "analysis-result.json");
          await mkdir(join(workspace, "artifacts"));
          await writeFile(resultPath, bytes);
          return parseSidecarSessionResult({
            artifact: {
              byteSize: bytes.byteLength,
              path: "artifacts/analysis-result.json",
              sha256: createHash("sha256").update(bytes).digest("hex"),
            },
            jobId: request.jobId,
            nonce: request.nonce,
            requestId: request.requestId,
            sequence: 1,
            type: "result",
          });
        },
      }),
      idFactory: () => "fixture",
      runtimeManifestHash: "a".repeat(64),
    });

    const result = await analyzer.analyze({
      attemptId: "attempt_fixture",
      inputPath,
      jobId: "job_fixture",
      recipe,
      reportProgress: async () => undefined,
      signal: new AbortController().signal,
    });

    expect(result).toEqual(candidate);
    expect(disposed).toBe(1);
  });
});

const recipe: AnalysisRecipe = {
  capabilities: ["rhythm", "meter", "key", "chords", "sections"],
  components: [
    {
      hash: `sha256:${"1".repeat(64)}`,
      id: "open-chords-cpu-dsp",
      version: "1.0.0",
    },
  ],
  numericalBackend: {
    hash: `sha256:${"2".repeat(64)}`,
    id: "numpy",
    version: "2.5.2",
  },
  pipeline: [
    "preflight",
    "canonical_decode",
    "shared_features",
    "rhythm",
    "harmony",
    "sections",
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
  seeds: { decoder: 0 },
  settings: { analysisWindowSamples: 96_000, hopLength: 1_024, nFft: 8_192 },
};

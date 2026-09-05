import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  canonicalSerialize,
  materializeEffectiveTimeline,
  type AnalysisRecipe,
} from "@open-chords/domain";

import { createSidecarContainedAnalyzer, LocalAnalysisService } from "./local-analysis.ts";
import { LocalMediaService } from "./local-media.ts";
import { openProjectLibrary } from "./project-library.ts";
import type { SidecarClient } from "./sidecar-session.ts";

export async function runPackagedAnalysisPublicationProof(options: {
  clientForWorkspace: (workspace: string) => SidecarClient;
  fixture: Buffer;
  recipe: AnalysisRecipe;
  runtimeManifestHash: string;
  workspaceRoot: string;
}): Promise<void> {
  // Library and Source belong to main, outside the disposable AppContainer root.
  const mainRoot = await realpath(await mkdtemp(join(tmpdir(), "open-chords-publication-proof-")));
  try {
    const sourcePath = join(mainRoot, "source.wav");
    await writeFile(sourcePath, options.fixture);
    const library = await openProjectLibrary({ stateRoot: join(mainRoot, "library") });
    const media = new LocalMediaService({ library, pickFile: async () => sourcePath });
    const generationId = "generation_packaged_publication";
    media.activateGeneration(generationId);
    const selected = await media.pickLocalFile(generationId);
    if (selected.kind !== "selected") throw new Error("Publication proof could not select fixture");
    const { projectId } = await media.createProject({
      capabilityId: selected.capabilityId,
      endSourceSample: 4_800,
      generationId,
      startSourceSample: 0,
    });
    process.stderr.write("Packaged publication proof stage: project_created\n");
    const analysis = await LocalAnalysisService.open({
      analyzer: createSidecarContainedAnalyzer(options),
      attemptTimeoutMs: 120_000,
      library,
      media,
      stateRoot: join(mainRoot, "analysis"),
      workspaceRoot: options.workspaceRoot,
    });
    process.stderr.write("Packaged publication proof stage: service_opened\n");
    const submitted = await analysis.submitProject({ projectId, recipe: options.recipe });
    process.stderr.write(`Packaged publication proof stage: job_submitted_${submitted.state}\n`);
    if (submitted.state === "queued") await analysis.runNext();
    const first = analysis.get(submitted.id);
    if (first.job.state !== "succeeded") {
      process.stderr.write(
        `Packaged publication proof job: ${first.job.state}.${first.attempts.at(-1)?.failure?.classification ?? "none"}\n`,
      );
      throw new Error("Publication proof did not complete the first Analysis Job");
    }
    process.stderr.write("Packaged publication proof stage: first_job_completed\n");
    const snapshot = await library.getSnapshot(projectId);
    if (
      snapshot === null ||
      snapshot.project.analysisRevisions.length !== 1 ||
      snapshot.project.activeView?.analysisRevisionId !== first.job.publishedAnalysisRevisionId
    ) {
      throw new Error("Publication proof did not activate exactly one immutable Revision");
    }
    const firstRevision = canonicalSerialize(snapshot.project.analysisRevisions[0]);
    const firstActiveView = canonicalSerialize(snapshot.project.activeView);
    const timeline = materializeEffectiveTimeline(snapshot.project);
    if (timeline.chordEvents.length === 0 || timeline.sectionRegions.length === 0) {
      throw new Error("Publication proof did not materialize the Effective Timeline");
    }
    const records = (await library.readProject(projectId)).records;
    if (
      records.analysisManifests.length !== 1 ||
      canonicalSerialize(records.analysisManifests[0]!.manifest.recipe) !==
        canonicalSerialize(options.recipe) ||
      snapshot.project.analysisRevisions[0]!.supportClaimIds.length !== 0
    ) {
      throw new Error("Publication proof did not retain Recipe and Manifest without claims");
    }
    const firstManifest = canonicalSerialize(records.analysisManifests[0]);
    process.stderr.write("Packaged publication proof stage: first_revision_verified\n");
    // Same CPU settings, distinct versioned profile: a new Job and Revision.
    const laterRecipe: AnalysisRecipe = {
      ...options.recipe,
      profile: { ...options.recipe.profile, id: "balanced", name: "balanced" },
    };
    const second = await analysis.analyzeProject({ projectId, recipe: laterRecipe });
    const later = await library.getSnapshot(projectId);
    if (
      second.job.state !== "succeeded" ||
      later === null ||
      later.project.analysisRevisions.length !== 2 ||
      canonicalSerialize(later.project.analysisRevisions[0]) !== firstRevision ||
      canonicalSerialize(later.project.activeView) !== firstActiveView ||
      later.project.editLayers.length !== snapshot.project.editLayers.length
    ) {
      throw new Error("Publication proof did not preserve a Reviewable later Revision");
    }
    const retained = (await library.readProject(projectId)).records.analysisManifests;
    if (retained.length !== 2 || canonicalSerialize(retained[0]) !== firstManifest) {
      throw new Error("Publication proof mutated the first immutable Manifest");
    }
  } finally {
    await rm(mainRoot, { force: true, recursive: true });
  }
}

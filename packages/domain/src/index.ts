import { resolvePracticeLoop } from "./practice.ts";
export {
  AlignmentRecipeSchema,
  AlignmentProvenanceSchema,
  LyricsAnchorSchema,
  resolveLyricsAnchors,
  type LyricsAnchor,
  type AlignmentRecipe,
} from "./alignment.ts";
export {
  EditHistoryActionSchema,
  EditMappingActionSchema,
  reviewEditMapping,
  type EditHistoryAction,
  type EditMappingConflict,
} from "./edit-history.ts";
export { canonicalSerialize } from "./canonical.ts";
export {
  ANALYSIS_CAPABILITY_STAGES,
  ANALYSIS_MAIN_STAGES,
  ANALYSIS_PIPELINE_STAGES,
  ANALYSIS_RUNNER_PREFIX_STAGES,
  ANALYSIS_RUNNER_SUFFIX_STAGES,
  AnalysisCandidateIdentitySchema,
  AnalysisManifestSchema,
  AnalysisPipelineStageSchema,
  AnalysisRecipeSchema,
  AnalysisStageOutcomeSchema,
  analysisPipelineForCapabilities,
  analysisRunnerPipelineForCapabilities,
  canonicalAnalysisManifestContent,
  canonicalAnalysisOutputContents,
  canonicalAnalysisRecipeContent,
  validateAnalysisManifestProvenance,
  type AnalysisCandidateIdentity,
  type AnalysisManifest,
  type AnalysisRecipe,
} from "./analysis.ts";
export { materializeEffectiveTimeline, type EffectiveTimeline } from "./projection.ts";
export {
  AnalysisRevisionSchema,
  EditTransactionSchema,
  MusicalTimelineSchema,
  ProjectContractSchema,
  StableIdSchema,
  type AnalysisRevision,
  type EditTransaction,
  type LyricsAlignment,
  type LyricsDocument,
  type MusicalTimeline,
  type ProjectContract,
} from "./schema.ts";

import { validateProjectInvariants, validateTimelineInvariants } from "./invariants.ts";
import {
  materializeEffectiveTimeline,
  validateCommittedEditLayerProjections,
} from "./projection.ts";
import {
  MusicalTimelineSchema,
  ProjectContractSchema,
  type MusicalTimeline,
  type ProjectContract,
} from "./schema.ts";

export function parseAnalysisTimeline(input: unknown, durationSamples: number): MusicalTimeline {
  if (!Number.isSafeInteger(durationSamples) || durationSamples <= 0) {
    throw new Error("Analysis Timeline duration must be a positive safe integer");
  }
  const timeline = MusicalTimelineSchema.parse(input);
  validateTimelineInvariants(timeline, durationSamples);
  return timeline;
}

export function parseProjectContract(input: unknown): ProjectContract {
  const project = ProjectContractSchema.parse(input);
  const [major] = project.schemaVersion.split(".").map(Number);
  if (major !== 1) throw new Error(`Unsupported Project contract major version ${String(major)}`);
  validateProjectInvariants(project);
  validateCommittedEditLayerProjections(project);
  if (project.activeView !== null) materializeEffectiveTimeline(project);
  if (project.practice?.loop?.status === "ready" && resolvePracticeLoop(project) === null)
    throw new Error("Ready practice loop must reference contiguous active Bars");
  return project;
}
export {
  applyPracticeAction,
  getPracticeState,
  resolvePracticeLoop,
  PracticeActionSchema,
  type PracticeAction,
  type PracticeState,
} from "./practice.ts";
export { reconcilePracticeState } from "./practice.ts";
export { presentChord, capoGuidance, pitchClassNumber } from "./presentation.ts";
export { chordDiagram, type ChordDiagram } from "./diagrams.ts";
export { practiceCountIn, practiceNavigation } from "./practice.ts";
export {
  addLyricsDocument,
  LyricsInputSchema,
  type LyricsInput,
  type LyricsOrigin,
} from "./lyrics.ts";

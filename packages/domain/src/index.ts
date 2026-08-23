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
  canonicalAnalysisManifestContent,
  canonicalAnalysisOutputContents,
  canonicalAnalysisRecipeContent,
  type AnalysisManifest,
  type AnalysisRecipe,
} from "./analysis.ts";
export { materializeEffectiveTimeline, type EffectiveTimeline } from "./projection.ts";
export {
  AnalysisRevisionSchema,
  EditTransactionSchema,
  ProjectContractSchema,
  StableIdSchema,
  type AnalysisRevision,
  type EditTransaction,
  type LyricsAlignment,
  type ProjectContract,
} from "./schema.ts";

import { validateProjectInvariants } from "./invariants.ts";
import {
  materializeEffectiveTimeline,
  validateCommittedEditLayerProjections,
} from "./projection.ts";
import { ProjectContractSchema, type ProjectContract } from "./schema.ts";

export function parseProjectContract(input: unknown): ProjectContract {
  const project = ProjectContractSchema.parse(input);
  const [major] = project.schemaVersion.split(".").map(Number);
  if (major !== 1) throw new Error(`Unsupported Project contract major version ${String(major)}`);
  validateProjectInvariants(project);
  validateCommittedEditLayerProjections(project);
  if (project.activeView !== null) materializeEffectiveTimeline(project);
  return project;
}

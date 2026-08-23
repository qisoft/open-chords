import { z } from "zod";

import { canonicalSerialize } from "./canonical.ts";
import { type AnalysisRevision } from "./schema.ts";

const Sha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);

export const ANALYSIS_RUNNER_PREFIX_STAGES = [
  "preflight",
  "canonical_decode",
  "shared_features",
] as const;
export const ANALYSIS_CAPABILITY_STAGES = ["rhythm", "harmony", "sections"] as const;
export const ANALYSIS_RUNNER_SUFFIX_STAGES = ["assemble"] as const;
export const ANALYSIS_MAIN_STAGES = ["main_validation", "publish"] as const;
export const ANALYSIS_PIPELINE_STAGES = [
  ...ANALYSIS_RUNNER_PREFIX_STAGES,
  ...ANALYSIS_CAPABILITY_STAGES,
  ...ANALYSIS_RUNNER_SUFFIX_STAGES,
  ...ANALYSIS_MAIN_STAGES,
] as const;

export const AnalysisPipelineStageSchema = z.enum(ANALYSIS_PIPELINE_STAGES);
const VersionedComponentSchema = z.strictObject({
  hash: Sha256Schema,
  id: z.string().min(1),
  version: z.string().min(1),
});

export const AnalysisRecipeSchema = z
  .strictObject({
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
    pipeline: z.array(AnalysisPipelineStageSchema),
    profile: VersionedComponentSchema.extend({
      name: z.enum(["eco", "balanced", "fast"]),
    }),
    seeds: z.record(z.string().min(1), z.number().int()),
    settings: z.record(z.string().min(1), z.union([z.boolean(), z.number().finite(), z.string()])),
  })
  .superRefine((recipe, context) => {
    const expected = analysisPipelineForCapabilities(recipe.capabilities);
    if (
      recipe.pipeline.length !== expected.length ||
      recipe.pipeline.some((stage, index) => stage !== expected[index])
    ) {
      context.addIssue({
        code: "custom",
        message: `Pipeline must be ${expected.join(" -> ")} for the requested capabilities`,
        path: ["pipeline"],
      });
    }
  });

export const AnalysisStageOutcomeSchema = z.strictObject({
  stage: AnalysisPipelineStageSchema,
  state: z.enum(["completed", "completed_with_abstentions"]),
});

export const AnalysisCandidateIdentitySchema = z.strictObject({
  attemptId: z.string().min(1),
  canonicalAudioFingerprint: Sha256Schema,
  jobKey: Sha256Schema,
  projectId: z.string().min(1),
  recipeHash: Sha256Schema,
  sourceIdentityKind: z.enum(["canonical_audio", "source_snapshot"]),
  sourceSnapshotId: z.string().min(1),
});

export const AnalysisManifestSchema = z.strictObject({
  acceptedOutputHashes: z.strictObject({
    supportClaimIds: Sha256Schema,
    timeline: Sha256Schema,
  }),
  candidateIdentity: AnalysisCandidateIdentitySchema,
  format: z.literal("open-chords/analysis-manifest"),
  recipe: AnalysisRecipeSchema,
  reproducibilityConditions: z.strictObject({
    componentHashes: z.array(Sha256Schema).min(1),
    numericalBackendHash: Sha256Schema,
    profileHash: Sha256Schema,
    seedsHash: Sha256Schema,
    settingsHash: Sha256Schema,
  }),
  stageOutcomes: z.array(AnalysisStageOutcomeSchema),
  warnings: z.array(z.string().min(1).max(512)).max(100),
});

export type AnalysisManifest = z.infer<typeof AnalysisManifestSchema>;
export type AnalysisRecipe = z.infer<typeof AnalysisRecipeSchema>;

export function analysisPipelineForCapabilities(
  capabilities: readonly AnalysisRecipe["capabilities"][number][],
): Array<z.infer<typeof AnalysisPipelineStageSchema>> {
  const requested = new Set(capabilities);
  const capabilityStages = ANALYSIS_CAPABILITY_STAGES.filter(
    (stage) =>
      (stage === "rhythm" && (requested.has("rhythm") || requested.has("meter"))) ||
      (stage === "harmony" && (requested.has("key") || requested.has("chords"))) ||
      (stage === "sections" && requested.has("sections")),
  );
  return [
    ...ANALYSIS_RUNNER_PREFIX_STAGES,
    ...capabilityStages,
    ...ANALYSIS_RUNNER_SUFFIX_STAGES,
    ...ANALYSIS_MAIN_STAGES,
  ];
}

export function canonicalAnalysisManifestContent(manifest: AnalysisManifest): string {
  return canonicalSerialize(AnalysisManifestSchema.parse(manifest));
}

export function canonicalAnalysisRecipeContent(recipe: AnalysisRecipe): string {
  return canonicalSerialize(AnalysisRecipeSchema.parse(recipe));
}

export function canonicalAnalysisOutputContents(revision: AnalysisRevision): {
  supportClaimIds: string;
  timeline: string;
} {
  return {
    supportClaimIds: canonicalSerialize(revision.supportClaimIds),
    timeline: canonicalSerialize(revision.timeline),
  };
}

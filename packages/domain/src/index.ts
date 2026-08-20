export { canonicalSerialize } from "./canonical.ts";
export { materializeEffectiveTimeline, type EffectiveTimeline } from "./projection.ts";
export { ProjectContractSchema, type LyricsAlignment, type ProjectContract } from "./schema.ts";

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
  materializeEffectiveTimeline(project);
  return project;
}

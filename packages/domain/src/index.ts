export { canonicalSerialize } from "./canonical.ts";
export { materializeEffectiveTimeline, type EffectiveTimeline } from "./projection.ts";
export { ProjectContractSchema, type LyricsAlignment, type ProjectContract } from "./schema.ts";

import { validateProjectInvariants } from "./invariants.ts";
import { materializeEffectiveTimeline } from "./projection.ts";
import { ProjectContractSchema, type ProjectContract } from "./schema.ts";

export function parseProjectContract(input: unknown): ProjectContract {
  const project = ProjectContractSchema.parse(input);
  const [major] = project.schemaVersion.split(".").map(Number);
  if (major !== 1) throw new Error(`Unsupported Project contract major version ${String(major)}`);
  validateProjectInvariants(project);
  for (const layer of project.editLayers) {
    for (
      let editHistoryPosition = 0;
      editHistoryPosition <= layer.transactions.length;
      editHistoryPosition += 1
    ) {
      const alignments = project.lyricsAlignments.filter(
        ({ analysisRevisionId }) => analysisRevisionId === layer.analysisRevisionId,
      );
      for (const alignment of [undefined, ...alignments]) {
        materializeEffectiveTimeline({
          ...project,
          activeView: {
            ...project.activeView,
            analysisRevisionId: layer.analysisRevisionId,
            editHistoryPosition,
            editLayerId: layer.id,
            lyricsAlignmentId: alignment?.id,
            lyricsDocumentId: alignment?.lyricsDocumentId,
          },
        });
      }
    }
  }
  materializeEffectiveTimeline(project);
  return project;
}

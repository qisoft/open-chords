import { z } from "zod";

import { StableIdSchema, type EditTransaction, type ProjectContract } from "./schema.ts";

export const EditMappingActionSchema = z.strictObject({
  type: z.literal("map_edits"),
  sourceEditLayerId: StableIdSchema,
  sourceHistoryPosition: z.number().int().positive(),
  targetAnalysisRevisionId: StableIdSchema,
  mappings: z
    .array(z.strictObject({ sourceId: StableIdSchema, targetId: StableIdSchema }))
    .max(10_000),
});
export const EditHistoryActionSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("undo") }),
  z.strictObject({ type: z.literal("redo"), transactionId: StableIdSchema }),
  z.strictObject({ type: z.literal("reset") }),
  EditMappingActionSchema,
]);
export type EditHistoryAction = z.infer<typeof EditHistoryActionSchema>;
export type EditMappingConflict = { sourceId: string; message: string };

/** Review is explicit: even an identical stable ID requires a supplied mapping. */
export function reviewEditMapping(
  project: ProjectContract,
  action: z.infer<typeof EditMappingActionSchema>,
) {
  const conflicts: EditMappingConflict[] = [];
  const requirements = new Map<string, { sourceId: string; targetIds: string[] }>();
  const source = project.editLayers.find(({ id }) => id === action.sourceEditLayerId);
  const target = project.analysisRevisions.find(({ id }) => id === action.targetAnalysisRevisionId);
  const operations: EditTransaction["operations"] = [];
  if (
    source === undefined ||
    target === undefined ||
    source.analysisRevisionId === target.id ||
    action.sourceHistoryPosition < 1 ||
    action.sourceHistoryPosition > source.transactions.length
  ) {
    return {
      conflicts: [
        {
          sourceId: action.sourceEditLayerId,
          message: "Choose a saved history position and a different Analysis Revision.",
        },
      ],
      operations,
      requirements: [],
    };
  }
  const mapping = new Map(action.mappings.map(({ sourceId, targetId }) => [sourceId, targetId]));
  if (mapping.size !== action.mappings.length || new Set(mapping.values()).size !== mapping.size)
    conflicts.push({ sourceId: source.id, message: "Mappings must be one-to-one." });
  const map = (sourceId: string, targets: readonly { id: string }[]) => {
    const targetIds = targets.map(({ id }) => id);
    requirements.set(sourceId, { sourceId, targetIds });
    const targetId = mapping.get(sourceId);
    if (targetId === undefined || !targetIds.includes(targetId))
      conflicts.push({
        sourceId,
        message: "Choose a matching entity in the target Analysis Revision.",
      });
    return targetId ?? sourceId;
  };
  const chain: EditTransaction[] = [];
  let selected = source.transactions[action.sourceHistoryPosition - 1];
  while (selected !== undefined) {
    chain.unshift(selected);
    const parentId = selected.parentTransactionId;
    selected = source.transactions.find(({ id }) => id === parentId);
  }
  for (const transaction of chain)
    for (const original of transaction.operations) {
      const operation = structuredClone(original);
      switch (operation.type) {
        case "replace_chord_value":
          operation.eventId = map(operation.eventId, target.timeline.chordEvents);
          break;
        case "replace_chord_sequence":
          operation.targetEventIds = operation.targetEventIds.map((id) =>
            map(id, target.timeline.chordEvents),
          );
          operation.events = operation.events.map((event) => ({
            ...event,
            id: map(event.id, target.timeline.chordEvents),
          }));
          break;
        case "move_chord_boundary":
          operation.leftEventId = map(operation.leftEventId, target.timeline.chordEvents);
          operation.rightEventId = map(operation.rightEventId, target.timeline.chordEvents);
          break;
        case "move_beat":
          operation.beatId = map(
            operation.beatId,
            target.timeline.bars.flatMap(({ beats }) => beats),
          );
          break;
        case "set_bar_meter":
          operation.barId = map(operation.barId, target.timeline.bars);
          break;
        case "move_bar_boundary":
          operation.leftBarId = map(operation.leftBarId, target.timeline.bars);
          operation.rightBarId = map(operation.rightBarId, target.timeline.bars);
          break;
        case "replace_section_label":
          operation.regionId = map(operation.regionId, target.timeline.sectionRegions);
          break;
        default:
          conflicts.push({
            sourceId: transaction.id,
            message: "This structural or lyrics edit requires a separate manual review.",
          });
      }
      operations.push(operation);
    }
  for (const sourceId of mapping.keys())
    if (!requirements.has(sourceId))
      conflicts.push({ sourceId, message: "Mapping does not belong to the selected edits." });
  return { conflicts, operations, requirements: [...requirements.values()] };
}

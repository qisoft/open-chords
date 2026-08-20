import { validateLyricsAlignmentInvariants, validateTimelineInvariants } from "./invariants.ts";
import type { LyricsAlignment, MusicalTimeline, ProjectContract } from "./schema.ts";

export type EffectiveTimeline = MusicalTimeline & {
  analysisRevisionId: string;
  editLayerId: string;
  lyricsAlignment?: LyricsAlignment;
};

type EditOperation =
  ProjectContract["editLayers"][number]["transactions"][number]["operations"][number];

function applyOperation(
  timeline: MusicalTimeline,
  lyricsAlignment: LyricsAlignment | undefined,
  operation: EditOperation,
): void {
  if (operation.type === "replace_chord_value") {
    const event = timeline.chordEvents.find(({ id }) => id === operation.eventId);
    if (event === undefined)
      throw new Error(`Edit references unknown Chord Event ${operation.eventId}`);
    event.value = structuredClone(operation.value);
    event.assertion = { evidence: [], reasonCodes: ["user_authored"], state: "asserted" };
  } else if (operation.type === "replace_section_label") {
    const region = timeline.sectionRegions.find(({ id }) => id === operation.regionId);
    if (region === undefined)
      throw new Error(`Edit references unknown Section Region ${operation.regionId}`);
    region.label = operation.label;
    region.assertion = { evidence: [], reasonCodes: ["user_authored"], state: "asserted" };
  } else if (operation.type === "move_chord_boundary") {
    const leftIndex = timeline.chordEvents.findIndex(({ id }) => id === operation.leftEventId);
    const rightIndex = timeline.chordEvents.findIndex(({ id }) => id === operation.rightEventId);
    if (leftIndex < 0 || rightIndex !== leftIndex + 1)
      throw new Error("Boundary edit must name adjacent Chord Events");
    const left = timeline.chordEvents[leftIndex];
    const right = timeline.chordEvents[rightIndex];
    if (left === undefined || right === undefined)
      throw new Error("Boundary edit references are missing");
    left.endSample = operation.atSample;
    right.startSample = operation.atSample;
  } else if (operation.type === "move_beat") {
    const beat = timeline.bars
      .flatMap(({ beats }) => beats)
      .find(({ id }) => id === operation.beatId);
    if (beat === undefined) throw new Error(`Edit references unknown Beat ${operation.beatId}`);
    beat.atSample = operation.atSample;
  } else if (operation.type === "move_bar_boundary") {
    const leftIndex = timeline.bars.findIndex(({ id }) => id === operation.leftBarId);
    const rightIndex = timeline.bars.findIndex(({ id }) => id === operation.rightBarId);
    if (leftIndex < 0 || rightIndex !== leftIndex + 1)
      throw new Error("Bar boundary edit must name adjacent Bars");
    const left = timeline.bars[leftIndex];
    const right = timeline.bars[rightIndex];
    if (left === undefined || right === undefined)
      throw new Error("Bar boundary references are missing");
    left.endSample = operation.atSample;
    right.startSample = operation.atSample;
    const downbeat = right.beats[0];
    if (downbeat === undefined) throw new Error("Right Bar has no downbeat");
    downbeat.atSample = operation.atSample;
  } else if (operation.type === "set_bar_meter") {
    const bar = timeline.bars.find(({ id }) => id === operation.barId);
    if (bar === undefined) throw new Error(`Edit references unknown Bar ${operation.barId}`);
    bar.meter = structuredClone(operation.meter);
  } else if (operation.type === "split_bar") {
    const index = timeline.bars.findIndex(({ id }) => id === operation.barId);
    const bar = timeline.bars[index];
    if (bar === undefined) throw new Error(`Edit references unknown Bar ${operation.barId}`);
    const originalEnd = bar.endSample;
    if (bar.beats.some(({ atSample }) => atSample === operation.atSample))
      throw new Error(`Split point collides with an existing Beat in ${bar.id}`);
    const rightBeats = bar.beats.filter(({ atSample }) => atSample > operation.atSample);
    bar.beats = bar.beats.filter(({ atSample }) => atSample < operation.atSample);
    bar.endSample = operation.atSample;
    bar.status = operation.leftStatus;
    timeline.bars.splice(index + 1, 0, {
      beats: [
        { atSample: operation.atSample, id: operation.newDownbeatId, role: "downbeat" },
        ...rightBeats.map((beat) => ({ ...beat, role: "beat" as const })),
      ],
      endSample: originalEnd,
      id: operation.newBarId,
      meter: structuredClone(operation.rightMeter),
      startSample: operation.atSample,
      status: operation.rightStatus,
    });
  } else if (operation.type === "merge_bars") {
    const leftIndex = timeline.bars.findIndex(({ id }) => id === operation.leftBarId);
    const rightIndex = timeline.bars.findIndex(({ id }) => id === operation.rightBarId);
    if (leftIndex < 0 || rightIndex !== leftIndex + 1)
      throw new Error("Merge edit must name adjacent Bars");
    const left = timeline.bars[leftIndex];
    const right = timeline.bars[rightIndex];
    if (left === undefined || right === undefined)
      throw new Error("Merge Bar references are missing");
    left.endSample = right.endSample;
    left.beats.push(...right.beats.map((beat) => ({ ...beat, role: "beat" as const })));
    left.meter = structuredClone(operation.meter);
    left.status = operation.status;
    timeline.bars.splice(rightIndex, 1);
  } else if (operation.type === "set_lyrics_timing") {
    if (lyricsAlignment?.id !== operation.alignmentId) return;
    const occurrence = lyricsAlignment.occurrences.find(
      ({ tokenId }) => tokenId === operation.tokenId,
    );
    if (occurrence === undefined)
      throw new Error(`Edit references unknown Lyrics Token Occurrence ${operation.tokenId}`);
    occurrence.timing = structuredClone(operation.timing);
  } else if (operation.type === "set_lyrics_line_timing") {
    if (lyricsAlignment?.id !== operation.alignmentId) return;
    const occurrence = lyricsAlignment.lineOccurrences.find(
      ({ lineId }) => lineId === operation.lineId,
    );
    if (occurrence === undefined)
      throw new Error(`Edit references unknown Lyrics Line Occurrence ${operation.lineId}`);
    occurrence.timing = structuredClone(operation.timing);
  }
}

export function materializeEffectiveTimeline(project: ProjectContract): EffectiveTimeline {
  const revision = project.analysisRevisions.find(
    ({ id }) => id === project.activeView.analysisRevisionId,
  );
  const layer = project.editLayers.find(({ id }) => id === project.activeView.editLayerId);
  if (revision === undefined || layer === undefined)
    throw new Error("Active View references were not validated");

  const timeline = structuredClone(revision.timeline);
  const selectedAlignment = project.lyricsAlignments.find(
    ({ id }) => id === project.activeView.lyricsAlignmentId,
  );
  const lyricsAlignment =
    selectedAlignment === undefined ? undefined : structuredClone(selectedAlignment);
  const transactions: (typeof layer.transactions)[number][] = [];
  let selected = layer.transactions[project.activeView.editHistoryPosition - 1];
  const byId = new Map(layer.transactions.map((transaction) => [transaction.id, transaction]));
  while (selected !== undefined) {
    transactions.unshift(selected);
    selected =
      selected.parentTransactionId === null ? undefined : byId.get(selected.parentTransactionId);
  }
  for (const transaction of transactions) {
    for (const operation of transaction.operations) {
      applyOperation(timeline, lyricsAlignment, operation);
    }
  }

  validateTimelineInvariants(timeline, project.durationSamples);
  if (lyricsAlignment !== undefined) {
    const lyricsDocument = project.lyricsDocuments.find(
      ({ id }) => id === lyricsAlignment.lyricsDocumentId,
    );
    if (lyricsDocument === undefined)
      throw new Error("Lyrics Alignment document was not validated");
    validateLyricsAlignmentInvariants(lyricsAlignment, lyricsDocument, project.durationSamples);
  }
  const effective = {
    ...timeline,
    analysisRevisionId: revision.id,
    editLayerId: layer.id,
  };
  return lyricsAlignment === undefined ? effective : { ...effective, lyricsAlignment };
}

type CommittedProjectionState = {
  lyricsAlignments: LyricsAlignment[];
  timeline: MusicalTimeline;
};

export function validateCommittedEditLayerProjections(project: ProjectContract): void {
  const documents = new Map(project.lyricsDocuments.map((document) => [document.id, document]));
  for (const layer of project.editLayers) {
    const revision = project.analysisRevisions.find(({ id }) => id === layer.analysisRevisionId);
    if (revision === undefined) throw new Error("Edit Layer revision was not validated");
    const initial: CommittedProjectionState = {
      lyricsAlignments: structuredClone(
        project.lyricsAlignments.filter(
          ({ analysisRevisionId }) => analysisRevisionId === layer.analysisRevisionId,
        ),
      ),
      timeline: structuredClone(revision.timeline),
    };
    const projections = new Map<string, CommittedProjectionState>();
    for (const transaction of layer.transactions) {
      const parent =
        transaction.parentTransactionId === null
          ? initial
          : projections.get(transaction.parentTransactionId);
      if (parent === undefined) throw new Error("Edit transaction parent was not validated");
      const projection = structuredClone(parent);
      for (const operation of transaction.operations) {
        const alignment =
          operation.type === "set_lyrics_timing" || operation.type === "set_lyrics_line_timing"
            ? projection.lyricsAlignments.find(({ id }) => id === operation.alignmentId)
            : undefined;
        if (
          (operation.type === "set_lyrics_timing" || operation.type === "set_lyrics_line_timing") &&
          alignment === undefined
        ) {
          throw new Error(`Edit references unknown Lyrics Alignment ${operation.alignmentId}`);
        }
        applyOperation(projection.timeline, alignment, operation);
      }
      validateTimelineInvariants(projection.timeline, project.durationSamples);
      for (const alignment of projection.lyricsAlignments) {
        const document = documents.get(alignment.lyricsDocumentId);
        if (document === undefined) throw new Error("Lyrics Alignment document was not validated");
        validateLyricsAlignmentInvariants(alignment, document, project.durationSamples);
      }
      projections.set(transaction.id, projection);
    }
  }
}

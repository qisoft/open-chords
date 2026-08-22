import type {
  LyricsAlignment,
  LyricsDocument,
  MusicalTimeline,
  ProjectContract,
} from "./schema.ts";

export class DomainInvariantError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Domain invariants failed:\n${issues.map((issue) => `- ${issue}`).join("\n")}`);
    this.name = "DomainInvariantError";
    this.issues = issues;
  }
}

type Interval = { endSample: number; id: string; startSample: number };

function validateUniqueIds(
  items: readonly { id: string }[],
  label: string,
  issues: string[],
): void {
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.id)) issues.push(`${label} contains duplicate id ${item.id}`);
    seen.add(item.id);
  }
}

function validateCover(
  track: readonly Interval[],
  duration: number,
  label: string,
  issues: string[],
): void {
  if (track.length === 0) {
    issues.push(`${label} must cover the Project Range`);
    return;
  }
  let cursor = 0;
  for (const item of track) {
    if (item.endSample <= item.startSample)
      issues.push(`${label} ${item.id} must be half-open with start < end`);
    if (item.startSample < cursor)
      issues.push(`${label} ${item.id} overlaps the preceding interval`);
    if (item.startSample > cursor) issues.push(`${label} has a gap before ${item.id}`);
    cursor = Math.max(cursor, item.endSample);
  }
  if (cursor !== duration) issues.push(`${label} must end at Project duration ${String(duration)}`);
}

function validateOrdered(track: readonly Interval[], label: string, issues: string[]): void {
  for (let index = 1; index < track.length; index += 1) {
    const left = track[index - 1];
    const right = track[index];
    if (left !== undefined && right !== undefined && left.startSample >= right.startSample) {
      issues.push(`${label} is not in stable Project Time order`);
    }
  }
}

function validateSortedUnique(values: readonly string[], label: string, issues: string[]): void {
  for (let index = 1; index < values.length; index += 1) {
    const left = values[index - 1];
    const right = values[index];
    if (left !== undefined && right !== undefined && left >= right)
      issues.push(`${label} must be sorted and unique`);
  }
}

export function validateTimelineInvariants(timeline: MusicalTimeline, duration: number): void {
  const issues: string[] = [];
  validateUniqueIds(timeline.bars, "bars", issues);
  validateUniqueIds(timeline.unmeteredRegions, "unmetered regions", issues);
  validateUniqueIds(timeline.chordEvents, "chord events", issues);
  validateUniqueIds(timeline.sectionRegions, "section regions", issues);
  validateUniqueIds(timeline.keyRegions, "key regions", issues);
  validateUniqueIds(
    timeline.bars.flatMap(({ beats }) => beats),
    "beats in timeline",
    issues,
  );
  validateOrdered(timeline.bars, "bars", issues);
  validateOrdered(timeline.unmeteredRegions, "unmetered regions", issues);
  validateCover(timeline.chordEvents, duration, "chord track", issues);
  validateCover(timeline.sectionRegions, duration, "section track", issues);
  validateCover(timeline.keyRegions, duration, "key track", issues);
  validateCover(
    [...timeline.bars, ...timeline.unmeteredRegions].toSorted(
      (left, right) => left.startSample - right.startSample || left.id.localeCompare(right.id),
    ),
    duration,
    "metered/unmetered track",
    issues,
  );

  for (const bar of timeline.bars) {
    validateUniqueIds(bar.beats, `beats in ${bar.id}`, issues);
    bar.beats.forEach((beat, index) => {
      if (beat.atSample < bar.startSample || beat.atSample >= bar.endSample) {
        issues.push(`beat ${beat.id} lies outside ${bar.id}`);
      }
      if (index === 0 && beat.role !== "downbeat")
        issues.push(`${bar.id} must start with a downbeat`);
      if (index === 0 && beat.atSample !== bar.startSample)
        issues.push(`${bar.id} downbeat must equal the Bar start`);
      if (index > 0 && beat.role !== "beat") issues.push(`${bar.id} has a non-initial downbeat`);
      if (index > 0 && beat.atSample <= (bar.beats[index - 1]?.atSample ?? -1)) {
        issues.push(`beats in ${bar.id} are not strictly ordered`);
      }
    });
    if (bar.status === "complete" && bar.beats.length !== bar.meter.numerator) {
      issues.push(`complete ${bar.id} must contain ${String(bar.meter.numerator)} beats`);
    }
    if (bar.beats.length > bar.meter.numerator)
      issues.push(`${bar.id} cannot contain more beats than its meter numerator`);
  }

  for (const event of timeline.chordEvents) {
    if (event.value.kind === "chord") {
      validateSortedUnique(event.value.additions, `${event.id} additions`, issues);
      validateSortedUnique(event.value.alterations, `${event.id} alterations`, issues);
      validateSortedUnique(event.value.extensions, `${event.id} extensions`, issues);
      validateSortedUnique(event.value.omissions, `${event.id} omissions`, issues);
    }
  }

  if (issues.length > 0) throw new DomainInvariantError(issues);
}

function validateLyricsTimingSequence(
  occurrences: readonly { timing: LyricsAlignment["occurrences"][number]["timing"] }[],
  durationSamples: number,
  label: string,
  issues: string[],
): void {
  let cursor = 0;
  for (const occurrence of occurrences) {
    if (occurrence.timing.state !== "matched") continue;
    if (occurrence.timing.startSample < cursor) issues.push(`${label} timings are not monotonic`);
    if (occurrence.timing.endSample <= occurrence.timing.startSample)
      issues.push(`${label} has an empty timing`);
    if (occurrence.timing.endSample > durationSamples)
      issues.push(`${label} timing exceeds the Project Range`);
    cursor = occurrence.timing.endSample;
  }
}

export function validateLyricsAlignmentInvariants(
  alignment: LyricsAlignment,
  document: LyricsDocument,
  durationSamples: number,
): void {
  const issues: string[] = [];
  const expectedTokenIds = document.tokens.map(({ id }) => id);
  const actualTokenIds = alignment.occurrences.map(({ tokenId }) => tokenId);
  if (
    expectedTokenIds.length !== actualTokenIds.length ||
    expectedTokenIds.some((id, index) => actualTokenIds[index] !== id)
  ) {
    issues.push(`${alignment.id} must align every Lyrics Token Occurrence exactly once in order`);
  }
  const expectedLineIds = document.lines.map(({ id }) => id);
  const actualLineIds = alignment.lineOccurrences.map(({ lineId }) => lineId);
  if (
    expectedLineIds.length !== actualLineIds.length ||
    expectedLineIds.some((id, index) => actualLineIds[index] !== id)
  ) {
    issues.push(`${alignment.id} must align every Lyrics Line Occurrence exactly once in order`);
  }
  validateLyricsTimingSequence(
    alignment.occurrences,
    durationSamples,
    `${alignment.id} token`,
    issues,
  );
  validateLyricsTimingSequence(
    alignment.lineOccurrences,
    durationSamples,
    `${alignment.id} line`,
    issues,
  );
  if (issues.length > 0) throw new DomainInvariantError(issues);
}

export function validateProjectInvariants(project: ProjectContract): void {
  const issues: string[] = [];
  validateUniqueIds(project.analysisRevisions, "analysis revisions", issues);
  validateUniqueIds(project.editLayers, "edit layers", issues);
  validateUniqueIds(project.lyricsDocuments, "lyrics documents", issues);
  validateUniqueIds(project.lyricsAlignments, "lyrics alignments", issues);
  validateUniqueIds(project.supportClaims, "support claims", issues);

  const revisionIds = new Set(project.analysisRevisions.map(({ id }) => id));
  const editLayers = new Map(project.editLayers.map((layer) => [layer.id, layer]));
  const documents = new Map(project.lyricsDocuments.map((document) => [document.id, document]));
  const alignments = new Map(
    project.lyricsAlignments.map((alignment) => [alignment.id, alignment]),
  );
  const supportClaims = new Set(project.supportClaims.map(({ id }) => id));

  for (const revision of project.analysisRevisions) {
    if (revision.projectId !== project.id) issues.push(`${revision.id} belongs to another Project`);
    for (const claimId of revision.supportClaimIds) {
      if (!supportClaims.has(claimId))
        issues.push(`${revision.id} references unknown Support Claim ${claimId}`);
    }
    try {
      validateTimelineInvariants(revision.timeline, project.durationSamples);
    } catch (error) {
      if (error instanceof DomainInvariantError)
        issues.push(...error.issues.map((issue) => `${revision.id}: ${issue}`));
      else throw error;
    }
  }

  for (const layer of project.editLayers) {
    if (!revisionIds.has(layer.analysisRevisionId))
      issues.push(`${layer.id} references unknown Analysis Revision`);
    validateUniqueIds(layer.transactions, `transactions in ${layer.id}`, issues);
    const precedingTransactions = new Set<string>();
    for (const transaction of layer.transactions) {
      if (
        transaction.parentTransactionId !== null &&
        !precedingTransactions.has(transaction.parentTransactionId)
      ) {
        issues.push(`${transaction.id} parent must be an earlier transaction in ${layer.id}`);
      }
      precedingTransactions.add(transaction.id);
      for (const operation of transaction.operations) {
        if (operation.type === "set_lyrics_timing" || operation.type === "set_lyrics_line_timing") {
          const alignment = alignments.get(operation.alignmentId);
          if (alignment === undefined) {
            issues.push(`${transaction.id} references unknown Lyrics Alignment`);
          } else {
            if (alignment.analysisRevisionId !== layer.analysisRevisionId)
              issues.push(
                `${transaction.id} Lyrics Alignment belongs to another Analysis Revision`,
              );
            if (
              operation.type === "set_lyrics_timing" &&
              !alignment.occurrences.some(({ tokenId }) => tokenId === operation.tokenId)
            )
              issues.push(`${transaction.id} references unknown Lyrics Token Occurrence`);
            if (
              operation.type === "set_lyrics_line_timing" &&
              !alignment.lineOccurrences.some(({ lineId }) => lineId === operation.lineId)
            )
              issues.push(`${transaction.id} references unknown Lyrics Line Occurrence`);
          }
        }
      }
    }
  }

  if (project.activeView === null) {
    if (project.analysisRevisions.length !== 0 || project.editLayers.length !== 0) {
      issues.push("A Project without an Active View must not contain analysis or edit revisions");
    }
    if (project.lyricsDocuments.length !== 0 || project.lyricsAlignments.length !== 0) {
      issues.push("A Project without an Active View must not contain lyrics records");
    }
  } else {
    const activeLayer = editLayers.get(project.activeView.editLayerId);
    if (!revisionIds.has(project.activeView.analysisRevisionId))
      issues.push("Active View references unknown Analysis Revision");
    if (activeLayer === undefined) issues.push("Active View references unknown Edit Layer");
    else {
      if (activeLayer.analysisRevisionId !== project.activeView.analysisRevisionId) {
        issues.push("Active View Analysis Revision and Edit Layer base do not match");
      }
      if (project.activeView.editHistoryPosition > activeLayer.transactions.length) {
        issues.push("Active View history position is outside committed Edit Layer history");
      }
    }

    if (
      (project.activeView.lyricsDocumentId === undefined) !==
      (project.activeView.lyricsAlignmentId === undefined)
    ) {
      issues.push("Active View must select Lyrics Document and Lyrics Alignment together");
    }
    if (
      project.activeView.lyricsDocumentId !== undefined &&
      !documents.has(project.activeView.lyricsDocumentId)
    ) {
      issues.push("Active View references unknown Lyrics Document");
    }
    if (
      project.activeView.lyricsAlignmentId !== undefined &&
      !alignments.has(project.activeView.lyricsAlignmentId)
    ) {
      issues.push("Active View references unknown Lyrics Alignment");
    }
  }

  for (const alignment of project.lyricsAlignments) {
    const document = documents.get(alignment.lyricsDocumentId);
    if (!revisionIds.has(alignment.analysisRevisionId))
      issues.push(`${alignment.id} references unknown Analysis Revision`);
    if (document === undefined) {
      issues.push(`${alignment.id} references unknown Lyrics Document`);
      continue;
    }
    try {
      validateLyricsAlignmentInvariants(alignment, document, project.durationSamples);
    } catch (error) {
      if (error instanceof DomainInvariantError) issues.push(...error.issues);
      else throw error;
    }
  }

  for (const document of project.lyricsDocuments) {
    validateUniqueIds(document.lines, `lines in ${document.id}`, issues);
    validateUniqueIds(document.tokens, `tokens in ${document.id}`, issues);
    const lineIds = new Set(document.lines.map(({ id }) => id));
    let lineOffset = 0;
    for (const line of document.lines) {
      if (
        line.startOffset < lineOffset ||
        line.endOffset <= line.startOffset ||
        line.endOffset > document.text.length
      ) {
        issues.push(`lines in ${document.id} are invalid or unstably ordered`);
      }
      lineOffset = line.endOffset;
    }
    let offset = 0;
    for (const token of document.tokens) {
      if (!lineIds.has(token.lineId)) issues.push(`${token.id} references unknown lyric line`);
      if (
        token.startOffset < offset ||
        token.endOffset <= token.startOffset ||
        token.endOffset > document.text.length
      ) {
        issues.push(`tokens in ${document.id} are invalid or unstably ordered`);
      }
      if (document.text.slice(token.startOffset, token.endOffset) !== token.text) {
        issues.push(`${token.id} does not map back to immutable Lyrics Document text`);
      }
      offset = token.endOffset;
    }
  }

  if (project.activeView?.lyricsAlignmentId !== undefined) {
    const alignment = alignments.get(project.activeView.lyricsAlignmentId);
    if (
      alignment !== undefined &&
      (alignment.analysisRevisionId !== project.activeView.analysisRevisionId ||
        alignment.lyricsDocumentId !== project.activeView.lyricsDocumentId)
    ) {
      issues.push(
        "Active View Lyrics Alignment does not belong to its selected Document and Analysis Revision",
      );
    }
  }

  if (issues.length > 0) throw new DomainInvariantError(issues);
}

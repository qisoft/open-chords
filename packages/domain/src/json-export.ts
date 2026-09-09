import { z } from "zod";

import {
  AlignmentProvenanceSchema,
  LyricsAnchorSchema,
  resolveLyricsAnchors,
} from "./alignment.ts";
import { canonicalSerialize } from "./canonical.ts";
import {
  validateProjectInvariants,
  validateTimelineInvariants,
  validateLyricsAlignmentInvariants,
} from "./invariants.ts";
import { capoGuidance, presentChord } from "./presentation.ts";
import {
  materializeEffectiveTimeline,
  validateCommittedEditLayerProjections,
} from "./projection.ts";
import {
  ActiveViewSchema,
  ChordValueSchema,
  LyricsAlignmentSchema,
  LyricsDocumentSchema,
  MusicalTimelineSchema,
  ProjectContractSchema,
  StableIdSchema,
  SupportClaimSchema,
} from "./schema.ts";

export const JsonExportOptionsSchema = z.strictObject({
  presentation: z.enum(["current", "original"]),
});
export const JsonExportProfileSchema = z.strictObject({
  id: z.literal("open_chords_json"),
  version: z.literal("1.0"),
  presentation: z.enum(["current", "original"]),
});
const safeReference = z
  .string()
  .regex(/^(user_supplied|lrclib:[0-9]+|youtube:[A-Za-z0-9_-]{11}:[A-Za-z0-9-]+)$/);
const documentSchema = LyricsDocumentSchema.extend({
  provenance: z.strictObject({
    provider: z.enum(["user", "lrclib", "youtube_human", "youtube_automatic", "unknown"]),
    reference: safeReference.optional(),
  }),
});
const alignmentSchema = LyricsAlignmentSchema.extend({
  provenance: AlignmentProvenanceSchema.omit({ recipe: true }).optional(),
});
function portableAlignment(alignment: z.infer<typeof LyricsAlignmentSchema>) {
  const { provenance, ...semantic } = alignment;
  return {
    ...semantic,
    ...(provenance
      ? {
          provenance: {
            recipeHash: provenance.recipeHash,
            resultHash: provenance.resultHash,
            qualityStatus: provenance.qualityStatus,
          },
        }
      : {}),
  };
}
const supportReferenceSchema = z.discriminatedUnion("evidenceStatus", [
  SupportClaimSchema.options[0].pick({
    id: true,
    capability: true,
    evidenceStatus: true,
    benchmarkPolicyHash: true,
    benchmarkRunHash: true,
  }),
  SupportClaimSchema.options[1].pick({
    id: true,
    capability: true,
    evidenceStatus: true,
    benchmarkPolicyHash: true,
  }),
]);
export const OpenChordsJsonSnapshotSchema = z.strictObject({
  format: z.literal("open-chords/json-snapshot"),
  schemaVersion: z.literal("1.0"),
  profile: JsonExportProfileSchema,
  project: z.strictObject({
    id: StableIdSchema,
    sampleRate: ProjectContractSchema.shape.sampleRate,
    durationSamples: ProjectContractSchema.shape.durationSamples,
  }),
  selection: ActiveViewSchema.omit({ editHistoryPosition: true, presentation: true }),
  presentation: ActiveViewSchema.shape.presentation.extend({
    instrument: z.enum(["guitar", "ukulele", "piano"]),
    capoGuidance: z.string().nullable(),
  }),
  original: MusicalTimelineSchema,
  effectiveTimeline: MusicalTimelineSchema,
  presentedChords: z.array(z.strictObject({ eventId: StableIdSchema, value: ChordValueSchema })),
  lyrics: z
    .strictObject({
      document: documentSchema,
      originalAlignment: alignmentSchema.optional(),
      effectiveAlignment: alignmentSchema.optional(),
    })
    .optional(),
  provenance: z.strictObject({
    analysisRevisionId: StableIdSchema,
    createdAt: z.iso.datetime({ offset: true }),
    manifestHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    supportClaimReferences: z.array(supportReferenceSchema),
  }),
  userAuthorship: z.strictObject({
    entityIds: z.array(StableIdSchema),
    lyricsAnchors: z.array(LyricsAnchorSchema),
  }),
  omissions: z.array(
    z.enum([
      "unrecognized_lyrics_reference_omitted",
      "unrecognized_lyrics_provider_omitted",
      "support_claim_descriptions_omitted",
      "alignment_recipe_omitted",
    ]),
  ),
});
export type OpenChordsJsonSnapshot = z.infer<typeof OpenChordsJsonSnapshotSchema>;

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export function captureJsonExport(input: unknown, options: unknown): OpenChordsJsonSnapshot {
  const project = ProjectContractSchema.parse(input);
  if (project.schemaVersion.split(".")[0] !== "1") throw new Error("Unsupported Project version");
  validateProjectInvariants(project);
  validateCommittedEditLayerProjections(project);
  const profile = {
    id: "open_chords_json",
    version: "1.0",
    ...JsonExportOptionsSchema.parse(options),
  } as const;
  const active = project.activeView;
  if (!active) throw new Error("Export requires a committed Active View");
  const revision = project.analysisRevisions.find(({ id }) => id === active.analysisRevisionId)!;
  const {
    analysisRevisionId: _revisionId,
    editLayerId: _layerId,
    lyricsAlignment,
    ...effectiveTimeline
  } = materializeEffectiveTimeline(project);
  const { editHistoryPosition: _position, presentation: current, ...selection } = active;
  const instrument = project.practice?.instrument ?? "guitar";
  const transforms =
    profile.presentation === "current"
      ? current
      : { beginnerView: false, enharmonicPreference: "contextual" as const, transposeSemitones: 0 };
  const presentation = {
    ...transforms,
    instrument,
    capoGuidance: capoGuidance(transforms.transposeSemitones, instrument),
  };
  const omissions: OpenChordsJsonSnapshot["omissions"] = [];
  const selectedDocument = project.lyricsDocuments.find(({ id }) => id === active.lyricsDocumentId);
  let lyrics: OpenChordsJsonSnapshot["lyrics"];
  if (selectedDocument) {
    const provider = documentSchema.shape.provenance.shape.provider.safeParse(
      selectedDocument.provenance.provider,
    );
    const reference = safeReference.safeParse(selectedDocument.provenance.reference);
    if (!provider.success) omissions.push("unrecognized_lyrics_provider_omitted");
    if (!reference.success) omissions.push("unrecognized_lyrics_reference_omitted");
    lyrics = {
      document: {
        ...selectedDocument,
        provenance: {
          provider: provider.success ? provider.data : "unknown",
          ...(reference.success ? { reference: reference.data } : {}),
        },
      },
      ...(lyricsAlignment
        ? {
            originalAlignment: portableAlignment(
              project.lyricsAlignments.find(({ id }) => id === active.lyricsAlignmentId)!,
            ),
            effectiveAlignment: portableAlignment(lyricsAlignment),
          }
        : {}),
    };
  }
  const supportClaimReferences = project.supportClaims
    .filter(({ id }) => revision.supportClaimIds.includes(id))
    .map((claim) => ({
      id: claim.id,
      capability: claim.capability,
      evidenceStatus: claim.evidenceStatus,
      benchmarkPolicyHash: claim.benchmarkPolicyHash,
      ...(claim.evidenceStatus === "supported" ? { benchmarkRunHash: claim.benchmarkRunHash } : {}),
    }));
  if (supportClaimReferences.length > 0) omissions.push("support_claim_descriptions_omitted");
  if (lyrics?.originalAlignment?.provenance || lyrics?.effectiveAlignment?.provenance)
    omissions.push("alignment_recipe_omitted");
  const retainedIds = semanticEntityIds(effectiveTimeline, lyrics?.document);
  const snapshot = OpenChordsJsonSnapshotSchema.parse({
    format: "open-chords/json-snapshot",
    schemaVersion: "1.0",
    profile,
    project: {
      id: project.id,
      sampleRate: project.sampleRate,
      durationSamples: project.durationSamples,
    },
    selection,
    presentation,
    original: revision.timeline,
    effectiveTimeline,
    presentedChords: effectiveTimeline.chordEvents.map(({ id, value }) => ({
      eventId: id,
      value: presentChord(value, transforms),
    })),
    ...(lyrics ? { lyrics } : {}),
    provenance: {
      analysisRevisionId: revision.id,
      createdAt: revision.createdAt,
      manifestHash: revision.manifestHash,
      supportClaimReferences,
    },
    userAuthorship: {
      entityIds: authoredEntities(project).filter((id) => retainedIds.has(id)),
      lyricsAnchors: resolveLyricsAnchors(project).filter(
        (anchor) => anchor.lyricsDocumentId === active.lyricsDocumentId,
      ),
    },
    omissions,
  });
  return freeze(parseJsonExport(snapshot));
}

export function parseJsonExport(input: unknown): OpenChordsJsonSnapshot {
  const snapshot = OpenChordsJsonSnapshotSchema.parse(input);
  if (snapshot.selection.analysisRevisionId !== snapshot.provenance.analysisRevisionId)
    throw new Error("Export Analysis Revision mismatch");
  if (
    snapshot.profile.presentation === "original" &&
    (snapshot.presentation.beginnerView ||
      snapshot.presentation.transposeSemitones !== 0 ||
      snapshot.presentation.enharmonicPreference !== "contextual")
  )
    throw new Error("Original presentation contains transforms");
  if (
    snapshot.presentation.capoGuidance !==
    capoGuidance(snapshot.presentation.transposeSemitones, snapshot.presentation.instrument)
  )
    throw new Error("Export capo guidance mismatch");
  if (Boolean(snapshot.lyrics?.originalAlignment) !== Boolean(snapshot.lyrics?.effectiveAlignment))
    throw new Error("Export requires both alignment views");
  const expectedChords = snapshot.effectiveTimeline.chordEvents.map(({ id, value }) => ({
    eventId: id,
    value: presentChord(value, {
      beginnerView: snapshot.presentation.beginnerView,
      enharmonicPreference: snapshot.presentation.enharmonicPreference,
      transposeSemitones: snapshot.presentation.transposeSemitones,
    }),
  }));
  if (canonicalSerialize(expectedChords) !== canonicalSerialize(snapshot.presentedChords))
    throw new Error("Export presentation mismatch");
  if (
    Boolean(snapshot.selection.lyricsDocumentId) !== Boolean(snapshot.lyrics) ||
    (snapshot.lyrics && snapshot.lyrics.document.id !== snapshot.selection.lyricsDocumentId)
  )
    throw new Error("Export Lyrics Document mismatch");
  if (
    Boolean(snapshot.selection.lyricsAlignmentId) !== Boolean(snapshot.lyrics?.effectiveAlignment)
  )
    throw new Error("Export Lyrics Alignment selection mismatch");
  validateTimelineInvariants(snapshot.original, snapshot.project.durationSamples);
  validateTimelineInvariants(snapshot.effectiveTimeline, snapshot.project.durationSamples);
  if (snapshot.lyrics) {
    // The public document has only a narrowed provenance reference; timing semantics are unchanged.
    const document = {
      ...snapshot.lyrics.document,
      provenance: {
        provider: snapshot.lyrics.document.provenance.provider,
        reference: snapshot.lyrics.document.provenance.reference ?? "omitted",
      },
    };
    for (const records of [document.lines, document.tokens]) {
      if (new Set(records.map(({ id }) => id)).size !== records.length)
        throw new Error("Duplicate lyric occurrence");
      let end = 0;
      for (const record of records) {
        if (
          record.startOffset < end ||
          record.endOffset <= record.startOffset ||
          record.endOffset > document.text.length
        )
          throw new Error("Invalid lyric occurrence offsets");
        end = record.endOffset;
      }
    }
    for (const token of document.tokens)
      if (
        !document.lines.some(({ id }) => id === token.lineId) ||
        document.text.slice(token.startOffset, token.endOffset) !== token.text
      )
        throw new Error("Lyric occurrence does not match source text");
    for (const alignment of [snapshot.lyrics.originalAlignment, snapshot.lyrics.effectiveAlignment])
      if (alignment) {
        if (
          alignment.id !== snapshot.selection.lyricsAlignmentId ||
          alignment.analysisRevisionId !== snapshot.selection.analysisRevisionId ||
          alignment.lyricsDocumentId !== document.id
        )
          throw new Error("Export Lyrics Alignment scope mismatch");
        const { provenance: _provenance, ...timing } = alignment;
        validateLyricsAlignmentInvariants(timing, document, snapshot.project.durationSamples);
      }
  }
  const retainedIds = semanticEntityIds(snapshot.effectiveTimeline, snapshot.lyrics?.document);
  if (
    new Set(snapshot.userAuthorship.entityIds).size !== snapshot.userAuthorship.entityIds.length ||
    snapshot.userAuthorship.entityIds.some((id) => !retainedIds.has(id))
  )
    throw new Error("Export authorship references an unknown entity");
  const anchors = snapshot.userAuthorship.lyricsAnchors;
  const tokens = snapshot.lyrics?.document.tokens ?? [];
  if (new Set(anchors.map(({ id }) => id)).size !== anchors.length)
    throw new Error("Duplicate export anchor");
  const positions = new Map(tokens.map(({ id }, index) => [id, index]));
  for (const anchor of anchors) {
    const first = positions.get(anchor.firstTokenId) ?? -1;
    const last = positions.get(anchor.lastTokenId) ?? -1;
    if (
      anchor.lyricsDocumentId !== snapshot.selection.lyricsDocumentId ||
      anchor.analysisRevisionId !== snapshot.selection.analysisRevisionId ||
      first < 0 ||
      last < first ||
      anchor.startSample >= anchor.endSample ||
      anchor.endSample > snapshot.project.durationSamples
    )
      throw new Error("Export anchor scope or interval is invalid");
  }
  const ordered = anchors.toSorted(
    (a, b) => positions.get(a.firstTokenId)! - positions.get(b.firstTokenId)!,
  );
  for (let index = 1; index < ordered.length; index++) {
    const previous = ordered[index - 1]!;
    const current = ordered[index]!;
    if (
      positions.get(previous.lastTokenId)! >= positions.get(current.firstTokenId)! ||
      previous.endSample > current.startSample
    )
      throw new Error("Export anchors conflict");
  }
  return snapshot;
}

function semanticEntityIds(
  timeline: z.infer<typeof MusicalTimelineSchema>,
  document?: z.infer<typeof documentSchema>,
): Set<string> {
  return new Set(
    [
      ...timeline.chordEvents,
      ...timeline.bars,
      ...timeline.bars.flatMap(({ beats }) => beats),
      ...timeline.keyRegions,
      ...timeline.sectionRegions,
      ...timeline.unmeteredRegions,
      ...(document?.tokens ?? []),
      ...(document?.lines ?? []),
    ].map(({ id }) => id),
  );
}

function authoredEntities(project: z.infer<typeof ProjectContractSchema>): string[] {
  const active = project.activeView!;
  const layer = project.editLayers.find(({ id }) => id === active.editLayerId)!;
  const byId = new Map(layer.transactions.map((transaction) => [transaction.id, transaction]));
  const touched = new Set<string>();
  let transaction = layer.transactions[active.editHistoryPosition - 1];
  while (transaction) {
    for (const operation of transaction.operations) {
      switch (operation.type) {
        case "replace_chord_value":
          touched.add(operation.eventId);
          break;
        case "replace_chord_sequence":
          for (const id of operation.targetEventIds) touched.add(id);
          break;
        case "move_chord_boundary":
          touched.add(operation.leftEventId);
          touched.add(operation.rightEventId);
          break;
        case "move_beat":
          touched.add(operation.beatId);
          break;
        case "move_bar_boundary":
        case "merge_bars":
          touched.add(operation.leftBarId);
          touched.add(operation.rightBarId);
          break;
        case "set_bar_meter":
          touched.add(operation.barId);
          break;
        case "split_bar":
          touched.add(operation.barId);
          touched.add(operation.newBarId);
          touched.add(operation.newDownbeatId);
          break;
        case "replace_section_label":
          touched.add(operation.regionId);
          break;
        case "set_lyrics_timing":
          if (operation.alignmentId === active.lyricsAlignmentId) touched.add(operation.tokenId);
          break;
        case "set_lyrics_line_timing":
          if (operation.alignmentId === active.lyricsAlignmentId) touched.add(operation.lineId);
          break;
        case "set_lyrics_anchor":
        case "remove_lyrics_anchor":
          break;
      }
    }
    transaction = transaction.parentTransactionId
      ? byId.get(transaction.parentTransactionId)
      : undefined;
  }
  return [...touched].sort();
}
export function serializeJsonExport(snapshot: unknown): string {
  return canonicalSerialize(parseJsonExport(snapshot));
}

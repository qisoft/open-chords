import { z } from "zod";

const identifierPattern = /^[a-z][a-z0-9]*_[a-z0-9][a-z0-9_-]*$/;

export const StableIdSchema = z.string().regex(identifierPattern).meta({ id: "StableId" });
export const SampleFrameSchema = z.int().nonnegative().meta({ id: "SampleFrame" });
export const PositiveSampleFrameSchema = z.int().positive().meta({ id: "PositiveSampleFrame" });
const TextOffsetSchema = z.int().nonnegative().meta({ id: "TextOffset" });
const HistoryPositionSchema = z.int().nonnegative().meta({ id: "HistoryPosition" });
const PitchClassSchema = z
  .enum([
    "A",
    "A#",
    "Ab",
    "B",
    "Bb",
    "C",
    "C#",
    "D",
    "D#",
    "Db",
    "E",
    "Eb",
    "F",
    "F#",
    "G",
    "G#",
    "Gb",
  ])
  .meta({ id: "PitchClass" });

const intervalShape = {
  endSample: PositiveSampleFrameSchema,
  startSample: SampleFrameSchema,
};

export const EvidenceSchema = z
  .strictObject({
    name: z.string().min(1),
    scale: z.string().min(1),
    value: z.number(),
  })
  .meta({ id: "Evidence" });

const assertedShape = {
  evidence: z.array(EvidenceSchema),
  reasonCodes: z.array(z.string().min(1)),
};

export const AssertionSchema = z
  .discriminatedUnion("state", [
    z.strictObject({ ...assertedShape, state: z.literal("asserted") }),
    z.strictObject({ ...assertedShape, state: z.literal("low_confidence") }),
    z.strictObject({
      evidence: z.array(EvidenceSchema),
      reasonCodes: z.array(z.string().min(1)).min(1),
      state: z.literal("abstained"),
    }),
  ])
  .meta({ id: "Assertion" });

export const ChordIdentitySchema = z
  .strictObject({
    additions: z.array(z.string().regex(/^add(?:2|4|6|9|11|13)$/)),
    alterations: z.array(z.string().regex(/^(?:b|#)(?:5|9|11|13)$/)),
    bass: PitchClassSchema.optional(),
    extensions: z.array(z.enum(["6", "7", "9", "11", "13"])),
    kind: z.literal("chord"),
    omissions: z.array(z.string().regex(/^no(?:3|5)$/)),
    quality: z.enum([
      "major",
      "minor",
      "diminished",
      "augmented",
      "sus2",
      "sus4",
      "major7",
      "minor7",
      "diminished7",
      "half_diminished",
    ]),
    root: PitchClassSchema,
  })
  .meta({ id: "ChordIdentity" });

export const ChordValueSchema = z
  .discriminatedUnion("kind", [
    ChordIdentitySchema,
    z.strictObject({ kind: z.literal("no_chord") }),
  ])
  .meta({ id: "ChordValue" });

export const BeatSchema = z
  .strictObject({
    atSample: SampleFrameSchema,
    id: StableIdSchema,
    role: z.enum(["downbeat", "beat"]),
  })
  .meta({ id: "Beat" });

const MeterSchema = z
  .strictObject({
    denominator: z.union([z.literal(2), z.literal(4), z.literal(8), z.literal(16)]),
    numerator: z.number().int().min(1).max(32),
  })
  .meta({ id: "Meter" });
const BarStatusSchema = z.enum(["complete", "pickup", "truncated"]).meta({ id: "BarStatus" });

export const BarSchema = z
  .strictObject({
    ...intervalShape,
    beats: z.array(BeatSchema).min(1),
    id: StableIdSchema,
    meter: MeterSchema,
    status: BarStatusSchema,
  })
  .meta({ id: "Bar" });

export const UnmeteredRegionSchema = z
  .strictObject({
    ...intervalShape,
    id: StableIdSchema,
    reasonCode: z.string().min(1),
  })
  .meta({ id: "UnmeteredRegion" });

export const ChordEventSchema = z
  .strictObject({
    ...intervalShape,
    assertion: AssertionSchema,
    id: StableIdSchema,
    value: ChordValueSchema,
  })
  .meta({ id: "ChordEvent" });

export const SectionRegionSchema = z
  .strictObject({
    ...intervalShape,
    assertion: AssertionSchema,
    id: StableIdSchema,
    label: z.enum([
      "intro",
      "verse",
      "pre_chorus",
      "chorus",
      "bridge",
      "solo",
      "interlude",
      "outro",
      "neutral",
      "unknown",
    ]),
  })
  .meta({ id: "SectionRegion" });

export const KeyValueSchema = z
  .discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("key"),
      mode: z.enum(["major", "minor", "dorian", "mixolydian", "other"]),
      tonic: PitchClassSchema,
    }),
    z.strictObject({ kind: z.literal("unknown") }),
  ])
  .meta({ id: "KeyValue" });

export const KeyRegionSchema = z
  .strictObject({
    ...intervalShape,
    assertion: AssertionSchema,
    id: StableIdSchema,
    value: KeyValueSchema,
  })
  .meta({ id: "KeyRegion" });

export const MusicalTimelineSchema = z
  .strictObject({
    bars: z.array(BarSchema),
    chordEvents: z.array(ChordEventSchema).min(1),
    keyRegions: z.array(KeyRegionSchema).min(1),
    sectionRegions: z.array(SectionRegionSchema).min(1),
    unmeteredRegions: z.array(UnmeteredRegionSchema),
  })
  .meta({ id: "MusicalTimeline" });

export const AnalysisRevisionSchema = z
  .strictObject({
    createdAt: z.iso.datetime({ offset: true }),
    id: StableIdSchema,
    manifestHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    projectId: StableIdSchema,
    supportClaimIds: z.array(StableIdSchema),
    timeline: MusicalTimelineSchema,
  })
  .meta({ id: "AnalysisRevision" });

export const LyricsDocumentSchema = z
  .strictObject({
    attribution: z.array(z.string().min(1)),
    id: StableIdSchema,
    language: z.string().min(2),
    lines: z.array(
      z.strictObject({
        endOffset: TextOffsetSchema,
        id: StableIdSchema,
        startOffset: TextOffsetSchema,
      }),
    ),
    notices: z.array(z.string().min(1)),
    provenance: z.strictObject({ provider: z.string().min(1), reference: z.string().min(1) }),
    suppliedTimingKind: z.enum(["untimed", "line", "word"]),
    text: z.string(),
    tokenization: z.strictObject({ scheme: z.string().min(1), version: z.string().min(1) }),
    tokens: z.array(
      z.strictObject({
        endOffset: TextOffsetSchema,
        id: StableIdSchema,
        lineId: StableIdSchema,
        startOffset: TextOffsetSchema,
        text: z.string().min(1),
      }),
    ),
  })
  .meta({ id: "LyricsDocument" });

const AlignedAssertionSchema = z
  .discriminatedUnion("state", [
    z.strictObject({ ...assertedShape, state: z.literal("asserted") }),
    z.strictObject({ ...assertedShape, state: z.literal("low_confidence") }),
  ])
  .meta({ id: "AlignedAssertion" });

export const LyricsTimingSchema = z
  .discriminatedUnion("state", [
    z.strictObject({
      ...intervalShape,
      assertion: AlignedAssertionSchema,
      state: z.literal("matched"),
    }),
    z.strictObject({ reasonCode: z.string().min(1), state: z.literal("unmatched") }),
  ])
  .meta({ id: "LyricsTiming" });

const UserLyricsTimingSchema = z
  .discriminatedUnion("state", [
    z.strictObject({
      ...intervalShape,
      assertion: z.strictObject({
        evidence: z.array(z.never()).length(0),
        reasonCodes: z.array(z.literal("user_authored")).length(1),
        state: z.literal("asserted"),
      }),
      state: z.literal("matched"),
    }),
    z.strictObject({ reasonCode: z.string().min(1), state: z.literal("unmatched") }),
  ])
  .meta({ id: "UserLyricsTiming" });

export const LyricsAlignmentSchema = z
  .strictObject({
    analysisRevisionId: StableIdSchema,
    id: StableIdSchema,
    lineOccurrences: z.array(
      z.strictObject({ lineId: StableIdSchema, timing: LyricsTimingSchema }),
    ),
    lyricsDocumentId: StableIdSchema,
    occurrences: z.array(z.strictObject({ timing: LyricsTimingSchema, tokenId: StableIdSchema })),
  })
  .meta({ id: "LyricsAlignment" });

export const EditOperationSchema = z
  .discriminatedUnion("type", [
    z.strictObject({
      eventId: StableIdSchema,
      type: z.literal("replace_chord_value"),
      value: ChordValueSchema,
    }),
    z.strictObject({
      atSample: PositiveSampleFrameSchema,
      leftEventId: StableIdSchema,
      rightEventId: StableIdSchema,
      type: z.literal("move_chord_boundary"),
    }),
    z.strictObject({
      atSample: SampleFrameSchema,
      beatId: StableIdSchema,
      type: z.literal("move_beat"),
    }),
    z.strictObject({
      atSample: PositiveSampleFrameSchema,
      leftBarId: StableIdSchema,
      rightBarId: StableIdSchema,
      type: z.literal("move_bar_boundary"),
    }),
    z.strictObject({ barId: StableIdSchema, meter: MeterSchema, type: z.literal("set_bar_meter") }),
    z.strictObject({
      atSample: PositiveSampleFrameSchema,
      barId: StableIdSchema,
      leftStatus: BarStatusSchema,
      newBarId: StableIdSchema,
      newDownbeatId: StableIdSchema,
      rightMeter: MeterSchema,
      rightStatus: BarStatusSchema,
      type: z.literal("split_bar"),
    }),
    z.strictObject({
      leftBarId: StableIdSchema,
      meter: MeterSchema,
      rightBarId: StableIdSchema,
      status: BarStatusSchema,
      type: z.literal("merge_bars"),
    }),
    z.strictObject({
      alignmentId: StableIdSchema,
      timing: UserLyricsTimingSchema,
      tokenId: StableIdSchema,
      type: z.literal("set_lyrics_timing"),
    }),
    z.strictObject({
      alignmentId: StableIdSchema,
      lineId: StableIdSchema,
      timing: UserLyricsTimingSchema,
      type: z.literal("set_lyrics_line_timing"),
    }),
    z.strictObject({
      label: SectionRegionSchema.shape.label,
      regionId: StableIdSchema,
      type: z.literal("replace_section_label"),
    }),
  ])
  .meta({ id: "EditOperation" });

export const EditTransactionSchema = z
  .strictObject({
    id: StableIdSchema,
    operations: z.array(EditOperationSchema).min(1),
    parentTransactionId: StableIdSchema.nullable(),
  })
  .meta({ id: "EditTransaction" });

export const EditLayerSchema = z
  .strictObject({
    analysisRevisionId: StableIdSchema,
    id: StableIdSchema,
    transactions: z.array(EditTransactionSchema),
  })
  .meta({ id: "EditLayer" });

const supportClaimShape = {
  benchmarkPolicyHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  capability: z.enum(["rhythm", "meter", "key", "chords", "sections", "lyrics_alignment"]),
  id: StableIdSchema,
  inputs: z.array(z.string().min(1)).min(1),
  operatingConditions: z.array(z.string().min(1)).min(1),
  platformProfiles: z.array(z.string().min(1)).min(1),
  releaseVersion: z.string().min(1),
  slices: z.array(z.string().min(1)),
};

export const SupportClaimSchema = z
  .discriminatedUnion("evidenceStatus", [
    z.strictObject({
      ...supportClaimShape,
      benchmarkRunHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
      evidenceStatus: z.literal("supported"),
    }),
    z.strictObject({
      ...supportClaimShape,
      evidenceStatus: z.literal("insufficient_evidence"),
    }),
  ])
  .meta({ id: "SupportClaim" });

export const ActiveViewSchema = z
  .strictObject({
    analysisRevisionId: StableIdSchema,
    editHistoryPosition: HistoryPositionSchema,
    editLayerId: StableIdSchema,
    lyricsAlignmentId: StableIdSchema.optional(),
    lyricsDocumentId: StableIdSchema.optional(),
    presentation: z.strictObject({
      beginnerView: z.boolean(),
      enharmonicPreference: z.enum(["sharp", "flat", "contextual"]),
      transposeSemitones: z.number().int().min(-11).max(11),
    }),
  })
  .meta({ id: "ActiveView" });

export const ProjectContractSchema = z
  .strictObject({
    activeView: ActiveViewSchema.nullable(),
    analysisRevisions: z.array(AnalysisRevisionSchema),
    durationSamples: PositiveSampleFrameSchema,
    editLayers: z.array(EditLayerSchema),
    extensions: z.record(z.string().regex(/^[a-z0-9]+(?:\.[a-z0-9-]+)+$/), z.unknown()),
    format: z.literal("open-chords/project"),
    id: StableIdSchema,
    lyricsAlignments: z.array(LyricsAlignmentSchema),
    lyricsDocuments: z.array(LyricsDocumentSchema),
    sampleRate: z.number().int().positive().max(384_000),
    schemaVersion: z.string().regex(/^\d+\.\d+$/),
    supportClaims: z.array(SupportClaimSchema),
  })
  .meta({ id: "ProjectContract" });

export type ActiveView = z.infer<typeof ActiveViewSchema>;
export type AnalysisRevision = z.infer<typeof AnalysisRevisionSchema>;
export type ChordEvent = z.infer<typeof ChordEventSchema>;
export type ChordValue = z.infer<typeof ChordValueSchema>;
export type EditLayer = z.infer<typeof EditLayerSchema>;
export type EditTransaction = z.infer<typeof EditTransactionSchema>;
export type LyricsAlignment = z.infer<typeof LyricsAlignmentSchema>;
export type LyricsDocument = z.infer<typeof LyricsDocumentSchema>;
export type MusicalTimeline = z.infer<typeof MusicalTimelineSchema>;
export type ProjectContract = z.infer<typeof ProjectContractSchema>;

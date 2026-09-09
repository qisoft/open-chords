import { createHash } from "node:crypto";

import {
  canonicalSerialize,
  MusicalTimelineSchema,
  ProjectContractSchema,
  StableIdSchema,
} from "@open-chords/domain";
import { z } from "zod";

import { HashSchema, TimeSchema } from "./rights.ts";

export const CapabilitySchema = z.enum([
  "rhythm",
  "meter",
  "key",
  "chords",
  "sections",
  "lyrics_alignment",
]);
const frame = z.number().int().nonnegative();
const interval = { startSample: frame, endSample: z.number().int().positive() };
const shape = MusicalTimelineSchema.shape;
const documentSchema = ProjectContractSchema.shape.lyricsDocuments.element;
const timing = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("matched"), ...interval }),
  z.strictObject({ state: z.literal("unmatched"), reason: z.string().min(1) }),
]);
export const AnnotationContentSchema = z.discriminatedUnion("capability", [
  z.strictObject({
    capability: z.literal("chords"),
    events: z.array(shape.chordEvents.element.omit({ assertion: true })).min(1),
  }),
  z.strictObject({
    capability: z.literal("key"),
    events: z.array(shape.keyRegions.element.omit({ assertion: true })).min(1),
  }),
  z.strictObject({
    capability: z.literal("sections"),
    events: z
      .array(
        shape.sectionRegions.element.omit({ assertion: true }).extend({ groupId: StableIdSchema }),
      )
      .min(1),
  }),
  z.strictObject({
    capability: z.literal("rhythm"),
    bars: shape.bars,
    unmeteredRegions: shape.unmeteredRegions,
  }),
  z.strictObject({
    capability: z.literal("meter"),
    bars: shape.bars,
    unmeteredRegions: shape.unmeteredRegions,
  }),
  z.strictObject({
    capability: z.literal("lyrics_alignment"),
    document: documentSchema,
    tokens: z.array(z.strictObject({ tokenId: StableIdSchema, timing })),
    lines: z.array(z.strictObject({ lineId: StableIdSchema, timing })),
  }),
]);
const personSchema = z.strictObject({
  id: StableIdSchema,
  qualification: z.strictObject({
    capability: CapabilitySchema,
    evidenceHash: HashSchema,
    reviewerId: StableIdSchema,
  }),
});
const ambiguitySchema = z.strictObject({ ...interval, reason: z.string().min(1) });
export const RawAnnotationSchema = z.strictObject({
  version: z.literal("1.0"),
  id: StableIdSchema,
  trackId: StableIdSchema,
  audioHash: HashSchema,
  guideHash: HashSchema,
  sampleRate: z.number().int().positive().max(768000),
  durationSamples: z.number().int().positive(),
  createdAt: TimeSchema,
  source: z.enum(["independent_human", "synthetic_fixture"]),
  blindToSystemOutputs: z.literal(true),
  blindToOtherAnnotations: z.literal(true),
  annotator: personSchema,
  tool: z.strictObject({ name: z.string().min(1), version: z.string().min(1) }),
  ambiguity: z.array(ambiguitySchema),
  content: AnnotationContentSchema,
});
export const AdjudicationSchema = z.strictObject({
  source: z.enum(["adjudicated_human", "synthetic_fixture"]),
  id: StableIdSchema,
  createdAt: TimeSchema,
  guideHash: HashSchema,
  adjudicator: personSchema,
  rawHashes: z.tuple([HashSchema, HashSchema]),
  result: AnnotationContentSchema,
  decisions: z.array(ambiguitySchema),
});
const goldInputSchema = z.strictObject({
  annotations: z.tuple([RawAnnotationSchema, RawAnnotationSchema]),
  adjudication: AdjudicationSchema,
});
const disagreementSchema = z.strictObject({
  ...interval,
  reason: z.literal("annotation_difference"),
});
const goldSchema = goldInputSchema.extend({
  version: z.literal("1.0"),
  disagreements: z.array(disagreementSchema),
  hash: HashSchema,
  reliability: z.literal("not_measured"),
});
export type RawAnnotation = z.infer<typeof RawAnnotationSchema>;
export type GoldReference = z.infer<typeof goldSchema>;
export type AnnotationContent = z.infer<typeof AnnotationContentSchema>;

export function contentHash(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalSerialize(value)).digest("hex")}`;
}
function unique(ids: string[]) {
  if (new Set(ids).size !== ids.length) throw new Error("Duplicate annotation identity");
}
function cover(events: { startSample: number; endSample: number; id: string }[], duration: number) {
  unique(events.map(({ id }) => id));
  let cursor = 0;
  for (const event of events) {
    if (event.startSample !== cursor || event.endSample <= cursor)
      throw new Error("Annotation must cover the complete track in order");
    cursor = event.endSample;
  }
  if (cursor !== duration) throw new Error("Annotation must end at track duration");
}
function validateContent(content: AnnotationContent, duration: number) {
  if ("events" in content) {
    cover(content.events, duration);
    if (content.capability === "chords")
      for (const { value } of content.events)
        if (value.kind === "chord")
          // Preserve the lexical component order required by the public Open Chords timeline.
          for (const values of [
            value.additions,
            value.alterations,
            value.extensions,
            value.omissions,
          ])
            if (values.some((component, index) => index > 0 && component <= values[index - 1]!))
              throw new Error("Chord components must be sorted and unique");
  } else if ("bars" in content) {
    for (const intervals of [content.bars, content.unmeteredRegions])
      if (
        intervals.some(
          (item, index) => index > 0 && item.startSample < intervals[index - 1]!.endSample,
        )
      )
        throw new Error("Annotation interval order differs from sample order");
    cover(
      [...content.bars, ...content.unmeteredRegions].toSorted(
        (a, b) => a.startSample - b.startSample,
      ),
      duration,
    );
    unique(content.bars.flatMap(({ beats }) => beats.map(({ id }) => id)));
    for (const bar of content.bars) {
      if (
        bar.beats.length > bar.meter.numerator ||
        (bar.status === "complete" && bar.beats.length !== bar.meter.numerator)
      )
        throw new Error("Annotation meter and beat count differ");
      for (const [index, beat] of bar.beats.entries())
        if (
          beat.atSample < bar.startSample ||
          beat.atSample >= bar.endSample ||
          (index === 0
            ? beat.role !== "downbeat" || beat.atSample !== bar.startSample
            : beat.role !== "beat" || beat.atSample <= bar.beats[index - 1]!.atSample)
        )
          throw new Error("Invalid annotated beat order");
    }
  } else {
    const doc = content.document;
    unique(doc.tokens.map(({ id }) => id));
    unique(doc.lines.map(({ id }) => id));
    for (const records of [doc.tokens, doc.lines]) {
      let end = 0;
      for (const record of records) {
        if (
          record.startOffset < end ||
          record.endOffset <= record.startOffset ||
          record.endOffset > doc.text.length
        )
          throw new Error("Invalid lyric text offsets");
        end = record.endOffset;
      }
    }
    for (const token of doc.tokens)
      if (
        !doc.lines.some(({ id }) => id === token.lineId) ||
        doc.text.slice(token.startOffset, token.endOffset) !== token.text
      )
        throw new Error("Lyrics token differs from immutable text");
    if (
      canonicalSerialize(content.tokens.map(({ tokenId }) => tokenId)) !==
        canonicalSerialize(doc.tokens.map(({ id }) => id)) ||
      canonicalSerialize(content.lines.map(({ lineId }) => lineId)) !==
        canonicalSerialize(doc.lines.map(({ id }) => id))
    )
      throw new Error("Every lyric occurrence must be accounted for");
    for (const records of [content.tokens, content.lines]) {
      let end = 0;
      for (const { timing: item } of records)
        if (item.state === "matched") {
          if (
            item.startSample < end ||
            item.endSample <= item.startSample ||
            item.endSample > duration
          )
            throw new Error("Invalid lyric timing order");
          end = item.endSample;
        }
    }
  }
}
function validateIntervals(items: z.infer<typeof ambiguitySchema>[], duration: number) {
  for (const item of items)
    if (item.startSample >= item.endSample || item.endSample > duration)
      throw new Error("Invalid annotation review interval");
}
export function parseRawAnnotation(input: unknown): RawAnnotation {
  const raw = RawAnnotationSchema.parse(input);
  if (
    raw.annotator.qualification.capability !== raw.content.capability ||
    raw.annotator.id === raw.annotator.qualification.reviewerId
  )
    throw new Error("Annotation qualification mismatch");
  validateContent(raw.content, raw.durationSamples);
  validateIntervals(raw.ambiguity, raw.durationSamples);
  return raw;
}
function semantic(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(semantic);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !["id", "tokenId", "lineId"].includes(key))
        .map(([key, item]) => [key, semantic(item)]),
    );
  return value;
}
function disagreements(
  first: RawAnnotation,
  second: RawAnnotation,
): z.infer<typeof disagreementSchema>[] {
  const left = first.content,
    right = second.content;
  if (canonicalSerialize(semantic(left)) === canonicalSerialize(semantic(right))) return [];
  if ("events" in left && "events" in right) {
    const boundaries = [
      ...new Set(
        [...left.events, ...right.events].flatMap(({ startSample, endSample }) => [
          startSample,
          endSample,
        ]),
      ),
    ].sort((a, b) => a - b);
    const result: z.infer<typeof disagreementSchema>[] = [];
    for (let index = 0; index < boundaries.length - 1; index++) {
      const startSample = boundaries[index]!,
        endSample = boundaries[index + 1]!;
      const a = left.events.find(
        (event) => event.startSample <= startSample && event.endSample > startSample,
      )!;
      const b = right.events.find(
        (event) => event.startSample <= startSample && event.endSample > startSample,
      )!;
      if (canonicalSerialize(semantic(a)) !== canonicalSerialize(semantic(b)))
        result.push({ startSample, endSample, reason: "annotation_difference" });
    }
    return result;
  }
  // Non-interval structures retain their whole-track disagreement until task metrics refine it.
  return [{ startSample: 0, endSample: first.durationSamples, reason: "annotation_difference" }];
}
export function buildGoldReference(input: unknown): GoldReference {
  const parsed = goldInputSchema.parse(input);
  const first = parseRawAnnotation(parsed.annotations[0]);
  const second = parseRawAnnotation(parsed.annotations[1]);
  const decision = parsed.adjudication;
  if (
    first.source !== second.source ||
    (first.source === "synthetic_fixture") !== (decision.source === "synthetic_fixture")
  )
    throw new Error("Annotation source kinds differ");
  unique([first.id, second.id, decision.id]);
  unique([first.annotator.id, second.annotator.id, decision.adjudicator.id]);
  for (const field of [
    "trackId",
    "audioHash",
    "guideHash",
    "sampleRate",
    "durationSamples",
  ] as const)
    if (first[field] !== second[field])
      throw new Error("Independent annotations have different scopes");
  if (
    first.content.capability !== second.content.capability ||
    first.content.capability !== decision.result.capability ||
    decision.adjudicator.qualification.capability !== first.content.capability ||
    decision.adjudicator.id === decision.adjudicator.qualification.reviewerId ||
    decision.guideHash !== first.guideHash
  )
    throw new Error("Adjudication qualification or guide mismatch");
  if (decision.rawHashes[0] !== contentHash(first) || decision.rawHashes[1] !== contentHash(second))
    throw new Error("Adjudication must bind both immutable raw annotations");
  if ([first, second].some((raw) => Date.parse(raw.createdAt) > Date.parse(decision.createdAt)))
    throw new Error("Adjudication predates annotation");
  validateContent(decision.result, first.durationSamples);
  validateIntervals(decision.decisions, first.durationSamples);
  const differences = disagreements(first, second);
  for (const region of [
    ...differences,
    ...disagreements(first, { ...first, content: decision.result }),
    ...first.ambiguity,
    ...second.ambiguity,
  ])
    if (
      !decision.decisions.some(
        (item) => item.startSample <= region.startSample && item.endSample >= region.endSample,
      )
    )
      throw new Error("Every disagreement and ambiguity requires an adjudication reason");
  const payload = {
    ...parsed,
    version: "1.0" as const,
    disagreements: differences,
    reliability: "not_measured" as const,
  };
  return goldSchema.parse({ ...payload, hash: contentHash(payload) });
}
export function parseGoldReference(input: unknown): GoldReference {
  const stored = goldSchema.parse(input);
  const expected = buildGoldReference({
    annotations: stored.annotations,
    adjudication: stored.adjudication,
  });
  if (canonicalSerialize(stored) !== canonicalSerialize(expected))
    throw new Error("Gold Reference content hash or disagreement record mismatch");
  return stored;
}

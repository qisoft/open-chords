import {
  canonicalSerialize,
  parseAnalysisTimeline,
  pitchClassNumber,
  ProjectContractSchema,
  StableIdSchema,
  type MusicalTimeline,
} from "@open-chords/domain";
import { z } from "zod";

import type { AnnotationContent } from "./annotations.ts";
import { chordToHarte } from "./jams.ts";

export const ConfidenceCapabilitySchema = z.enum(["chords", "key", "sections"]);
export const ConfidenceSpecSchema = z.strictObject({
  capability: ConfidenceCapabilitySchema,
  evidence: z.strictObject({ name: z.string().min(1), scale: z.string().min(1) }),
  bins: z
    .array(z.number().min(0).max(1))
    .min(2)
    .refine(
      (edges) =>
        edges[0] === 0 &&
        edges.at(-1) === 1 &&
        edges.every((edge, index) => index === 0 || edge > edges[index - 1]!),
      "Bins must increase strictly from 0 to 1",
    ),
});
export type ConfidenceSpec = z.infer<typeof ConfidenceSpecSchema>;
type ConfidenceCapability = z.infer<typeof ConfidenceCapabilitySchema>;

const alignment = ProjectContractSchema.shape.lyricsAlignments.element;
const OutputSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("completed"),
    revisionId: StableIdSchema,
    timeline: z.unknown(),
    lyrics: alignment.pick({ occurrences: true, lineOccurrences: true }).nullable(),
  }),
  z.strictObject({ kind: z.literal("failed"), failureClass: StableIdSchema }),
]);

type Interval = { startSample: number; endSample: number };
type State = "asserted" | "low_confidence" | "abstained";
type Region<V> = Interval & { value: V; state: State; confidence: number | null };
type Bars = MusicalTimeline["bars"];
type Timing = Interval | null;
export type PredictionView = {
  chords: Region<MusicalTimeline["chordEvents"][number]["value"]>[];
  key: Region<MusicalTimeline["keyRegions"][number]["value"]>[];
  sections: Region<MusicalTimeline["sectionRegions"][number]["label"]>[];
  bars: Bars;
  unmetered: Interval[];
  tokens: Map<string, Timing>;
  lines: Map<string, Timing>;
};
export type Outcome = "completed" | "failed" | "invalid";

const emptyView = (): PredictionView => ({
  chords: [],
  key: [],
  sections: [],
  bars: [],
  unmetered: [],
  tokens: new Map(),
  lines: new Map(),
});

export function readOutput(
  raw: unknown,
  durationSamples: number,
  gold: AnnotationContent[],
  confidence: ConfidenceSpec[],
): { outcome: Outcome; view: PredictionView } {
  const parsed = OutputSchema.safeParse(raw);
  if (!parsed.success) return { outcome: "invalid", view: emptyView() };
  if (parsed.data.kind === "failed") return { outcome: "failed", view: emptyView() };
  try {
    const timeline = parseAnalysisTimeline(parsed.data.timeline, durationSamples);
    const region = <
      T extends Interval & { assertion: MusicalTimeline["chordEvents"][number]["assertion"] },
      V,
    >(
      capability: ConfidenceCapability,
      items: T[],
      value: (item: T) => V,
    ): Region<V>[] =>
      items.map((item) => {
        const spec = confidence.find((c) => c.capability === capability);
        const evidence = spec
          ? item.assertion.evidence.filter(
              (e) => e.name === spec.evidence.name && e.scale === spec.evidence.scale,
            )
          : [];
        const probability = evidence[0]?.value ?? null;
        if (
          spec &&
          item.assertion.state !== "abstained" &&
          (evidence.length !== 1 || probability === null || probability < 0 || probability > 1)
        )
          throw new Error("Missing declared confidence evidence");
        return {
          startSample: item.startSample,
          endSample: item.endSample,
          value: value(item),
          state: item.assertion.state,
          confidence: item.assertion.state === "abstained" ? null : probability,
        };
      });
    const view: PredictionView = {
      chords: region("chords", timeline.chordEvents, (e) => e.value),
      key: region("key", timeline.keyRegions, (e) => e.value),
      sections: region("sections", timeline.sectionRegions, (e) => e.label),
      bars: timeline.bars,
      unmetered: timeline.unmeteredRegions,
      tokens: new Map(),
      lines: new Map(),
    };
    const lyricsGold = gold.find((content) => content.capability === "lyrics_alignment");
    const lyrics = parsed.data.lyrics;
    if (lyricsGold?.capability === "lyrics_alignment") {
      const timing = (
        items: { timing: z.infer<typeof alignment>["occurrences"][number]["timing"] }[],
      ) =>
        items.map(({ timing: t }) =>
          t.state === "matched" ? { startSample: t.startSample, endSample: t.endSample } : null,
        );
      const tokenIds = lyricsGold.tokens.map((t) => t.tokenId),
        lineIds = lyricsGold.lines.map((l) => l.lineId);
      if (
        lyrics === null ||
        canonicalSerialize(lyrics.occurrences.map((o) => o.tokenId)) !==
          canonicalSerialize(tokenIds) ||
        canonicalSerialize(lyrics.lineOccurrences.map((o) => o.lineId)) !==
          canonicalSerialize(lineIds) ||
        [...lyrics.occurrences, ...lyrics.lineOccurrences].some(
          ({ timing: t }) => t.state === "matched" && t.endSample > durationSamples,
        )
      )
        throw new Error("Lyrics output differs from the Reference Lyrics occurrences");
      const tokenTimings = timing(lyrics.occurrences),
        lineTimings = timing(lyrics.lineOccurrences);
      tokenIds.forEach((id, index) => view.tokens.set(id, tokenTimings[index]!));
      lineIds.forEach((id, index) => view.lines.set(id, lineTimings[index]!));
    }
    return { outcome: "completed", view };
  } catch {
    return { outcome: "invalid", view: emptyView() };
  }
}

export type MetricValue =
  | { state: "scored"; value: number; pooled: [number, number] | null }
  | { state: "not_applicable" }
  | { state: "uncovered" };
type Context = { gold: AnnotationContent; view: PredictionView; sampleRate: number };
type Definition = {
  capability: AnnotationContent["capability"];
  kind: "quality" | "coverage" | "calibration" | "diagnostic";
  better: "higher" | "lower";
  unit: string;
  score: (context: Context) => MetricValue;
};

const notApplicable: MetricValue = { state: "not_applicable" };
const ratio = (numerator: number, denominator: number): MetricValue =>
  denominator === 0
    ? notApplicable
    : { state: "scored", value: numerator / denominator, pooled: [numerator, denominator] };
const conditional = (values: number[], applicable: boolean, reduce: (v: number[]) => number) =>
  !applicable
    ? notApplicable
    : values.length === 0
      ? ({ state: "uncovered" } as const)
      : ({ state: "scored", value: reduce(values), pooled: null } as const);
export const median = (values: number[]) => {
  const sorted = values.toSorted((a, b) => a - b),
    middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

function sweep<G extends Interval, P extends Interval>(
  gold: G[],
  predicted: P[],
  visit: (gold: G, predicted: P | undefined, samples: number) => void,
) {
  let index = 0;
  for (const item of gold) {
    let cursor = item.startSample;
    while (cursor < item.endSample) {
      while (index < predicted.length && predicted[index]!.endSample <= cursor) index++;
      const candidate = predicted[index];
      const covering = candidate !== undefined && candidate.startSample <= cursor;
      const end = Math.min(
        item.endSample,
        covering ? candidate.endSample : (candidate?.startSample ?? item.endSample),
      );
      visit(item, covering ? candidate : undefined, end - cursor);
      cursor = end;
    }
  }
}
function agreement<G extends Interval, P extends Interval>(
  gold: G[],
  predicted: P[],
  judge: (gold: G, predicted: P | undefined) => "correct" | "wrong" | "ineligible",
): MetricValue {
  let correct = 0,
    eligible = 0;
  sweep(gold, predicted, (g, p, samples) => {
    const verdict = judge(g, p);
    if (verdict !== "ineligible") eligible += samples;
    if (verdict === "correct") correct += samples;
  });
  return ratio(correct, eligible);
}
const asserted = <V>(region: Region<V> | undefined): region is Region<V> =>
  region !== undefined && region.state !== "abstained";
const same = (left: unknown, right: unknown) =>
  canonicalSerialize(left) === canonicalSerialize(right);

type Harmony = { root: number; bits: number[] };
const degreeSemitones: Record<string, number> = {
  "1": 0,
  "2": 2,
  "3": 4,
  "4": 5,
  "5": 7,
  "6": 9,
  "7": 11,
  "9": 14,
  "11": 17,
  "13": 21,
};
function semitone(degree: string) {
  const base = degreeSemitones[degree.replace(/[b#]/g, "")]!;
  return base + (degree.match(/#/g)?.length ?? 0) - (degree.match(/b/g)?.length ?? 0);
}
function harmony(value: Region<unknown>["value"]): Harmony {
  const label = chordToHarte(value);
  if (label === "N") return { root: -1, bits: Array<number>(12).fill(0) };
  const [, root, degrees, bass] = /^([A-G][b#]?):\(([^)]*)\)(?:\/(.+))?$/.exec(label)!;
  const bits = Array<number>(12).fill(0);
  bits[0] = 1;
  for (const degree of degrees!.split(",")) {
    const offset = semitone(degree);
    if (offset >= 0 && offset < 12) bits[offset] = 1;
  }
  if (bass !== undefined) bits[semitone(bass) % 12] = 1;
  return { root: pitchClassNumber(root!), bits };
}
const bitmap = (text: string) => text.split("").map(Number);
const majMin = [bitmap("10001001"), bitmap("10010001")];
const sevenths = [
  "100010010000",
  "100100010000",
  "100010010001",
  "100010010010",
  "100100010010",
].map(bitmap);
function vocabulary(
  context: Context,
  eligible: (reference: Harmony) => boolean,
  width: number,
  compareBits: boolean,
): MetricValue {
  if (context.gold.capability !== "chords") return notApplicable;
  return agreement(context.gold.events, context.view.chords, (g, p) => {
    const reference = harmony(g.value);
    if (reference.root >= 0 && !eligible(reference)) return "ineligible";
    if (!asserted(p)) return "wrong";
    const estimate = harmony(p.value);
    return estimate.root === reference.root &&
      (!compareBits || same(estimate.bits.slice(0, width), reference.bits.slice(0, width)))
      ? "correct"
      : "wrong";
  });
}

function matchEvents(
  reference: number[],
  estimate: number[],
  windowSamples: (d: number) => boolean,
) {
  let i = 0,
    j = 0,
    matched = 0;
  while (i < reference.length && j < estimate.length) {
    const delta = estimate[j]! - reference[i]!;
    if (windowSamples(delta)) {
      matched++;
      i++;
      j++;
    } else if (delta < 0) j++;
    else i++;
  }
  return matched;
}
function fMeasure(reference: number[], estimate: number[], windowMs: number, sampleRate: number) {
  if (reference.length === 0) return notApplicable;
  const matched = matchEvents(
    reference,
    estimate,
    (delta) => Math.abs(delta) * 1000 <= windowMs * sampleRate,
  );
  return ratio(2 * matched, reference.length + estimate.length);
}
const beatF = (context: Context, downbeatsOnly: boolean) =>
  context.gold.capability === "rhythm"
    ? fMeasure(
        beatTimes(context.gold.bars, downbeatsOnly),
        beatTimes(context.view.bars, downbeatsOnly),
        70,
        context.sampleRate,
      )
    : notApplicable;
const sectionBoundaries = (context: Context, windowMs: number) =>
  context.gold.capability === "sections"
    ? fMeasure(
        boundaries(context.gold.events),
        boundaries(context.view.sections),
        windowMs,
        context.sampleRate,
      )
    : notApplicable;
const beatTimes = (bars: Bars, downbeatsOnly: boolean) =>
  bars.flatMap((bar) =>
    bar.beats.filter((b) => !downbeatsOnly || b.role === "downbeat").map((b) => b.atSample),
  );
function metered(context: Context): { gold: Bars; unmetered: Interval[] } | null {
  const gold = context.gold;
  return gold.capability === "rhythm" || gold.capability === "meter"
    ? { gold: gold.bars, unmetered: gold.unmeteredRegions }
    : null;
}
function meteredCoverage(context: Context): MetricValue {
  const rhythm = metered(context);
  if (rhythm === null) return notApplicable;
  return agreement(rhythm.gold, context.view.bars, (_g, p) => (p ? "correct" : "wrong"));
}
function intervalsBetweenBeats(bars: Bars, unmetered: Interval[]): Interval[] {
  const beats = beatTimes(bars, false);
  return beats.flatMap((start, index) => {
    const end = beats[index + 1];
    return end === undefined ||
      unmetered.some((region) => region.startSample < end && region.endSample > start)
      ? []
      : [{ startSample: start, endSample: end }];
  });
}
function tempoErrors(context: Context) {
  const rhythm = metered(context);
  if (rhythm === null || context.gold.capability !== "rhythm") return null;
  const reference = intervalsBetweenBeats(rhythm.gold, rhythm.unmetered);
  const estimate = intervalsBetweenBeats(context.view.bars, context.view.unmetered);
  const errors = reference.flatMap((item) => {
    const midpoint = Math.floor((item.startSample + item.endSample) / 2);
    const covering = estimate.find((e) => e.startSample <= midpoint && e.endSample > midpoint);
    return covering
      ? [
          Math.abs(
            Math.log2(
              (covering.endSample - covering.startSample) / (item.endSample - item.startSample),
            ),
          ),
        ]
      : [];
  });
  return { errors, reference: reference.length };
}
const meterLabels = (bars: Bars, unmetered: Interval[]) =>
  [
    ...bars.map((bar) => ({ ...bar, label: `${bar.meter.numerator}/${bar.meter.denominator}` })),
    ...unmetered.map((region) => ({ ...region, label: "unmetered" })),
  ].toSorted((a, b) => a.startSample - b.startSample);
function boundaries(items: Interval[]) {
  return [...new Set(items.flatMap((item) => [item.startSample, item.endSample]))].sort(
    (a, b) => a - b,
  );
}

type AnyRegion = Region<unknown>;
function regionsOf(
  context: Context,
): { gold: (Interval & { value: unknown })[]; predicted: AnyRegion[] } | null {
  const gold = context.gold;
  if (gold.capability === "chords") return { gold: gold.events, predicted: context.view.chords };
  if (gold.capability === "key") return { gold: gold.events, predicted: context.view.key };
  if (gold.capability === "sections")
    return {
      gold: gold.events.map((event) => ({ ...event, value: event.label })),
      predicted: context.view.sections,
    };
  return null;
}
const ignoredGold = (value: unknown) =>
  value === "unknown" ||
  (typeof value === "object" && value !== null && same(value, { kind: "unknown" }));
function regionExact(context: Context): MetricValue {
  const regions = regionsOf(context);
  if (regions === null) return notApplicable;
  return agreement(regions.gold, regions.predicted, (g, p) =>
    ignoredGold(g.value)
      ? "ineligible"
      : asserted(p) && same(p.value, g.value)
        ? "correct"
        : "wrong",
  );
}
function regionShare(
  context: Context,
  include: (p: AnyRegion | undefined) => boolean,
): MetricValue {
  const regions = regionsOf(context);
  if (regions === null) return notApplicable;
  return agreement(regions.gold, regions.predicted, (_g, p) => (include(p) ? "correct" : "wrong"));
}
export type CalibrationCell = { confidence: number; samples: number; correct: boolean };
export function calibrationCells(gold: AnnotationContent, view: PredictionView): CalibrationCell[] {
  const regions = regionsOf({ gold, view, sampleRate: 1 });
  if (regions === null) return [];
  const cells: CalibrationCell[] = [];
  sweep(regions.gold, regions.predicted, (g, p, samples) => {
    if (asserted(p) && p.confidence !== null && !ignoredGold(g.value))
      cells.push({ confidence: p.confidence, samples, correct: same(p.value, g.value) });
  });
  return cells;
}
function lyricErrors(context: Context, level: "tokens" | "lines", edge: "start" | "end" | "both") {
  const gold = context.gold;
  if (gold.capability !== "lyrics_alignment") return null;
  const items =
    level === "tokens"
      ? gold.tokens.map((t) => ({ id: t.tokenId, timing: t.timing }))
      : gold.lines.map((l) => ({ id: l.lineId, timing: l.timing }));
  const eligible = items.filter((item) => item.timing.state === "matched");
  const predicted = level === "tokens" ? context.view.tokens : context.view.lines;
  const errors = eligible.flatMap((item) => {
    const estimate = predicted.get(item.id);
    if (!estimate || item.timing.state !== "matched") return [];
    const start = Math.abs(estimate.startSample - item.timing.startSample) / context.sampleRate;
    const end = Math.abs(estimate.endSample - item.timing.endSample) / context.sampleRate;
    return edge === "start" ? [start] : edge === "end" ? [end] : [Math.max(start, end)];
  });
  return { errors, eligible: eligible.length };
}
function lyricCoverage(level: "tokens" | "lines"): Definition {
  return {
    capability: "lyrics_alignment",
    kind: "coverage",
    better: "higher",
    unit: "ratio",
    score: (context) => {
      const result = lyricErrors(context, level, "start");
      return result === null ? notApplicable : ratio(result.errors.length, result.eligible);
    },
  };
}
function lyricError(
  level: "tokens" | "lines",
  edge: "start" | "end" | "both",
  reduce: (values: number[]) => number,
): Definition {
  return {
    capability: "lyrics_alignment",
    kind: "quality",
    better: "lower",
    unit: "seconds",
    score: (context) => {
      const result = lyricErrors(context, level, edge);
      return result === null
        ? notApplicable
        : conditional(result.errors, result.eligible > 0, reduce);
    },
  };
}
const maximum = (values: number[]) => Math.max(...values);
const regionExactMetric = (capability: ConfidenceCapability): Definition => ({
  capability,
  kind: "quality",
  better: "higher",
  unit: "duration_ratio",
  score: regionExact,
});
const regionCoverage = (capability: ConfidenceCapability): Definition => ({
  capability,
  kind: "coverage",
  better: "higher",
  unit: "duration_ratio",
  score: (context) => regionShare(context, asserted),
});
const lowConfidenceShare = (capability: ConfidenceCapability): Definition => ({
  capability,
  kind: "diagnostic",
  better: "lower",
  unit: "duration_ratio",
  score: (context) => regionShare(context, (p) => p?.state === "low_confidence"),
});
const selectiveError = (capability: ConfidenceCapability): Definition => ({
  capability,
  kind: "quality",
  better: "lower",
  unit: "duration_ratio",
  score: (context) => {
    const regions = regionsOf(context);
    if (regions === null) return notApplicable;
    let wrong = 0,
      total = 0;
    sweep(regions.gold, regions.predicted, (g, p, samples) => {
      if (!asserted(p) || ignoredGold(g.value)) return;
      total += samples;
      if (!same(p.value, g.value)) wrong += samples;
    });
    return total === 0
      ? { state: "uncovered" }
      : { state: "scored", value: wrong / total, pooled: [wrong, total] };
  },
});
const brier = (capability: ConfidenceCapability): Definition => ({
  capability,
  kind: "calibration",
  better: "lower",
  unit: "squared_probability",
  score: (context) => {
    if (regionsOf(context) === null) return notApplicable;
    const cells = calibrationCells(context.gold, context.view);
    const total = cells.reduce((sum, c) => sum + c.samples, 0);
    const loss = cells.reduce(
      (sum, c) => sum + c.samples * (c.confidence - (c.correct ? 1 : 0)) ** 2,
      0,
    );
    return total === 0
      ? { state: "uncovered" }
      : { state: "scored", value: loss / total, pooled: [loss, total] };
  },
});
const diagnostic = (score: Definition["score"]): Definition => ({
  capability: "chords",
  kind: "diagnostic",
  better: "higher",
  unit: "ratio",
  score,
});
const quality = (
  capability: Definition["capability"],
  unit: string,
  score: Definition["score"],
  better: Definition["better"] = "higher",
): Definition => ({ capability, kind: "quality", better, unit, score });
const coverageMetric = (
  capability: Definition["capability"],
  unit: string,
  score: Definition["score"],
): Definition => ({
  capability,
  kind: "coverage",
  better: "higher",
  unit,
  score,
});
function segmentation(context: Context, direction: "over" | "under" | "both"): MetricValue {
  if (context.gold.capability !== "chords" || context.view.chords.length === 0)
    return context.gold.capability === "chords" ? { state: "uncovered" } : notApplicable;
  const merge = (items: (Interval & { value: unknown })[]) =>
    items.reduce<Interval[]>((merged, item, index) => {
      const last = merged.at(-1);
      if (last && index > 0 && same(items[index - 1]!.value, item.value))
        last.endSample = item.endSample;
      else merged.push({ startSample: item.startSample, endSample: item.endSample });
      return merged;
    }, []);
  const reference = merge(context.gold.events),
    estimate = merge(context.view.chords);
  const distance = (from: Interval[], to: Interval[]) => {
    const points = boundaries(to);
    const total = from.reduce((sum, item) => {
      const inner = points.filter((p) => p >= item.startSample && p < item.endSample);
      const cuts = [item.startSample, ...inner, item.endSample];
      const gap = Math.max(...cuts.slice(1).map((cut, index) => cut - cuts[index]!));
      return sum + (item.endSample - item.startSample - gap);
    }, 0);
    return total / (from.at(-1)!.endSample - from[0]!.startSample);
  };
  const over = 1 - distance(reference, estimate),
    under = 1 - distance(estimate, reference);
  const value = direction === "over" ? over : direction === "under" ? under : Math.min(over, under);
  return { state: "scored", value, pooled: null };
}

export const METRICS = {
  "chords.exact": regionExactMetric("chords"),
  "chords.coverage": regionCoverage("chords"),
  "chords.low_confidence_share": lowConfidenceShare("chords"),
  "chords.selective_error": selectiveError("chords"),
  "chords.brier": brier("chords"),
  "chords.mirex_root": quality("chords", "duration_ratio", (c) =>
    vocabulary(c, () => true, 0, false),
  ),
  "chords.mirex_majmin": quality("chords", "duration_ratio", (c) =>
    vocabulary(c, (r) => majMin.some((q) => same(q, r.bits.slice(0, 8))), 8, true),
  ),
  "chords.mirex_sevenths": quality("chords", "duration_ratio", (c) =>
    vocabulary(c, (r) => sevenths.some((q) => same(q, r.bits)), 12, true),
  ),
  "chords.overseg": diagnostic((c) => segmentation(c, "over")),
  "chords.underseg": diagnostic((c) => segmentation(c, "under")),
  "chords.seg": diagnostic((c) => segmentation(c, "both")),
  "key.exact": regionExactMetric("key"),
  "key.coverage": regionCoverage("key"),
  "key.low_confidence_share": lowConfidenceShare("key"),
  "key.selective_error": selectiveError("key"),
  "key.brier": brier("key"),
  "sections.label_accuracy": regionExactMetric("sections"),
  "sections.coverage": regionCoverage("sections"),
  "sections.low_confidence_share": lowConfidenceShare("sections"),
  "sections.selective_error": selectiveError("sections"),
  "sections.brier": brier("sections"),
  "sections.boundary_f_500ms": quality("sections", "f_measure", (c) => sectionBoundaries(c, 500)),
  "sections.boundary_f_3s": quality("sections", "f_measure", (c) => sectionBoundaries(c, 3000)),
  "rhythm.beat_f": quality("rhythm", "f_measure", (c) => beatF(c, false)),
  "rhythm.downbeat_f": quality("rhythm", "f_measure", (c) => beatF(c, true)),
  "rhythm.coverage": coverageMetric("rhythm", "duration_ratio", meteredCoverage),
  "rhythm.tempo_log2_error_median": quality(
    "rhythm",
    "absolute_log2_ratio",
    (c) => {
      const result = tempoErrors(c);
      return result === null
        ? notApplicable
        : conditional(result.errors, result.reference > 0, median);
    },
    "lower",
  ),
  "rhythm.tempo_coverage": coverageMetric("rhythm", "ratio", (c) => {
    const result = tempoErrors(c);
    return result === null ? notApplicable : ratio(result.errors.length, result.reference);
  }),
  "meter.exact": quality("meter", "duration_ratio", (c) =>
    c.gold.capability === "meter"
      ? agreement(
          meterLabels(c.gold.bars, c.gold.unmeteredRegions),
          meterLabels(c.view.bars, c.view.unmetered),
          (g, p) => (p?.label === g.label ? "correct" : "wrong"),
        )
      : notApplicable,
  ),
  "meter.coverage": coverageMetric("meter", "duration_ratio", meteredCoverage),
  "lyrics.word_coverage": lyricCoverage("tokens"),
  "lyrics.word_start_error_median": lyricError("tokens", "start", median),
  "lyrics.word_end_error_median": lyricError("tokens", "end", median),
  "lyrics.word_boundary_error_max": lyricError("tokens", "both", maximum),
  "lyrics.line_coverage": lyricCoverage("lines"),
  "lyrics.line_start_error_median": lyricError("lines", "start", median),
  "lyrics.line_end_error_median": lyricError("lines", "end", median),
  "lyrics.line_boundary_error_max": lyricError("lines", "both", maximum),
} satisfies Record<string, Definition>;
export type MetricId = keyof typeof METRICS;
export type MetricDefinition = Definition;
const isMetricId = (id: string): id is MetricId => Object.hasOwn(METRICS, id);
export const METRIC_IDS: MetricId[] = Object.keys(METRICS).filter(isMetricId);
export const MetricIdSchema = z.custom<MetricId>(
  (id) => typeof id === "string" && isMetricId(id),
  "Unknown benchmark metric",
);
export type TrackScores = Map<MetricId, MetricValue>;

export function scoreTrack(
  gold: AnnotationContent[],
  view: PredictionView,
  sampleRate: number,
): TrackScores {
  return new Map(
    METRIC_IDS.map((id) => {
      const definition: Definition = METRICS[id];
      const reference = gold.find((content) => content.capability === definition.capability);
      return [
        id,
        reference ? definition.score({ gold: reference, view, sampleRate }) : notApplicable,
      ];
    }),
  );
}

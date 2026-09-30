import { expect, it } from "vitest";

import { ProcedureSchema, readOutput, scoreTrack } from "../tools/benchmark/index.ts";
import { fixtureHash, goldFor } from "./support/benchmark-fixture.ts";
import {
  assertion,
  chord,
  completed,
  goldChords,
  procedure,
} from "./support/benchmark-gate-fixture.ts";

const { confidence } = ProcedureSchema.parse(procedure(fixtureHash));
const chords = (events: { startSample: number; endSample: number; value: unknown }[]) => ({
  capability: "chords",
  events: events.map((event, index) => ({ ...event, id: `chord_${index}` })),
});
function score(contents: ({ capability: string } & Record<string, unknown>)[], output: unknown) {
  const gold = contents.map(
    (content) => goldFor("track_metric", fixtureHash, content).adjudication.result,
  );
  const read = readOutput(output, 48000, gold, confidence);
  return Object.fromEntries([...scoreTrack(gold, read.view, 48000), ["outcome", read.outcome]]);
}
const valueOf = (metric: unknown) => {
  if (typeof metric !== "object" || metric === null || !("value" in metric))
    throw new Error("unscored");
  return metric.value;
};
const confident = goldChords.map((piece) => ({ ...piece, confidence: 1 }));

it("keeps abstained and failed duration in chord denominators and scores failure like total abstention", () => {
  const gold = [chords(goldChords)];
  const partial = score(
    gold,
    completed([
      { startSample: 0, endSample: 12000, value: chord("C", "major"), confidence: 0.9 },
      { startSample: 12000, endSample: 24000, value: chord("C", "major"), state: "abstained" },
      {
        startSample: 24000,
        endSample: 48000,
        value: chord("A", "minor"),
        state: "low_confidence",
        confidence: 0.6,
      },
    ]),
  );
  expect(partial).toMatchObject({
    outcome: "completed",
    "chords.exact": { state: "scored", value: 0.75, pooled: [36000, 48000] },
    "chords.coverage": { state: "scored", value: 0.75, pooled: [36000, 48000] },
    "chords.low_confidence_share": { state: "scored", value: 0.5 },
    "chords.selective_error": { state: "scored", value: 0, pooled: [0, 36000] },
    "chords.mirex_root": { state: "scored", value: 0.75 },
    "chords.seg": { state: "scored", value: 1 },
  });
  expect(valueOf(partial["chords.brier"])).toBeCloseTo((12000 * 0.01 + 24000 * 0.16) / 36000, 12);

  const failed = score(gold, { kind: "failed", failureClass: "decode_failed" });
  const abstained = score(
    gold,
    completed(goldChords.map((piece) => ({ ...piece, state: "abstained" as const }))),
  );
  for (const result of [failed, abstained])
    expect(result).toMatchObject({
      "chords.exact": { state: "scored", value: 0, pooled: [0, 48000] },
      "chords.coverage": { state: "scored", value: 0, pooled: [0, 48000] },
      "chords.selective_error": { state: "uncovered" },
      "chords.brier": { state: "uncovered" },
    });
  expect([failed.outcome, abstained.outcome]).toEqual(["failed", "completed"]);
  const merged = score(gold, completed([{ ...goldChords[0]!, endSample: 48000, confidence: 1 }]));
  expect(merged["chords.exact"]).toEqual({ state: "scored", value: 0.5, pooled: [24000, 48000] });
});

it("treats invalid timelines and omitted declared confidence as invalid output scored at zero", () => {
  const gold = [chords(goldChords)];
  const truncated = score(
    gold,
    completed([{ ...goldChords[0]!, endSample: 47000, confidence: 1 }]),
  );
  expect(truncated).toMatchObject({
    outcome: "invalid",
    "chords.exact": { state: "scored", value: 0 },
  });
  expect(score(gold, completed(goldChords)).outcome).toBe("invalid");
  expect(score(gold, completed(confident)).outcome).toBe("completed");
});

it("projects structured chords onto MIREX root, majmin and sevenths with published eligible duration", () => {
  const gold = [
    chords([
      { startSample: 0, endSample: 16000, value: chord("C", "major7") },
      { startSample: 16000, endSample: 32000, value: chord("C", "sus4") },
      { startSample: 32000, endSample: 48000, value: chord("C", "major", "E") },
    ]),
  ];
  const result = score(
    gold,
    completed([{ startSample: 0, endSample: 48000, value: chord("C", "major"), confidence: 0.5 }]),
  );
  expect(result).toMatchObject({
    "chords.exact": { value: 0, pooled: [0, 48000] },
    "chords.mirex_root": { value: 1, pooled: [48000, 48000] },
    "chords.mirex_majmin": { value: 1, pooled: [32000, 32000] },
    "chords.mirex_sevenths": { value: 0.5, pooled: [16000, 32000] },
    "chords.overseg": { value: 1 },
  });
  expect(valueOf(result["chords.underseg"])).toBeCloseTo(1 / 3, 12);
});

it("scores beats, downbeats, tempo and meter over the full range with a 70 ms window", () => {
  const beats = (times: number[]) =>
    times.map((atSample, index) => ({
      id: `beat_${index}`,
      atSample,
      role: index === 0 ? "downbeat" : "beat",
    }));
  const bar = {
    id: "bar_one",
    startSample: 0,
    endSample: 48000,
    meter: { numerator: 4, denominator: 4 },
    status: "complete",
    beats: beats([0, 12000, 24000, 36000]),
  };
  const gold = [
    { capability: "rhythm", bars: [bar], unmeteredRegions: [] },
    { capability: "meter", bars: [bar], unmeteredRegions: [] },
  ];
  const result = score(
    gold,
    completed(confident, {
      bars: [{ ...bar, startSample: 3000, beats: beats([3000, 15500, 24000, 36000]) }],
      unmeteredRegions: [{ id: "unmetered_one", startSample: 0, endSample: 3000, reasonCode: "x" }],
    }),
  );
  expect(result).toMatchObject({
    "rhythm.beat_f": { value: 0.75, pooled: [6, 8] },
    "rhythm.downbeat_f": { value: 1, pooled: [2, 2] },
    "rhythm.coverage": { value: 0.9375 },
    "rhythm.tempo_coverage": { value: 1, pooled: [3, 3] },
    "meter.exact": { value: 0.9375 },
    "meter.coverage": { value: 0.9375 },
    "chords.exact": { state: "not_applicable" },
  });
  expect(valueOf(result["rhythm.tempo_log2_error_median"])).toBeCloseTo(
    Math.log2(12500 / 12000),
    12,
  );
  const silence = { id: "unmetered_one", startSample: 0, endSample: 48000, reasonCode: "x" };
  const unmetered = score(
    [{ capability: "rhythm", bars: [], unmeteredRegions: [silence] }],
    completed(confident, { bars: [bar], unmeteredRegions: [] }),
  );
  expect(unmetered["rhythm.beat_f"]).toEqual({ state: "not_applicable" });
  expect(unmetered["rhythm.coverage"]).toEqual({ state: "not_applicable" });
});

it("pairs section boundary and label scores with asserted coverage", () => {
  const gold = [
    {
      capability: "sections",
      events: [
        { id: "section_a", startSample: 0, endSample: 24000, label: "verse", groupId: "group_a" },
        {
          id: "section_b",
          startSample: 24000,
          endSample: 48000,
          label: "chorus",
          groupId: "group_b",
        },
      ],
    },
  ];
  const regions = [
    [0, 12000, "verse", "asserted"],
    [12000, 24000, "chorus", "asserted"],
    [24000, 48000, "chorus", "abstained"],
  ] as const;
  const result = score(
    gold,
    completed(confident, {
      sectionRegions: regions.map(([startSample, endSample, label, state], index) => ({
        id: `section_${index}`,
        startSample,
        endSample,
        label,
        assertion: assertion(state),
      })),
    }),
  );
  expect(result).toMatchObject({
    "sections.label_accuracy": { value: 0.25 },
    "sections.coverage": { value: 0.5 },
    "sections.selective_error": { value: 0.5 },
    "sections.boundary_f_500ms": { pooled: [6, 7] },
  });
});

it("reports word and line coverage beside conditional timing error", () => {
  const document = {
    id: "lyrics_fixture",
    text: "la la",
    language: "en",
    attribution: ["Synthetic"],
    notices: [],
    provenance: { provider: "fixture", reference: "synthetic" },
    suppliedTimingKind: "untimed",
    tokenization: { scheme: "fixture", version: "1" },
    lines: [{ id: "line_one", startOffset: 0, endOffset: 5 }],
    tokens: [
      { id: "token_one", lineId: "line_one", startOffset: 0, endOffset: 2, text: "la" },
      { id: "token_two", lineId: "line_one", startOffset: 3, endOffset: 5, text: "la" },
    ],
  };
  const matched = (startSample: number, endSample: number) => ({
    state: "matched",
    startSample,
    endSample,
  });
  const gold = [
    {
      capability: "lyrics_alignment",
      document,
      tokens: [
        { tokenId: "token_one", timing: matched(0, 12000) },
        { tokenId: "token_two", timing: matched(24000, 36000) },
      ],
      lines: [{ lineId: "line_one", timing: matched(0, 36000) }],
    },
  ];
  const aligned = (startSample: number, endSample: number) => ({
    ...matched(startSample, endSample),
    assertion: { state: "asserted", evidence: [], reasonCodes: [] },
  });
  const lyrics = {
    occurrences: [
      { tokenId: "token_one", timing: aligned(2400, 12000) },
      { tokenId: "token_two", timing: { state: "unmatched", reasonCode: "oov" } },
    ],
    lineOccurrences: [{ lineId: "line_one", timing: aligned(0, 40800) }],
  };
  expect(score(gold, completed(confident, {}, lyrics))).toMatchObject({
    "lyrics.word_coverage": { value: 0.5, pooled: [1, 2] },
    "lyrics.word_start_error_median": { value: 0.05 },
    "lyrics.word_end_error_median": { value: 0 },
    "lyrics.word_boundary_error_max": { value: 0.05 },
    "lyrics.line_coverage": { value: 1 },
    "lyrics.line_end_error_median": { value: 0.1 },
  });
  const renamed = structuredClone(lyrics);
  renamed.occurrences[1]!.tokenId = "token_three";
  expect(score(gold, completed(confident, {}, renamed))).toMatchObject({
    outcome: "invalid",
    "lyrics.word_coverage": { value: 0 },
    "lyrics.word_start_error_median": { state: "uncovered" },
  });
});

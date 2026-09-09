import { expect, it } from "vitest";

import { buildGoldReference, contentHash, parseGoldReference } from "../tools/benchmark/index.ts";

const hash = `sha256:${"1".repeat(64)}`;
const raw = (person: string, end = 48000) => ({
  version: "1.0",
  id: `annotation_${person}`,
  trackId: "track_fixture",
  audioHash: hash,
  guideHash: hash,
  sampleRate: 48000,
  durationSamples: 48000,
  createdAt: "2026-09-09T00:00:00Z",
  source: "synthetic_fixture",
  blindToSystemOutputs: true,
  blindToOtherAnnotations: true,
  annotator: {
    id: `person_${person}`,
    qualification: { capability: "chords", evidenceHash: hash, reviewerId: "person_qualifier" },
  },
  tool: { name: "synthetic fixture", version: "1.0" },
  ambiguity: [],
  content: {
    capability: "chords",
    events: [{ id: "chord_one", startSample: 0, endSample: end, value: { kind: "no_chord" } }],
  },
});
it("preserves agreeing independent submissions under a third adjudicator identity", () => {
  const first = raw("first"),
    second = raw("second");
  second.content.events[0]!.value = { kind: "no_chord" };
  const gold = buildGoldReference({
    annotations: [first, second],
    adjudication: {
      source: "synthetic_fixture",
      id: "gold_fixture",
      createdAt: "2026-09-09T01:00:00Z",
      guideHash: hash,
      adjudicator: {
        id: "person_third",
        qualification: { capability: "chords", evidenceHash: hash, reviewerId: "person_qualifier" },
      },
      rawHashes: [contentHash(first), contentHash(second)],
      result: first.content,
      decisions: [],
    },
  });
  expect(gold.annotations).toEqual([first, second]);
  expect(gold.disagreements).toEqual([]);
  expect(parseGoldReference(gold)).toEqual(gold);
  const selfAdjudicated = structuredClone(gold);
  selfAdjudicated.adjudication.adjudicator.id = "person_first";
  expect(() => parseGoldReference(selfAdjudicated)).toThrow(Error);
  const invalid = raw("first", 47000);
  expect(() =>
    buildGoldReference({ annotations: [invalid, second], adjudication: gold.adjudication }),
  ).toThrow(Error);
});

it("requires an explicit reason for a real disagreement and detects later raw changes", () => {
  const first = raw("first"),
    second = raw("second");
  const chord = {
    kind: "chord",
    root: "C",
    quality: "major",
    additions: [],
    alterations: [],
    extensions: [],
    omissions: [],
  };
  const changed = {
    ...second,
    content: { capability: "chords", events: [{ ...second.content.events[0], value: chord }] },
  };
  const input = {
    annotations: [first, changed],
    adjudication: {
      source: "synthetic_fixture",
      id: "gold_changed",
      createdAt: "2026-09-09T01:00:00Z",
      guideHash: hash,
      adjudicator: {
        id: "person_third",
        qualification: { capability: "chords", evidenceHash: hash, reviewerId: "person_qualifier" },
      },
      rawHashes: [contentHash(first), contentHash(changed)],
      result: first.content,
      decisions: [] as { startSample: number; endSample: number; reason: string }[],
    },
  };
  expect(() => buildGoldReference(input)).toThrow("Every disagreement");
  input.adjudication.decisions = [
    { startSample: 0, endSample: 48000, reason: "Synthetic fixture adjudication" },
  ];
  const gold = buildGoldReference(input);
  expect(gold.disagreements).toEqual([
    { startSample: 0, endSample: 48000, reason: "annotation_difference" },
  ]);
  const altered = structuredClone(gold);
  altered.annotations[0].tool.version = "changed";
  expect(() => parseGoldReference(altered)).toThrow("immutable raw annotations");
});

it("requires a reason even when adjudication changes two agreeing submissions", () => {
  const first = raw("first"),
    second = raw("second");
  const result = {
    ...first.content,
    events: [
      {
        ...first.content.events[0],
        value: {
          kind: "chord",
          root: "C",
          quality: "major",
          extensions: [],
          additions: [],
          alterations: [],
          omissions: [],
        },
      },
    ],
  };
  expect(() =>
    buildGoldReference({
      annotations: [first, second],
      adjudication: {
        source: "synthetic_fixture",
        id: "gold_changed",
        createdAt: "2026-09-09T01:00:00Z",
        guideHash: hash,
        adjudicator: {
          id: "person_third",
          qualification: {
            capability: "chords",
            evidenceHash: hash,
            reviewerId: "person_qualifier",
          },
        },
        rawHashes: [contentHash(first), contentHash(second)],
        result,
        decisions: [],
      },
    }),
  ).toThrow(Error);
});

it("matches an independently calculated canonical SHA-256 vector", () => {
  expect(contentHash({ b: 2, a: 1 })).toBe(
    "sha256:080d51f49b27c73d17f51f3b808515a425d16218aa40021eed2ca1d204e59224",
  );
});

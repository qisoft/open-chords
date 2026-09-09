import { readFileSync } from "node:fs";

import Ajv from "ajv-draft-04";
import addFormats from "ajv-formats";
import { expect, it } from "vitest";

import {
  buildGoldReference,
  chordToHarte,
  contentHash,
  goldFromJams,
  goldToJams,
} from "../tools/benchmark/index.ts";
import { fixtureHash, fixtureGold, rawAnnotation } from "./support/benchmark-fixture.ts";

it("round-trips raw and adjudicated sample identities through independently validated JAMS", () => {
  const first = rawAnnotation("first"),
    second = rawAnnotation("second");
  const gold = buildGoldReference({
    annotations: [first, second],
    adjudication: {
      source: "synthetic_fixture",
      id: "gold_fixture",
      createdAt: "2026-09-09T01:00:00Z",
      guideHash: fixtureHash,
      adjudicator: {
        id: "person_third",
        qualification: {
          capability: "chords",
          evidenceHash: fixtureHash,
          reviewerId: "person_qualifier",
        },
      },
      rawHashes: [contentHash(first), contentHash(second)],
      result: first.content,
      decisions: [],
    },
  });
  const jams = goldToJams(gold);
  const ajv = new Ajv({ strict: false });
  addFormats(ajv);
  const validate = ajv.compile(
    JSON.parse(readFileSync("tools/benchmark/schemata/vendor/jams-0.3.5.json", "utf8")),
  );
  expect(validate(jams)).toBe(true);
  expect(goldFromJams(jams)).toEqual(gold);
  expect(
    jams.annotations.filter((item) => item.namespace === "chord").map((item) => item.data),
  ).toEqual(
    Array.from({ length: 3 }, () => [{ time: 0, duration: 1, value: "N", confidence: null }]),
  );
  const corrupted = structuredClone(jams);
  corrupted.annotations[0]!.data[0]!.duration = 0.5;
  expect(() => goldFromJams(corrupted)).toThrow(Error);
});

it("exports an explicit Harte degree set and validates custom records independently", () => {
  const gold = fixtureGold();
  const chord = {
    kind: "chord",
    root: "C",
    quality: "major7",
    extensions: ["9"],
    additions: [],
    alterations: ["#11"],
    omissions: ["no5"],
    bass: "E",
  };
  expect(chordToHarte(chord)).toBe("C:(1,3,7,9,#11)/3");
  const jams = goldToJams(gold),
    ajv = new Ajv({ strict: false });
  addFormats(ajv);
  const namespaceFiles = [
    "open-chords-namespaces.json",
    "vendor/chord.json",
    "vendor/key_mode.json",
    "vendor/beat.json",
    "vendor/lyrics.json",
    "vendor/segment-open.json",
  ];
  const definitions: Record<string, { value: object }> = {};
  for (const file of namespaceFiles)
    Object.assign(
      definitions,
      JSON.parse(readFileSync(`tools/benchmark/schemata/${file}`, "utf8")),
    );
  for (const annotation of jams.annotations) {
    const validate = ajv.compile(definitions[annotation.namespace]!.value);
    for (const observation of annotation.data) expect(validate(observation.value)).toBe(true);
  }
  const value = { startSample: 0, endSample: 48000, sampleRate: -1, record: gold.annotations[0] };
  expect(ajv.compile(definitions.open_chords_raw_v1!.value)(value)).toBe(false);
  expect(ajv.compile(definitions.chord!.value)(chordToHarte(chord))).toBe(true);
});

it.each(["key", "sections", "rhythm", "meter", "lyrics_alignment"] as const)(
  "preserves %s identity through its JAMS projection",
  (capability) => {
    const content =
      capability === "key"
        ? {
            capability,
            events: [
              {
                id: "key_one",
                startSample: 0,
                endSample: 48000,
                value: { kind: "key", tonic: "D", mode: "dorian" },
              },
            ],
          }
        : capability === "sections"
          ? {
              capability,
              events: [
                {
                  id: "section_one",
                  startSample: 0,
                  endSample: 24000,
                  label: "verse",
                  groupId: "group_verse",
                },
                {
                  id: "section_two",
                  startSample: 24000,
                  endSample: 48000,
                  label: "verse",
                  groupId: "group_verse",
                },
              ],
            }
          : capability === "rhythm" || capability === "meter"
            ? {
                capability,
                bars: [
                  {
                    id: "bar_one",
                    startSample: 0,
                    endSample: 48000,
                    status: "complete",
                    meter: { numerator: 2, denominator: 4 },
                    beats: [
                      { id: "beat_one", atSample: 0, role: "downbeat" },
                      { id: "beat_two", atSample: 24000, role: "beat" },
                    ],
                  },
                ],
                unmeteredRegions: [],
              }
            : {
                capability,
                document: {
                  id: "lyrics_one",
                  text: "la la",
                  language: "en",
                  attribution: ["Synthetic"],
                  notices: [],
                  provenance: { provider: "fixture", reference: "synthetic" },
                  suppliedTimingKind: "untimed",
                  tokenization: { scheme: "fixture", version: "1" },
                  lines: [{ id: "line_one", startOffset: 0, endOffset: 5 }],
                  tokens: [
                    {
                      id: "token_one",
                      lineId: "line_one",
                      startOffset: 0,
                      endOffset: 2,
                      text: "la",
                    },
                    {
                      id: "token_two",
                      lineId: "line_one",
                      startOffset: 3,
                      endOffset: 5,
                      text: "la",
                    },
                  ],
                },
                tokens: [
                  {
                    tokenId: "token_one",
                    timing: { state: "matched", startSample: 0, endSample: 24000 },
                  },
                  { tokenId: "token_two", timing: { state: "unmatched", reason: "synthetic OOV" } },
                ],
                lines: [
                  {
                    lineId: "line_one",
                    timing: { state: "matched", startSample: 0, endSample: 48000 },
                  },
                ],
              };
    const pair = ["first", "second"].map((person) => {
      const raw = rawAnnotation(person);
      return {
        ...raw,
        content,
        annotator: {
          ...raw.annotator,
          qualification: { ...raw.annotator.qualification, capability },
        },
      };
    });
    const template = fixtureGold();
    const gold = buildGoldReference({
      annotations: pair,
      adjudication: {
        ...template.adjudication,
        adjudicator: {
          ...template.adjudication.adjudicator,
          qualification: { ...template.adjudication.adjudicator.qualification, capability },
        },
        rawHashes: pair.map(contentHash),
        result: content,
      },
    });
    const jams = goldToJams(gold);
    expect(goldFromJams(jams)).toEqual(gold);
    const ajv = new Ajv({ strict: false });
    addFormats(ajv);
    for (const [namespace, file] of [
      ["key_mode", "key_mode.json"],
      ["segment_open", "segment-open.json"],
      ["beat", "beat.json"],
      ["lyrics", "lyrics.json"],
    ]) {
      const definitions = JSON.parse(
        readFileSync(`tools/benchmark/schemata/vendor/${file}`, "utf8"),
      );
      const validate = ajv.compile(definitions[namespace!].value);
      for (const annotation of jams.annotations.filter((a) => a.namespace === namespace))
        for (const observation of annotation.data) expect(validate(observation.value)).toBe(true);
    }
  },
);

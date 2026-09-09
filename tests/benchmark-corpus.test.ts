import { expect, it } from "vitest";

import { auditCorpus, buildGoldReference, contentHash } from "../tools/benchmark/index.ts";
import { corpusFixture, fixtureContext } from "./support/benchmark-fixture.ts";

it("accounts for distinct eligible tracks per capability, slice and cohort without promoting synthetic evidence", () => {
  const { manifest, gold } = corpusFixture();
  const report = auditCorpus(manifest, gold, fixtureContext);
  expect(report.releaseEvidence).toBe(false);
  expect(report.rows).toEqual([
    {
      capability: "chords",
      slice: "slice_synthetic",
      cohort: "calibration",
      tracks: 1,
      trackSeconds: 1,
      events: 0,
      eventSeconds: 0,
      negativeEvents: 1,
      negativeSeconds: 1,
    },
    {
      capability: "chords",
      slice: "slice_synthetic",
      cohort: "sealed",
      tracks: 1,
      trackSeconds: 1,
      events: 0,
      eventSeconds: 0,
      negativeEvents: 1,
      negativeSeconds: 1,
    },
  ]);
  const denied = structuredClone(manifest);
  denied.tracks[0]!.rights[0]!.disposition = "ambiguous";
  expect(auditCorpus(denied, gold, fixtureContext).rows[0]!.tracks).toBe(0);
  expect(auditCorpus(manifest, gold, fixtureContext)).toEqual(report);
});
it("rejects recording leakage, undisclosed composition crossings and substituted references", () => {
  const { manifest, gold } = corpusFixture();
  const leaked = structuredClone(manifest);
  leaked.tracks[1]!.recordingGroupId = leaked.tracks[0]!.recordingGroupId;
  expect(() => auditCorpus(leaked, gold, fixtureContext)).toThrow(/recording/);
  const related = structuredClone(manifest);
  related.tracks[1]!.compositionGroupId = related.tracks[0]!.compositionGroupId;
  expect(() => auditCorpus(related, gold, fixtureContext)).toThrow(/relationship/);
  expect(() => auditCorpus(manifest, [gold[0], gold[0]], fixtureContext)).toThrow(/Reference/);
});
it("cannot relabel synthetic annotations as a real corpus", () => {
  const { manifest, gold } = corpusFixture();
  manifest.purpose = "release_corpus";
  expect(() => auditCorpus(manifest, gold, fixtureContext)).toThrow(/Synthetic/);
});

it("retains Unmetered inventory without counting it as beat evidence", () => {
  const { manifest, gold } = corpusFixture();
  const references = gold.map((reference) => {
    const content = {
      capability: "rhythm",
      bars: [],
      unmeteredRegions: [
        {
          id: "unmetered_one",
          startSample: 0,
          endSample: 48000,
          reasonCode: "synthetic unmetered",
        },
      ],
    };
    const annotations = reference.annotations.map((raw) => ({
      ...raw,
      content,
      annotator: {
        ...raw.annotator,
        qualification: { ...raw.annotator.qualification, capability: "rhythm" },
      },
    }));
    return buildGoldReference({
      annotations,
      adjudication: {
        ...reference.adjudication,
        result: content,
        rawHashes: annotations.map(contentHash),
        adjudicator: {
          ...reference.adjudication.adjudicator,
          qualification: {
            ...reference.adjudication.adjudicator.qualification,
            capability: "rhythm",
          },
        },
      },
    });
  });
  manifest.requirements[0]!.capability = "rhythm";
  manifest.tracks.forEach((track, index) => {
    track.goldHashes = [references[index]!.hash];
  });
  const report = auditCorpus(manifest, references, fixtureContext);
  expect(report.rows[0]).toEqual({
    capability: "rhythm",
    slice: "slice_synthetic",
    cohort: "calibration",
    tracks: 1,
    trackSeconds: 1,
    events: 0,
    eventSeconds: 0,
    negativeEvents: 1,
    negativeSeconds: 1,
  });
  expect(report.inventoryComplete).toBe(true);
  expect(report.metricSufficiency).toBe("not_evaluated");
});

it("rejects a missing lyrics subject even when a sentinel-named grant exists", () => {
  const { manifest, gold } = corpusFixture();
  const content = {
    capability: "lyrics_alignment",
    document: {
      id: "lyrics_fixture",
      text: "la",
      language: "en",
      attribution: ["Synthetic"],
      notices: [],
      provenance: { provider: "fixture", reference: "synthetic" },
      suppliedTimingKind: "untimed",
      tokenization: { scheme: "fixture", version: "1" },
      lines: [{ id: "line_one", startOffset: 0, endOffset: 2 }],
      tokens: [{ id: "token_one", lineId: "line_one", startOffset: 0, endOffset: 2, text: "la" }],
    },
    tokens: [
      { tokenId: "token_one", timing: { state: "matched", startSample: 0, endSample: 48000 } },
    ],
    lines: [{ lineId: "line_one", timing: { state: "matched", startSample: 0, endSample: 48000 } }],
  };
  const references = gold.map((reference) => {
    const annotations = reference.annotations.map((raw) => ({
      ...raw,
      content,
      annotator: {
        ...raw.annotator,
        qualification: { ...raw.annotator.qualification, capability: "lyrics_alignment" },
      },
    }));
    return buildGoldReference({
      annotations,
      adjudication: {
        ...reference.adjudication,
        result: content,
        rawHashes: annotations.map(contentHash),
        adjudicator: {
          ...reference.adjudication.adjudicator,
          qualification: {
            ...reference.adjudication.adjudicator.qualification,
            capability: "lyrics_alignment",
          },
        },
      },
    });
  });
  manifest.requirements[0]!.capability = "lyrics_alignment";
  manifest.tracks.forEach((track, index) => {
    track.goldHashes = [references[index]!.hash];
    track.rights.push({ ...track.rights[0]!, asset: "lyrics", subjectId: "missing_lyrics" });
  });
  expect(() => auditCorpus(manifest, references, fixtureContext)).toThrow(/lyrics subject/);
});

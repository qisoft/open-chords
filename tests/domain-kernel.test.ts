import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parseContractEnvelope, ProjectEnvelopeSchema } from "@open-chords/contracts";
import {
  canonicalSerialize,
  materializeEffectiveTimeline,
  parseProjectContract,
} from "@open-chords/domain";
import { mutateFixture, parseMutationCases } from "@open-chords/testkit/mutations";
import { describe, expect, it } from "vitest";

const fixtureRoot = join(import.meta.dirname, "../packages/testkit/contracts/v1");

function readFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(fixtureRoot, name), "utf8"));
}

function readGoldenEnvelope() {
  return ProjectEnvelopeSchema.parse(readFixture("valid/project-envelope.json"));
}

function readGoldenProject(): unknown {
  return readGoldenEnvelope().payload;
}

type ParsedProject = ReturnType<typeof parseProjectContract>;
type EditOperation =
  ParsedProject["editLayers"][number]["transactions"][number]["operations"][number];

function projectWithOperation(operation: EditOperation): ParsedProject {
  const project = structuredClone(parseProjectContract(readGoldenProject()));
  const layer = project.editLayers[0];
  if (layer === undefined) throw new Error("Golden fixture Edit Layer is missing");
  layer.transactions.push({
    id: "transaction_projection",
    operations: [operation],
    parentTransactionId: null,
  });
  project.activeView.editHistoryPosition = layer.transactions.length;
  return parseProjectContract(project);
}

describe("canonical domain kernel", () => {
  it("parses the golden Project contract and materializes its explicitly selected stale revision", () => {
    const project = parseProjectContract(readGoldenProject());
    const effective = materializeEffectiveTimeline(project);
    expect(project.activeView.analysisRevisionId).toBe("revision_original");
    expect(project.analysisRevisions.at(-1)?.id).toBe("revision_reviewable");
    expect(effective.chordEvents.map((event) => event.value.kind)).toEqual([
      "chord",
      "chord",
      "no_chord",
      "chord",
    ]);
    expect(effective.chordEvents[0]?.value).toMatchObject({ quality: "minor7", root: "A" });
  });

  it("serializes independent of object insertion order", () => {
    expect(canonicalSerialize({ z: 1, a: { d: 2, b: 1 } })).toBe(
      '{\n  "a": {\n    "b": 1,\n    "d": 2\n  },\n  "z": 1\n}\n',
    );
  });

  it("rejects unsupported values instead of silently deleting them", () => {
    expect(() => canonicalSerialize({ missing: undefined })).toThrow(/unsupported/);
    expect(() => canonicalSerialize(new Date(0))).toThrow(/non-plain/);
    expect(() => canonicalSerialize(new Map())).toThrow(/non-plain/);
  });

  it("parses the strict versioned envelope", () => {
    expect(parseContractEnvelope(readGoldenEnvelope()).compatibility).toBe("writable");
  });

  it("keeps N distinct from machine abstention and repeated lyric occurrences distinct by ID", () => {
    const project = parseProjectContract(readGoldenProject());
    const timeline = project.analysisRevisions[0]?.timeline;
    expect(timeline?.chordEvents.find(({ id }) => id === "chord_n")).toMatchObject({
      assertion: { state: "asserted" },
      value: { kind: "no_chord" },
    });
    expect(timeline?.chordEvents.find(({ id }) => id === "chord_c_sharp")).toMatchObject({
      assertion: { state: "abstained" },
      value: { kind: "chord" },
    });
    expect(
      project.lyricsDocuments[0]?.tokens.filter(({ text }) => text === "go").map(({ id }) => id),
    ).toEqual(["token_go_1", "token_go_2", "token_go_3"]);
  });

  it("projects only the selected committed Edit Layer history position without mutating machine output", () => {
    const input = structuredClone(parseProjectContract(readGoldenProject()));
    input.activeView.editHistoryPosition = 1;
    const project = parseProjectContract(input);
    const effective = materializeEffectiveTimeline(project);
    expect(effective.chordEvents[0]?.value).toMatchObject({ quality: "major" });
    expect(project.analysisRevisions[0]?.timeline.chordEvents[0]?.value).toMatchObject({
      quality: "minor7",
    });
  });

  it("retains transaction branches and projects only the selected ancestor chain", () => {
    const input = structuredClone(parseProjectContract(readGoldenProject()));
    const layer = input.editLayers[0];
    if (layer === undefined) throw new Error("Golden fixture Edit Layer is missing");
    layer.transactions.push(
      {
        id: "transaction_child",
        operations: [
          {
            eventId: "chord_am7_e",
            type: "replace_chord_value",
            value: {
              additions: [],
              alterations: [],
              extensions: [],
              kind: "chord",
              omissions: [],
              quality: "minor",
              root: "A",
            },
          },
        ],
        parentTransactionId: "transaction_unselected",
      },
      {
        id: "transaction_branch",
        operations: [
          {
            eventId: "chord_am7_e",
            type: "replace_chord_value",
            value: {
              additions: [],
              alterations: [],
              extensions: [],
              kind: "chord",
              omissions: [],
              quality: "diminished",
              root: "A",
            },
          },
        ],
        parentTransactionId: null,
      },
    );
    input.activeView.editHistoryPosition = 3;
    expect(
      materializeEffectiveTimeline(parseProjectContract(input)).chordEvents[0]?.value,
    ).toMatchObject({ quality: "diminished" });
  });

  it("projects committed Beat, Bar/meter, and lyric timing operations", () => {
    const beat = materializeEffectiveTimeline(
      projectWithOperation({ atSample: 17000, beatId: "beat_three_2", type: "move_beat" }),
    );
    expect(beat.bars[1]?.beats[1]?.atSample).toBe(17000);

    const meter = materializeEffectiveTimeline(
      projectWithOperation({
        barId: "bar_three_four",
        meter: { denominator: 8, numerator: 3 },
        type: "set_bar_meter",
      }),
    );
    expect(meter.bars[1]?.meter).toEqual({ denominator: 8, numerator: 3 });

    const barBoundary = materializeEffectiveTimeline(
      projectWithOperation({
        atSample: 9000,
        leftBarId: "bar_pickup",
        rightBarId: "bar_three_four",
        type: "move_bar_boundary",
      }),
    );
    expect(
      barBoundary.bars.slice(0, 2).map(({ endSample, startSample }) => [startSample, endSample]),
    ).toEqual([
      [0, 9000],
      [9000, 32000],
    ]);

    const chordBoundary = materializeEffectiveTimeline(
      projectWithOperation({
        atSample: 9000,
        leftEventId: "chord_am7_e",
        rightEventId: "chord_c_sharp",
        type: "move_chord_boundary",
      }),
    );
    expect(
      chordBoundary.chordEvents
        .slice(0, 2)
        .map(({ endSample, startSample }) => [startSample, endSample]),
    ).toEqual([
      [0, 9000],
      [9000, 20000],
    ]);

    const lyrics = materializeEffectiveTimeline(
      projectWithOperation({
        alignmentId: "alignment_repeated",
        timing: {
          assertion: { evidence: [], reasonCodes: ["user_authored"], state: "asserted" },
          endSample: 5000,
          startSample: 3000,
          state: "matched",
        },
        tokenId: "token_go_2",
        type: "set_lyrics_timing",
      }),
    );
    expect(lyrics.lyricsAlignment?.occurrences[1]?.timing).toMatchObject({
      endSample: 5000,
      startSample: 3000,
      state: "matched",
    });

    const lyricLine = materializeEffectiveTimeline(
      projectWithOperation({
        alignmentId: "alignment_repeated",
        lineId: "line_second",
        timing: {
          assertion: { evidence: [], reasonCodes: ["user_authored"], state: "asserted" },
          endSample: 29000,
          startSample: 21000,
          state: "matched",
        },
        type: "set_lyrics_line_timing",
      }),
    );
    expect(lyricLine.lyricsAlignment?.lineOccurrences[1]?.timing).toMatchObject({
      endSample: 29000,
      startSample: 21000,
      state: "matched",
    });
  });

  it("projects Bar split and merge as invariant-preserving structural edits", () => {
    const split = materializeEffectiveTimeline(
      projectWithOperation({
        atSample: 24000,
        barId: "bar_three_four",
        leftStatus: "truncated",
        newBarId: "bar_split",
        newDownbeatId: "beat_split",
        rightMeter: { denominator: 4, numerator: 1 },
        rightStatus: "complete",
        type: "split_bar",
      }),
    );
    expect(split.bars.map(({ id }) => id)).toEqual([
      "bar_pickup",
      "bar_three_four",
      "bar_split",
      "bar_truncated",
    ]);

    const merged = materializeEffectiveTimeline(
      projectWithOperation({
        leftBarId: "bar_pickup",
        meter: { denominator: 4, numerator: 5 },
        rightBarId: "bar_three_four",
        status: "complete",
        type: "merge_bars",
      }),
    );
    expect(merged.bars[0]).toMatchObject({ endSample: 32000, id: "bar_pickup" });
  });

  it.each(parseMutationCases(readFixture("invalid/cases.json")))(
    "rejects shared invalid fixture: $name",
    (mutation) => {
      const mutated = mutateFixture(readGoldenEnvelope(), mutation);
      expect(() => parseContractEnvelope(mutated)).toThrow(/./);
    },
  );

  it("rejects generated overlap and gap mutations across sample-frame boundaries", () => {
    for (let seed = 1; seed <= 64; seed += 1) {
      const boundary = 8000;
      const delta = (seed % 997) + 1;
      for (const candidate of [boundary - delta, boundary + delta]) {
        const envelope = readGoldenEnvelope();
        const event = envelope.payload.analysisRevisions[0]?.timeline.chordEvents[1];
        if (event === undefined) throw new Error("Golden fixture Chord Event is missing");
        event.startSample = candidate;
        expect(
          () => parseContractEnvelope(envelope),
          `seed ${String(seed)} candidate ${String(candidate)}`,
        ).toThrow(/./);
      }
    }
  });

  it("rejects non-finite values before projection", () => {
    const envelope = readGoldenEnvelope();
    const evidence =
      envelope.payload.analysisRevisions[0]?.timeline.chordEvents[0]?.assertion.evidence[0];
    if (evidence === undefined) throw new Error("Golden fixture evidence is missing");
    evidence.value = Number.NaN;
    expect(() => parseContractEnvelope(envelope)).toThrow(/NaN|finite/);
  });

  it("opens newer minor contracts read-only, preserves namespaced extensions, and rejects newer majors", () => {
    const newerMinor = readGoldenEnvelope();
    newerMinor.payload.schemaVersion = "1.1";
    expect(parseContractEnvelope(newerMinor).compatibility).toBe("read_only");
    newerMinor.schemaVersion = "1.1";
    expect(parseContractEnvelope(newerMinor)).toMatchObject({
      compatibility: "read_only",
      envelope: {
        extensions: { "org.openchords.fixture": { purpose: "golden cross-language corpus" } },
      },
    });
    newerMinor.schemaVersion = "2.0";
    expect(() => parseContractEnvelope(newerMinor)).toThrow(/major version/);
  });
});

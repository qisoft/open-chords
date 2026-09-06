import { readFileSync } from "node:fs";

import {
  applyPracticeAction,
  getPracticeState,
  parseProjectContract,
  resolvePracticeLoop,
} from "@open-chords/domain";
import { expect, it } from "vitest";

function projectFixture() {
  return parseProjectContract(
    JSON.parse(
      readFileSync(
        new URL("../packages/testkit/contracts/v1/valid/project-envelope.json", import.meta.url),
        "utf8",
      ),
    ).payload,
  );
}

it("saves an explicit Bar loop independently from Original analysis and edit history", () => {
  const original = projectFixture();
  const bars = original.analysisRevisions[0]!.timeline.bars;
  const updated = applyPracticeAction(original, {
    type: "set_loop",
    firstBarId: bars[0]!.id,
    lastBarId: bars[1]!.id,
  });
  expect(resolvePracticeLoop(updated)).toEqual({ startSample: 0, endSample: 32000 });
  expect(getPracticeState(original).loop).toBeNull();
  expect(updated.analysisRevisions).toEqual(original.analysisRevisions);
  expect(updated.editLayers).toEqual(original.editLayers);
  expect(getPracticeState(applyPracticeAction(updated, { type: "clear_loop" })).loop).toBeNull();
});

it("follows boundary moves but marks split anchors for review, including after undo", async () => {
  const { reconcilePracticeState } = await import("@open-chords/domain");
  const original = applyPracticeAction(projectFixture(), {
    type: "set_loop",
    firstBarId: "bar_pickup",
    lastBarId: "bar_three_four",
  });
  const edit = (
    operation: (typeof original.editLayers)[number]["transactions"][number]["operations"][number],
  ) => {
    const project = structuredClone(original);
    project.editLayers[0]!.transactions.push({
      id: "transaction_practice",
      parentTransactionId: null,
      operations: [operation],
    });
    project.activeView!.editHistoryPosition = project.editLayers[0]!.transactions.length;
    return project;
  };
  const moved = edit({
    type: "move_bar_boundary",
    leftBarId: "bar_pickup",
    rightBarId: "bar_three_four",
    atSample: 7000,
  });
  expect(reconcilePracticeState(original, moved).practice?.loop?.status).toBe("ready");
  const split = edit({
    type: "split_bar",
    atSample: 20000,
    barId: "bar_three_four",
    leftStatus: "truncated",
    newBarId: "bar_split",
    newDownbeatId: "beat_split",
    rightMeter: { denominator: 4, numerator: 2 },
    rightStatus: "complete",
  });
  const reviewed = reconcilePracticeState(original, split);
  expect(reviewed.practice?.loop?.status).toBe("needs_review");
  expect(resolvePracticeLoop(reviewed)).toBeNull();
  expect(
    reconcilePracticeState(reviewed, { ...original, practice: reviewed.practice }).practice?.loop
      ?.status,
  ).toBe("needs_review");
});

it("validates practice settings while keeping presentation separate from Original chords", () => {
  const original = projectFixture();
  const changed = applyPracticeAction(original, {
    type: "settings",
    speed: 0.75,
    countInBars: 1,
    metronome: true,
    autoscroll: false,
    instrument: "ukulele",
    transposeSemitones: -2,
    beginnerView: true,
    enharmonicPreference: "flat",
  });
  expect(getPracticeState(changed)).toMatchObject({
    speed: 0.75,
    countInBars: 1,
    metronome: true,
    autoscroll: false,
    instrument: "ukulele",
  });
  expect(changed.activeView?.presentation).toEqual({
    transposeSemitones: -2,
    beginnerView: true,
    enharmonicPreference: "flat",
  });
  expect(changed.analysisRevisions).toEqual(original.analysisRevisions);
  expect(changed.editLayers).toEqual(original.editLayers);
  expect(() => applyPracticeAction(original, { type: "settings", speed: 0 })).toThrow(/Too small/);
});

it("projects transpose and Beginner View deterministically while retaining unsupported symbols", async () => {
  const { presentChord, capoGuidance } = await import("@open-chords/domain");
  const original = {
    kind: "chord" as const,
    root: "A" as const,
    quality: "minor7" as const,
    bass: "E" as const,
    extensions: [],
    additions: [],
    alterations: [],
    omissions: [],
  };
  const before = structuredClone(original);
  expect(
    presentChord(original, {
      transposeSemitones: -2,
      beginnerView: true,
      enharmonicPreference: "flat",
    }),
  ).toMatchObject({ root: "G", quality: "minor", bass: "D" });
  expect(
    presentChord(
      { ...original, alterations: ["b5"] },
      { transposeSemitones: 0, beginnerView: true, enharmonicPreference: "sharp" },
    ),
  ).toEqual({ ...original, alterations: ["b5"] });
  expect(original).toEqual(before);
  expect(capoGuidance(-2, "guitar")).toBe("Capo 2: these shapes match the Original recording.");
  expect(capoGuidance(-2, "piano")).toBeNull();
});

it("returns data-driven instrument voicings and names unsupported diagrams honestly", async () => {
  const { chordDiagram } = await import("@open-chords/domain");
  const chord = {
    kind: "chord" as const,
    root: "E" as const,
    quality: "major" as const,
    extensions: [],
    additions: [],
    alterations: [],
    omissions: [],
  };
  expect(chordDiagram(chord, "guitar")).toMatchObject({
    kind: "strings",
    frets: [0, 2, 2, 1, 0, 0],
    tuning: [40, 45, 50, 55, 59, 64],
  });
  expect(chordDiagram({ ...chord, root: "C" }, "ukulele")).toMatchObject({
    kind: "strings",
    frets: [0, 0, 0, 3],
    tuning: [67, 60, 64, 69],
  });
  expect(chordDiagram({ ...chord, root: "C", bass: "E" }, "piano")).toMatchObject({
    kind: "piano",
    notes: [48, 52, 55],
    bass: 40,
  });
  expect(chordDiagram({ ...chord, alterations: ["#11"] }, "guitar")).toEqual({
    kind: "unavailable",
    reason: "No diagram in this pack; the full chord symbol is retained.",
  });
  expect(chordDiagram({ kind: "no_chord" }, "guitar")).toEqual({
    kind: "unavailable",
    reason: "N — no chord to play.",
  });
});

it("plans count-in from the active meter and navigates committed events", async () => {
  const { practiceCountIn, practiceNavigation } = await import("@open-chords/domain");
  const project = applyPracticeAction(projectFixture(), {
    type: "settings",
    speed: 0.5,
    countInBars: 1,
  });
  expect(practiceCountIn(project, 8000)).toEqual({
    beatCount: 3,
    beatSeconds: 1 / 3,
    durationSeconds: 1,
  });
  expect(practiceCountIn(project, 36000)).toBeNull();
  expect(practiceNavigation(project, 18000, "chord", -1)).toBe(8000);
  expect(practiceNavigation(project, 18000, "chord", 1)).toBe(20000);
  expect(practiceNavigation(project, 18000, "bar", -1)).toBe(8000);
});

it("rejects a ready loop with missing anchors at the persisted Project boundary", () => {
  const project = applyPracticeAction(projectFixture(), {
    type: "set_loop",
    firstBarId: "bar_pickup",
    lastBarId: "bar_three_four",
  });
  project.practice!.loop!.lastBarId = "bar_missing";
  expect(() => parseProjectContract(project)).toThrow(
    "Ready practice loop must reference contiguous active Bars",
  );
  project.practice!.loop!.status = "needs_review";
  expect(parseProjectContract(project).practice?.loop?.status).toBe("needs_review");
});

it("uses each ukulele voicing's actual barre rather than its root transpose offset", async () => {
  const { chordDiagram } = await import("@open-chords/domain");
  const chord = {
    kind: "chord" as const,
    root: "D" as const,
    quality: "minor" as const,
    extensions: [],
    additions: [],
    alterations: [],
    omissions: [],
  };
  expect(chordDiagram(chord, "ukulele")).toMatchObject({ frets: [2, 5, 5, 5], barre: 5 });
  expect(chordDiagram({ ...chord, root: "C", quality: "minor7" }, "ukulele")).toMatchObject({
    frets: [3, 3, 3, 3],
    barre: 3,
  });
});

import { readFileSync } from "node:fs";

import { expect, it } from "vitest";

import { serializeChordPro } from "../packages/domain/src/chordpro.ts";
import { captureJsonExport } from "../packages/domain/src/json-export.ts";
import { projectLeadSheet } from "../packages/domain/src/lead-sheet.ts";
import type { ProjectContract } from "../packages/domain/src/schema.ts";
import {
  chord,
  goldenProject,
  leadSheetProject,
  originalTimeline,
} from "./support/export-fixture.ts";

const chordPro = (project: ProjectContract, presentation: "current" | "original" = "current") =>
  serializeChordPro(
    projectLeadSheet(captureJsonExport(project, { presentation }), { title: project.id }),
  );

it("serializes the lead sheet as golden ChordPro bytes with credits, grid, capo and diagrams", () => {
  const { text, losses } = chordPro(leadSheetProject());
  expect(text).toBe(readFileSync("tests/fixtures/chordpro-golden.cho", "utf8"));
  expect(losses).toEqual([
    "abstained_chord_marked_unknown",
    "analysis_provenance_not_represented",
    "chord_diagram_unavailable:Gm9add9add11/D",
    "chord_symbol_not_portable:Gm9add9add11/D",
    "confidence_not_represented",
    "edit_history_not_represented",
    "lyrics_mismatch_not_represented",
    "sample_timing_not_represented",
    "stable_identity_not_represented",
    "unmetered_seconds_not_represented",
  ]);
});

it("keeps unsupported rich chords exact under Beginner View and never invents a diagram", () => {
  const project = goldenProject();
  const events = originalTimeline(project).chordEvents;
  events[0]!.value = chord({ additions: ["add9"], omissions: ["no3"] });
  events[3]!.value = chord({ extensions: ["7"], alterations: ["#11", "b9"], bass: "G" });
  project.activeView!.presentation.beginnerView = true;
  const { text, losses } = chordPro(project);
  expect(text).toContain("[Cadd9no3]\ngo go\n");
  expect(text).toContain("\n[C7b9#11/G]\n");
  expect(text).not.toContain("{define");
  expect(losses).toEqual(
    expect.arrayContaining([
      "chord_symbol_not_portable:C7b9#11/G",
      "chord_symbol_not_portable:Cadd9no3",
      "chord_diagram_unavailable:C7b9#11/G",
      "chord_diagram_unavailable:Cadd9no3",
    ]),
  );
  expect(chordPro(project, "original").text).toContain("\n[C7b9#11/G]\n");
});

it("neutralizes ChordPro syntax inside lyrics and directives and reports each change", () => {
  const project = goldenProject();
  const document = project.lyricsDocuments[0]!;
  document.notices = ["Line one\nLine {two}"];
  document.text = "{go [x]\n#home go";
  document.lines = [
    { id: "line_first", startOffset: 0, endOffset: 7 },
    { id: "line_second", startOffset: 8, endOffset: 16 },
  ];
  document.tokens = [
    { id: "token_go_1", lineId: "line_first", startOffset: 0, endOffset: 3, text: "{go" },
    { id: "token_go_2", lineId: "line_first", startOffset: 4, endOffset: 7, text: "[x]" },
    { id: "token_home", lineId: "line_second", startOffset: 8, endOffset: 13, text: "#home" },
    { id: "token_go_3", lineId: "line_second", startOffset: 14, endOffset: 16, text: "go" },
  ];
  const { text, losses } = chordPro(project);
  expect(text.split("\n")).toEqual(
    expect.arrayContaining(["{copyright: Line one Line two}", " {go (x)", "[N.C.]#home go"]),
  );
  expect(losses).toEqual(
    expect.arrayContaining(["directive_text_normalized", "lyric_text_normalized:line_first"]),
  );
  expect(losses).not.toContain("lyric_text_normalized:line_second");
});

it.each([
  ["piano", "{define-keyboard: G7 keys 0 4 7 10}"],
  ["ukulele", "{define-ukulele: G7 base-fret 7 frets 1 1 1 2}"],
] as const)("writes %s diagrams with the instrument's define directive", (instrument, line) => {
  const project = goldenProject();
  project.practice = {
    speed: 1,
    countInBars: 0,
    metronome: false,
    autoscroll: false,
    instrument,
    loop: null,
  };
  expect(chordPro(project).text.split("\n")).toContain(line);
});

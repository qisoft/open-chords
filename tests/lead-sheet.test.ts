import { expect, it } from "vitest";

import { captureJsonExport } from "../packages/domain/src/json-export.ts";
import { projectLeadSheet } from "../packages/domain/src/lead-sheet.ts";
import type { ProjectContract } from "../packages/domain/src/schema.ts";
import { goldenProject, originalTimeline } from "./support/export-fixture.ts";

const sheetFor = (project: ProjectContract) =>
  projectLeadSheet(captureJsonExport(project, { presentation: "current" }), { title: project.id });

const untimed = (project: ProjectContract) => {
  const alignment = project.lyricsAlignments[0]!;
  for (const occurrence of [...alignment.lineOccurrences, ...alignment.occurrences])
    occurrence.timing = { state: "unmatched", reasonCode: "untimed_fixture" };
  return project;
};

it("anchors chords to lyric lines, keeps chord-only rows and repeats only changed directives", () => {
  const sheet = sheetFor(goldenProject());
  expect(sheet.header).toEqual({
    key: "Am",
    time: "4/4",
    tempo: 360,
    capo: null,
    capoGuidance: null,
    presentation: "Current presentation, no transforms",
  });
  expect(sheet.sections).toEqual([
    {
      label: "intro",
      heading: "Intro",
      layout: "lyrics",
      rows: [
        {
          kind: "chords",
          directives: {},
          chords: [
            {
              symbol: "Am9add9add11/E",
              spoken: "A minor nine add nine add eleven over E",
              state: "asserted",
            },
          ],
        },
        {
          kind: "lyric",
          lineId: "line_first",
          directives: {},
          segments: [{ chord: null, text: "go go" }],
        },
        {
          kind: "chords",
          directives: { time: "3/4" },
          chords: [{ symbol: "?", spoken: "unknown chord", state: "abstained" }],
        },
      ],
    },
    {
      label: "unknown",
      heading: "Unknown section",
      layout: "lyrics",
      rows: [
        {
          kind: "lyric",
          lineId: "line_second",
          directives: {},
          segments: [
            { chord: { symbol: "N.C.", spoken: "no chord", state: "asserted" }, text: "home go" },
          ],
        },
        {
          kind: "chords",
          directives: {},
          chords: [{ symbol: "G7", spoken: "G seven", state: "low_confidence" }],
        },
      ],
    },
  ]);
  expect(sheet.diagrams).toEqual({
    instrument: "guitar",
    entries: [
      {
        symbol: "G7",
        alt: "G seven, guitar: low E fret 3, A fret 5, D fret 3, G fret 4, B fret 3, high E fret 3; barre at fret 3",
        diagram: {
          kind: "strings",
          packId: "open-chords-guitar-v1",
          tuning: [40, 45, 50, 55, 59, 64],
          frets: [3, 5, 3, 4, 3, 3],
          barre: 3,
        },
      },
    ],
    unavailable: ["Am9add9add11/E"],
  });
  expect(sheet.lyricsCredits).toEqual({
    provider: "user",
    reference: null,
    attribution: ["User-supplied fixture text"],
    notices: ["Test fixture only"],
  });
  expect(sheet.untimedLyrics).toBeNull();
});

it("splits a chord inside a line before the last matched token that started", () => {
  const project = goldenProject();
  const events = originalTimeline(project).chordEvents;
  events[2]!.endSample = 26000;
  events.splice(3, 0, {
    ...structuredClone(events[3]!),
    id: "chord_split",
    startSample: 26000,
    endSample: 32000,
  });
  const row = sheetFor(project).sections[1]!.rows[0];
  expect(row).toMatchObject({
    kind: "lyric",
    segments: [
      { chord: { symbol: "N.C." }, text: "home " },
      { chord: { symbol: "G7" }, text: "go" },
    ],
  });
});

it("turns every section into a beat grid and lists untimed lyrics when no line timing exists", () => {
  const project = untimed(goldenProject());
  const events = originalTimeline(project).chordEvents;
  events[0]!.endSample = 6000;
  events[1]!.startSample = 6000;
  const sheet = sheetFor(project);
  expect(sheet.sections.map(({ layout, rows }) => ({ layout, rows }))).toEqual([
    {
      layout: "grid",
      rows: [
        {
          kind: "grid",
          directives: {},
          bars: [
            {
              beats: [
                [
                  {
                    symbol: "Am9add9add11/E",
                    spoken: "A minor nine add nine add eleven over E",
                    state: "asserted",
                  },
                ],
                [{ symbol: "?", spoken: "unknown chord", state: "abstained" }],
              ],
            },
          ],
        },
        { kind: "grid", directives: { time: "3/4" }, bars: [{ beats: [[], [], []] }] },
      ],
    },
    {
      layout: "grid",
      rows: [
        {
          kind: "chords",
          directives: {},
          chords: [
            { symbol: "N.C.", spoken: "no chord", state: "asserted" },
            { symbol: "G7", spoken: "G seven", state: "low_confidence" },
          ],
        },
        { kind: "grid", directives: { time: "6/8" }, bars: [{ beats: [[], []] }] },
      ],
    },
  ]);
  expect(sheet.untimedLyrics).toEqual([
    { lineId: "line_first", text: "go go" },
    { lineId: "line_second", text: "home go" },
  ]);
  expect(sheet.losses).toEqual([
    "abstained_chord_marked_unknown",
    "analysis_provenance_not_represented",
    "chord_diagram_unavailable:Am9add9add11/E",
    "chord_symbol_not_portable:Am9add9add11/E",
    "confidence_not_represented",
    "edit_history_not_represented",
    "lyrics_mismatch_not_represented",
    "lyrics_untimed_chords_not_anchored",
    "mid_beat_position_rounded",
    "sample_timing_not_represented",
    "stable_identity_not_represented",
    "unmetered_seconds_not_represented",
  ]);
});

it("transposes the key with presentation spelling and reports modes ChordPro cannot name", () => {
  const project = goldenProject();
  project.activeView!.presentation = {
    transposeSemitones: 1,
    beginnerView: false,
    enharmonicPreference: "flat",
  };
  expect(sheetFor(project).header.key).toBe("Bbm");
  const keys = originalTimeline(project).keyRegions;
  keys[0]!.value = { kind: "key", tonic: "A", mode: "dorian" };
  const sheet = sheetFor(project);
  expect(sheet.header.key).toBeNull();
  expect(sheet.losses).toContain("key_mode_not_representable:dorian");
});

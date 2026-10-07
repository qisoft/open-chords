import { expect, it } from "vitest";

import { captureJsonExport } from "../packages/domain/src/json-export.ts";
import { projectLrc } from "../packages/domain/src/lrc.ts";
import type { ProjectContract } from "../packages/domain/src/schema.ts";
import { goldenProject } from "./support/export-fixture.ts";
import { lrcProject } from "./support/lrc-fixture.ts";

const lrc = (project: ProjectContract) =>
  projectLrc(captureJsonExport(project, { presentation: "current" }), { title: project.id });

// Valid Projects keep matched line onsets in document order, so an inversion can only reach
// the projection through a hand-built snapshot.
const invertedSnapshot = () => {
  const snapshot = structuredClone(captureJsonExport(lrcProject(), { presentation: "current" }));
  const occurrences = snapshot.lyrics!.effectiveAlignment!.lineOccurrences;
  const late = occurrences[4]!.timing;
  const early = occurrences[5]!.timing;
  if (late.state !== "matched" || early.state !== "matched") throw new Error("fixture");
  [late.startSample, early.startSample] = [early.startSample, late.startSample];
  return snapshot;
};

it("emits only safe monotonic matched line onsets and reports every omitted line", () => {
  const result = projectLrc(invertedSnapshot(), { title: "project_golden" });
  expect(result).toEqual({
    kind: "lrc",
    text: "[ti:project_golden]\n[00:01.00]first line\n[00:08.00]low\tconfidence\n[60:00.50]after an hour\n",
    losses: [
      "analysis_provenance_not_represented",
      "confidence_not_represented",
      "edit_history_not_represented",
      "line_end_timing_not_represented",
      "lrc_line_coverage:3/11",
      "lrc_line_omitted:empty:line_8",
      "lrc_line_omitted:non_monotonic:line_3",
      "lrc_line_omitted:non_monotonic:line_4",
      "lrc_line_omitted:non_monotonic:line_5",
      "lrc_line_omitted:non_monotonic:line_6",
      "lrc_line_omitted:out_of_range:line_11",
      "lrc_line_omitted:unmatched:line_2",
      "lrc_line_omitted:unsafe_text:line_7",
      "lyrics_mismatch_not_represented",
      "lyrics_notices_not_represented",
      "sample_timing_not_represented",
      "stable_identity_not_represented",
    ],
  });
  for (const omitted of ["tie a", "tie b", "late", "early", "unmatched", "bracket", "too late"])
    expect(result.kind === "lrc" && result.text).not.toContain(omitted);
  expect(lrc(lrcProject())).toMatchObject({
    text: "[ti:project_golden]\n[00:01.00]first line\n[00:04.00]late\n[00:05.00]early\n[00:08.00]low\tconfidence\n[60:00.50]after an hour\n",
  });
});

it("reports word timing loss for the golden token-timed lyrics", () => {
  expect(lrc(goldenProject())).toEqual({
    kind: "lrc",
    text: "[ti:project_golden]\n[00:00.02]go go\n[00:00.41]home go\n",
    losses: [
      "analysis_provenance_not_represented",
      "confidence_not_represented",
      "edit_history_not_represented",
      "line_end_timing_not_represented",
      "lrc_line_coverage:2/2",
      "lyrics_mismatch_not_represented",
      "lyrics_notices_not_represented",
      "sample_timing_not_represented",
      "stable_identity_not_represented",
      "word_timing_not_represented",
    ],
  });
});

it("is unavailable rather than inventing timestamps when nothing safe can be emitted", () => {
  const withoutLyrics = goldenProject();
  delete withoutLyrics.activeView!.lyricsDocumentId;
  delete withoutLyrics.activeView!.lyricsAlignmentId;
  expect(lrc(withoutLyrics)).toEqual({ kind: "unavailable", reason: "no_lyrics" });
  const untimed = goldenProject();
  for (const occurrence of [
    ...untimed.lyricsAlignments[0]!.lineOccurrences,
    ...untimed.lyricsAlignments[0]!.occurrences,
  ])
    occurrence.timing = { state: "unmatched", reasonCode: "untimed_fixture" };
  expect(lrc(untimed)).toEqual({ kind: "unavailable", reason: "no_line_timing" });
  const unsafe = goldenProject();
  unsafe.lyricsDocuments[0]!.text = "[o go\n[ome go";
  unsafe.lyricsDocuments[0]!.tokens[0]!.text = "[o";
  unsafe.lyricsDocuments[0]!.tokens[2]!.text = "[ome";
  expect(lrc(unsafe)).toEqual({ kind: "unavailable", reason: "no_emittable_lines" });
});

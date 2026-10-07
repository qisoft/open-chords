import { readFileSync } from "node:fs";

import type { ProjectContract } from "../../packages/domain/src/schema.ts";

export type ChordIdentity = Extract<
  ProjectContract["analysisRevisions"][number]["timeline"]["chordEvents"][number]["value"],
  { kind: "chord" }
>;

export function goldenProject(): ProjectContract {
  return JSON.parse(
    readFileSync("packages/testkit/contracts/v1/valid/project-envelope.json", "utf8"),
  ).payload;
}

export function chord(value: Partial<ChordIdentity>): ChordIdentity {
  return {
    kind: "chord",
    root: "C",
    quality: "major",
    extensions: [],
    additions: [],
    alterations: [],
    omissions: [],
    ...value,
  };
}

export function originalTimeline(project: ProjectContract) {
  return project.analysisRevisions.find(({ id }) => id === "revision_original")!.timeline;
}

// A lead-sheet fixture with a grid intro, a chorus, capo guidance and an unmatched leading line.
export function leadSheetProject(): ProjectContract {
  const project = goldenProject();
  project.activeView!.presentation.transposeSemitones = -2;
  originalTimeline(project).sectionRegions[1]!.label = "chorus";
  const alignment = project.lyricsAlignments[0]!;
  alignment.lineOccurrences[0]!.timing = { state: "unmatched", reasonCode: "fixture_unmatched" };
  alignment.occurrences[0]!.timing = { state: "unmatched", reasonCode: "fixture_unmatched" };
  return project;
}

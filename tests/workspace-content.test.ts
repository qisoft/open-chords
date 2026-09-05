import { readFileSync } from "node:fs";

import { parseProjectContract } from "@open-chords/domain";
import { expect, it } from "vitest";

import { buildWorkspaceContent } from "../apps/desktop/src/renderer/workspace-content.ts";

it("uses selected effective lyric timing and leaves ambiguous tokens untimed", () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL("../packages/testkit/contracts/v1/valid/project-envelope.json", import.meta.url),
      "utf8",
    ),
  );
  const content = buildWorkspaceContent(parseProjectContract(fixture.payload));
  expect(content.lines[0]).toMatchObject({
    id: "line_first",
    text: "go go",
    startSample: 1000,
    endSample: 5000,
  });
  expect(content.lines[0]?.tokens[0]).toMatchObject({
    text: "go",
    chordLabels: ["Am7(9, add11, add9)/E"],
  });
  expect(content.lines[0]?.tokens[1]).toMatchObject({
    text: "go",
    chordLabels: [],
    startSample: null,
  });
  expect(content.instrumentals).toEqual([]);
  const project = parseProjectContract(fixture.payload);
  if (project.activeView === null) throw new Error("Active View missing");
  delete project.activeView.lyricsAlignmentId;
  const untimed = buildWorkspaceContent(project);
  expect(untimed.lines.map((line) => line.startSample)).toEqual([null, null]);
  expect(
    untimed.lines.flatMap((line) => line.tokens.flatMap((token) => token.chordLabels)),
  ).toEqual([]);
});

it("uses committed lyric corrections and projects timed chord sections without inventing lyrics", () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL("../packages/testkit/contracts/v1/valid/project-envelope.json", import.meta.url),
      "utf8",
    ),
  );
  const project = parseProjectContract(fixture.payload);
  const active = project.activeView!;
  const layer = project.editLayers.find((candidate) => candidate.id === active.editLayerId)!;
  layer.transactions[0]!.operations = [
    {
      type: "set_lyrics_line_timing",
      alignmentId: "alignment_repeated",
      lineId: "line_first",
      timing: {
        state: "matched",
        startSample: 500,
        endSample: 7000,
        assertion: { state: "asserted", evidence: [], reasonCodes: ["user_authored"] },
      },
    },
  ];
  active.editHistoryPosition = 1;
  expect(buildWorkspaceContent(parseProjectContract(project)).lines[0]).toMatchObject({
    startSample: 500,
    endSample: 7000,
  });
  active.editHistoryPosition = 0;
  delete active.lyricsDocumentId;
  delete active.lyricsAlignmentId;
  const content = buildWorkspaceContent(parseProjectContract(project));
  expect(content.lines).toEqual([]);
  expect(content.instrumentals).toEqual([
    {
      id: "section_intro",
      label: "intro",
      startSample: 0,
      endSample: 20000,
      chordLabels: ["Am7(9, add11, add9)/E", "Unknown chord"],
    },
  ]);
});

import { materializeEffectiveTimeline, type ProjectContract } from "@open-chords/domain";

import { chordLabel } from "./workspace-timeline.ts";

type Timed = { startSample: number | null; endSample: number | null };
export type WorkspaceLyricToken = Timed & {
  id: string;
  text: string;
  suffix: string;
  chordLabels: string[];
};
export type WorkspaceLyricLine = Timed & {
  id: string;
  text: string;
  prefix: string;
  tokens: WorkspaceLyricToken[];
  state: string;
};

export function buildWorkspaceContent(project: ProjectContract) {
  const effective = project.activeView === null ? null : materializeEffectiveTimeline(project);
  const document = project.lyricsDocuments.find(
    ({ id }) => id === project.activeView?.lyricsDocumentId,
  );
  const alignment = effective?.lyricsAlignment;
  const lineTiming = new Map(alignment?.lineOccurrences.map((line) => [line.lineId, line.timing]));
  const tokenTiming = new Map(alignment?.occurrences.map((token) => [token.tokenId, token.timing]));
  const chords = effective?.chordEvents ?? [];
  const lines: WorkspaceLyricLine[] = (document?.lines ?? []).map((line) => {
    const lineMatch = lineTiming.get(line.id);
    const tokens = document!.tokens.filter((token) => token.lineId === line.id);
    return {
      id: line.id,
      text: document!.text.slice(line.startOffset, line.endOffset),
      prefix: document!.text.slice(line.startOffset, tokens[0]?.startOffset ?? line.endOffset),
      startSample: lineMatch?.state === "matched" ? lineMatch.startSample : null,
      endSample: lineMatch?.state === "matched" ? lineMatch.endSample : null,
      state: lineMatch?.state === "matched" ? lineMatch.assertion.state : "untimed",
      tokens: tokens.map((token, index) => {
        const timing = tokenTiming.get(token.id);
        return {
          id: token.id,
          text: token.text,
          suffix: document!.text.slice(
            token.endOffset,
            tokens[index + 1]?.startOffset ?? line.endOffset,
          ),
          startSample: timing?.state === "matched" ? timing.startSample : null,
          endSample: timing?.state === "matched" ? timing.endSample : null,
          chordLabels:
            timing?.state === "matched"
              ? chords
                  .filter(
                    (chord) =>
                      chord.assertion.state !== "abstained" &&
                      chord.startSample < timing.endSample &&
                      chord.endSample > timing.startSample,
                  )
                  .map((chord) => chordLabel(chord.value))
              : [],
        };
      }),
    };
  });
  // A section name is not proof of absent vocals. Only show instrumental candidates
  // without overlapping matched lyrics; never infer timing for untimed words.
  const instrumentals = (effective?.sectionRegions ?? [])
    .filter(
      (section) =>
        ["intro", "interlude", "outro", "solo"].includes(section.label) &&
        section.assertion.state !== "abstained" &&
        (document === undefined ||
          (alignment !== undefined &&
            !lines.some(
              (line) =>
                line.startSample !== null &&
                line.endSample !== null &&
                line.startSample < section.endSample &&
                line.endSample > section.startSample,
            ))),
    )
    .map((section) => ({
      id: section.id,
      label: section.label,
      startSample: section.startSample,
      endSample: section.endSample,
      chordLabels: chords
        .filter(
          (chord) => chord.startSample < section.endSample && chord.endSample > section.startSample,
        )
        .map((chord) =>
          chord.assertion.state === "abstained" ? "Unknown chord" : chordLabel(chord.value),
        ),
    }));
  return { lines, instrumentals };
}

export type WorkspaceContent = ReturnType<typeof buildWorkspaceContent>;

import type { LyricsAlignment, ProjectContract } from "../../packages/domain/src/schema.ts";
import { goldenProject } from "./export-fixture.ts";

const second = 48_000;
const lines: [string, LyricsAlignment["lineOccurrences"][number]["timing"]][] = [
  ["first line", matched(1 * second)],
  ["unmatched line", { state: "unmatched", reasonCode: "fixture_unmatched" }],
  ["tie a", matched(2 * second)],
  ["tie b", matched(2 * second + 200)],
  ["late", matched(4 * second)],
  ["early", matched(5 * second)],
  ["[bracket line", matched(6 * second)],
  ["   ", matched(7 * second)],
  ["low\tconfidence", matched(8 * second, "low_confidence")],
  ["after an hour", matched(3600 * second + second / 2)],
  ["too late", matched(6000 * second)],
];

function matched(
  startSample: number,
  state: "asserted" | "low_confidence" = "asserted",
): LyricsAlignment["lineOccurrences"][number]["timing"] {
  return {
    state: "matched",
    startSample,
    endSample: startSample + 100,
    assertion: { state, evidence: [], reasonCodes: state === "asserted" ? [] : ["weak_alignment"] },
  };
}

// The golden Project stretched past 100 minutes so out-of-range LRC onsets are representable.
export function lrcProject(): ProjectContract {
  const project = goldenProject();
  const duration = 6001 * second;
  project.durationSamples = duration;
  for (const { timeline } of project.analysisRevisions) {
    for (const track of [timeline.chordEvents, timeline.sectionRegions, timeline.keyRegions])
      track.at(-1)!.endSample = duration;
    const lastMetered = Math.max(
      ...[...timeline.bars, ...timeline.unmeteredRegions].map(({ endSample }) => endSample),
    );
    if (lastMetered < duration)
      timeline.unmeteredRegions.push({
        id: "unmetered_tail",
        startSample: lastMetered,
        endSample: duration,
        reasonCode: "fixture_tail",
      });
  }
  let offset = 0;
  const document = project.lyricsDocuments[0]!;
  document.text = lines.map(([text]) => text).join("\n");
  document.lines = lines.map(([text], index) => {
    const line = {
      id: `line_${String(index + 1)}`,
      startOffset: offset,
      endOffset: offset + text.length,
    };
    offset += text.length + 1;
    return line;
  });
  document.tokens = [];
  const alignment = project.lyricsAlignments[0]!;
  alignment.lineOccurrences = lines.map(([, timing], index) => ({
    lineId: `line_${String(index + 1)}`,
    timing,
  }));
  alignment.occurrences = [];
  return project;
}

import { readFileSync } from "node:fs";

import { addLyricsDocument, parseProjectContract } from "@open-chords/domain";
import { expect, it } from "vitest";

function fixture() {
  return parseProjectContract(
    JSON.parse(
      readFileSync(
        new URL("../packages/testkit/contracts/v1/valid/project-envelope.json", import.meta.url),
        "utf8",
      ),
    ).payload,
  );
}

it("retains original text and distinct repeated occurrences while correction adds a new document", () => {
  const original = fixture();
  const text = "Hello hello\r\n\r\nHello hello!";
  const first = addLyricsDocument(
    original,
    { text, language: "en", format: "text" },
    "lyrics_first",
  );
  const document = first.lyricsDocuments.at(-1)!;
  expect(document.text).toBe(text);
  expect(document.tokens.map((token) => token.text)).toEqual(["Hello", "hello", "Hello", "hello"]);
  expect(new Set(document.tokens.map(({ id }) => id)).size).toBe(4);
  expect(
    document.lines.map(({ startOffset, endOffset }) => text.slice(startOffset, endOffset)),
  ).toEqual(["Hello hello", "Hello hello!"]);
  expect(
    first.lyricsAlignments.at(-1)!.occurrences.every(({ timing }) => timing.state === "unmatched"),
  ).toBe(true);
  const corrected = addLyricsDocument(
    first,
    { text: "Hello again", language: "en", format: "text" },
    "lyrics_second",
  );
  expect(corrected.lyricsDocuments.find(({ id }) => id === "lyrics_first")).toEqual(document);
  expect(corrected.activeView!.lyricsDocumentId).toBe("lyrics_second");
  expect(corrected.analysisRevisions).toEqual(original.analysisRevisions);
  expect(corrected.editLayers).toEqual(original.editLayers);
  expect(() => parseProjectContract(corrected)).not.toThrow();
});

it("imports supplied LRC line onsets without fabricating word timing and rejects nonmonotonic input", () => {
  const project = addLyricsDocument(
    fixture(),
    { text: "[00:00.10]Hello\n[00:00.40]Hello", language: "en", format: "lrc" },
    "lyrics_timed",
  );
  const document = project.lyricsDocuments.at(-1)!;
  expect(document.text).toBe("Hello\nHello");
  expect(document.suppliedTimingKind).toBe("line");
  expect(
    project.lyricsAlignments.at(-1)!.lineOccurrences.map(({ timing }) => timing),
  ).toMatchObject([
    { state: "matched", startSample: 4800, endSample: 19200 },
    { state: "matched", startSample: 19200, endSample: 48000 },
  ]);
  expect(
    project.lyricsAlignments
      .at(-1)!
      .occurrences.every(({ timing }) => timing.state === "unmatched"),
  ).toBe(true);
  expect(() => parseProjectContract(project)).not.toThrow();
  expect(() =>
    addLyricsDocument(
      fixture(),
      { text: "[00:00.40]One\n[00:00.10]Two", language: "en", format: "lrc" },
      "lyrics_bad",
    ),
  ).toThrow("Invalid supplied timing");
});

it("retains subtitle intervals and refuses overlapping primary lyric streams", () => {
  const input = {
    text: "WEBVTT\n\n00:00.100 --> 00:00.300\nOne\n\n00:00.400 --> 00:00.900\nTwo",
    language: "en",
    format: "vtt" as const,
  };
  const project = addLyricsDocument(fixture(), input, "lyrics_subtitles", {
    provenance: { provider: "youtube_human", reference: "youtube:abcdefghijk:en" },
    attribution: ["Example track"],
    notices: [],
  });
  expect(project.lyricsDocuments.at(-1)!).toMatchObject({
    text: "One\nTwo",
    provenance: { provider: "youtube_human" },
  });
  expect(
    project.lyricsAlignments.at(-1)!.lineOccurrences.map(({ timing }) => timing),
  ).toMatchObject([
    { startSample: 4800, endSample: 14400 },
    { startSample: 19200, endSample: 43200 },
  ]);
  expect(() => parseProjectContract(project)).not.toThrow();
  expect(() =>
    addLyricsDocument(
      fixture(),
      { ...input, text: input.text.replace("00:00.400", "00:00.200") },
      "lyrics_overlap",
    ),
  ).toThrow("Invalid supplied timing");
});

it("preserves multiline subtitle text without inventing separate timing for its second line", () => {
  const project = addLyricsDocument(
    fixture(),
    {
      text: "1\n00:00:00,100 --> 00:00:00,900\nFirst line\nSecond line",
      language: "en",
      format: "srt",
    },
    "lyrics_multiline",
  );
  expect(project.lyricsDocuments.at(-1)!.text).toBe("First line\nSecond line");
  expect(project.lyricsDocuments.at(-1)!.lines).toHaveLength(2);
  expect(
    project.lyricsAlignments.at(-1)!.lineOccurrences.map(({ timing }) => timing.state),
  ).toEqual(["matched", "unmatched"]);
});

it("maps provider Source timing into a selected Project Range while retaining out-of-range text as unmatched", () => {
  const project = addLyricsDocument(
    fixture(),
    { text: "[00:00.00]Before\n[00:01.10]Inside\n[00:03.00]After", language: "en", format: "lrc" },
    "lyrics_range",
    { provenance: { provider: "lrclib", reference: "lrclib:12" }, attribution: [], notices: [] },
    48000,
  );
  expect(project.lyricsDocuments.at(-1)!.text).toBe("Before\nInside\nAfter");
  expect(
    project.lyricsAlignments.at(-1)!.lineOccurrences.map(({ timing }) => timing),
  ).toMatchObject([
    { state: "matched", startSample: 0, endSample: 4800 },
    { state: "matched", startSample: 4800, endSample: 48000 },
    { state: "unmatched" },
  ]);
  expect(() => parseProjectContract(project)).not.toThrow();
});

it("rejects unsupported repeated and enhanced LRC timestamps instead of storing them as words", () => {
  for (const text of ["[00:00.10][00:00.40]Hello", "[00:00.10]<00:00.20>Hello"])
    expect(() =>
      addLyricsDocument(fixture(), { text, language: "en", format: "lrc" }, "lyrics_unsupported"),
    ).toThrow("Unsupported LRC timing");
});

it("retains empty LRC cues as gaps instead of extending lyrics across instrumental time", () => {
  const project = addLyricsDocument(
    fixture(),
    { text: "[00:00.10]Hello\n[00:00.30]\n[00:00.50]Again", language: "en", format: "lrc" },
    "lyrics_gaps",
  );
  expect(project.lyricsDocuments.at(-1)!.text).toBe("Hello\n\nAgain");
  expect(
    project.lyricsAlignments.at(-1)!.lineOccurrences.map(({ timing }) => timing),
  ).toMatchObject([
    { startSample: 4800, endSample: 14400 },
    { startSample: 24000, endSample: 48000 },
  ]);
  expect(() => parseProjectContract(project)).not.toThrow();
});

it("keeps later subtitle timing attached to its own line after a lone carriage return", () => {
  const project = addLyricsDocument(
    fixture(),
    {
      text: "1\n00:00:00,100 --> 00:00:00,300\nFirst\rContinuation\n\n2\n00:00:00,500 --> 00:00:00,900\nLast",
      language: "en",
      format: "srt",
    },
    "lyrics_carriage",
  );
  expect(project.lyricsDocuments.at(-1)!.text).toBe("First\nContinuation\nLast");
  expect(
    project.lyricsAlignments.at(-1)!.lineOccurrences.map(({ timing }) => timing),
  ).toMatchObject([
    { state: "matched", startSample: 4800, endSample: 14400 },
    { state: "unmatched" },
    { state: "matched", startSample: 24000, endSample: 43200 },
  ]);
  expect(() => parseProjectContract(project)).not.toThrow();
});

it("uses whitespace-only LRC cues as gaps without creating lyric line occurrences", () => {
  const project = addLyricsDocument(
    fixture(),
    { text: "[00:00.10]Hello\n[00:00.30] \t\n[00:00.50]Again", language: "en", format: "lrc" },
    "lyrics_whitespace",
  );
  const document = project.lyricsDocuments.at(-1)!;
  expect(document.text).toBe("Hello\n \t\nAgain");
  expect(
    document.lines.map((line) => document.text.slice(line.startOffset, line.endOffset)),
  ).toEqual(["Hello", "Again"]);
  expect(
    project.lyricsAlignments.at(-1)!.lineOccurrences.map(({ timing }) => timing),
  ).toMatchObject([
    { startSample: 4800, endSample: 14400 },
    { startSample: 24000, endSample: 48000 },
  ]);
  expect(() => parseProjectContract(project)).not.toThrow();
});

it("accepts a final empty LRC boundary exactly at the Project end", () => {
  const project = addLyricsDocument(
    fixture(),
    { text: "[00:00.10]Hello\n[00:01.00]", language: "en", format: "lrc" },
    "lyrics_final_boundary",
  );
  expect(
    project.lyricsAlignments.at(-1)!.lineOccurrences.map(({ timing }) => timing),
  ).toMatchObject([{ startSample: 4800, endSample: 48000 }]);
  expect(() => parseProjectContract(project)).not.toThrow();
});

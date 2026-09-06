import { z } from "zod";

import {
  StableIdSchema,
  type LyricsDocument,
  type LyricsAlignment,
  type ProjectContract,
} from "./schema.ts";

export const LyricsInputSchema = z.strictObject({
  text: z.string().min(1).max(64_000),
  language: z
    .string()
    .regex(/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/)
    .max(35),
  format: z.enum(["text", "lrc", "vtt", "srt"]),
});
export type LyricsInput = z.infer<typeof LyricsInputSchema>;
export type LyricsOrigin = Pick<LyricsDocument, "provenance" | "attribution" | "notices">;

export function addLyricsDocument(
  original: ProjectContract,
  rawInput: LyricsInput,
  id: string,
  origin: LyricsOrigin = {
    provenance: { provider: "user", reference: "user_supplied" },
    attribution: [],
    notices: [],
  },
  sourceStartSample?: number,
): ProjectContract {
  const input = LyricsInputSchema.parse(rawInput);
  StableIdSchema.parse(id);
  if (original.activeView === null) throw new Error("Lyrics require an Active View");
  if (original.lyricsDocuments.some((document) => document.id === id))
    throw new Error("Lyrics Document already exists");
  const imported = importLines(
    input,
    original.sampleRate,
    sourceStartSample === undefined ? original.durationSamples : Number.MAX_SAFE_INTEGER,
  );
  if (sourceStartSample !== undefined) {
    if (!Number.isSafeInteger(sourceStartSample) || sourceStartSample < 0)
      throw new Error("Invalid Source offset");
    imported.timings = imported.timings.map((timing) => {
      if (!timing) return undefined;
      const startSample = Math.max(0, timing.startSample - sourceStartSample);
      const endSample = Math.min(original.durationSamples, timing.endSample - sourceStartSample);
      return startSample < endSample ? { startSample, endSample } : undefined;
    });
  }
  const document: LyricsDocument = {
    ...structuredClone(origin),
    id,
    text: imported.text,
    language: input.language,
    lines: [],
    tokens: [],
    suppliedTimingKind: input.format === "text" ? "untimed" : "line",
    tokenization: { scheme: "unicode_letter_number_utf16", version: "1.0" },
  };
  let offset = 0;
  for (const line of imported.text.split(/\r\n|\r|\n/)) {
    const lineId = `${id}_line_${document.lines.length}`;
    if (line.trim().length > 0) {
      document.lines.push({ id: lineId, startOffset: offset, endOffset: offset + line.length });
      for (const match of line.matchAll(
        /[\p{L}\p{N}][\p{L}\p{M}\p{N}]*(?:['’][\p{L}\p{M}\p{N}]+)*/gu,
      )) {
        document.tokens.push({
          id: `${id}_token_${document.tokens.length}`,
          lineId,
          text: match[0],
          startOffset: offset + match.index,
          endOffset: offset + match.index + match[0].length,
        });
      }
    }
    offset += line.length;
    offset += imported.text.slice(offset, offset + 2) === "\r\n" ? 2 : 1;
  }
  if (document.tokens.length === 0) throw new Error("Lyrics contain no words");
  const alignment: LyricsAlignment = {
    id: `${id}_alignment`,
    lyricsDocumentId: id,
    analysisRevisionId: original.activeView.analysisRevisionId,
    occurrences: document.tokens.map((token) => ({
      tokenId: token.id,
      timing: { state: "unmatched", reasonCode: "untimed_reference" },
    })),
    lineOccurrences: document.lines.map((line, index) => ({
      lineId: line.id,
      timing:
        imported.timings[index] === undefined
          ? { state: "unmatched", reasonCode: "untimed_reference" }
          : {
              state: "matched",
              ...imported.timings[index],
              assertion: { state: "asserted", evidence: [], reasonCodes: ["supplied_line_timing"] },
            },
    })),
  };
  const project = structuredClone(original);
  project.lyricsDocuments.push(document);
  project.lyricsAlignments.push(alignment);
  project.activeView!.lyricsDocumentId = id;
  project.activeView!.lyricsAlignmentId = alignment.id;
  return project;
}

function importLines(
  input: LyricsInput,
  sampleRate: number,
  durationSamples: number,
): { text: string; timings: ({ startSample: number; endSample: number } | undefined)[] } {
  if (input.format === "text") return { text: input.text, timings: [] };
  if (input.format !== "lrc") return importSubtitles(input.text, sampleRate, durationSamples);
  const cues: { text: string; startSample: number }[] = [];
  for (const line of input.text.split(/\r\n|\r|\n/)) {
    if (line.trim() === "" || /^\[(?:ar|al|ti|au|by|re|ve|length):[^\]]*\]$/.test(line)) continue;
    const match = /^\[(\d{1,3}):([0-5]\d)(?:[.:](\d{1,3}))?\](.*)$/.exec(line);
    if (match === null) throw new Error("Invalid LRC line");
    if (/\[\d{1,3}:\d{2}/.test(match[4]!) || /<\d{1,3}:\d{2}/.test(match[4]!))
      throw new Error("Unsupported LRC timing");
    const seconds = Number(match[1]) * 60 + Number(match[2]) + Number(`0.${match[3] ?? "0"}`);
    cues.push({ text: match[4]!, startSample: Math.round(seconds * sampleRate) });
  }
  if (cues.length === 0) throw new Error("No timed lyrics");
  const timings = cues.map((cue, index) => {
    const endSample = cues[index + 1]?.startSample ?? durationSamples;
    if (cue.startSample >= endSample || endSample > durationSamples)
      throw new Error("Invalid supplied timing");
    return { startSample: cue.startSample, endSample };
  });
  return {
    text: cues.map((cue) => cue.text).join("\n"),
    timings: timings.filter((_timing, index) => cues[index]!.text.trim().length > 0),
  };
}

function importSubtitles(raw: string, sampleRate: number, durationSamples: number) {
  const blocks = raw
    .replace(/^\uFEFF/, "")
    .replaceAll(/\r\n?/g, "\n")
    .split(/\n\n+/);
  const texts: string[] = [];
  const timings: ({ startSample: number; endSample: number } | undefined)[] = [];
  let previousEnd = 0;
  const stamp = (value: string) => {
    const parts = value.replace(",", ".").split(":").map(Number);
    return Math.round(parts.reduce((total, part) => total * 60 + part, 0) * sampleRate);
  };
  for (const block of blocks) {
    if (!block.trim() || /^(?:WEBVTT(?:\s|$)|NOTE(?:\s|$))/.test(block)) continue;
    const lines = block.split("\n");
    if (!lines[0]!.includes(" --> ")) lines.shift();
    const match =
      /^((?:\d{2,}:)?[0-5]\d:[0-5]\d[.,]\d{3}) --> ((?:\d{2,}:)?[0-5]\d:[0-5]\d[.,]\d{3})(?:[ \t].*)?$/.exec(
        lines.shift() ?? "",
      );
    if (!match || lines.length === 0) throw new Error("Invalid subtitle cue");
    const startSample = stamp(match[1]!);
    const endSample = stamp(match[2]!);
    if (
      !Number.isSafeInteger(startSample) ||
      !Number.isSafeInteger(endSample) ||
      startSample < previousEnd ||
      startSample >= endSample ||
      endSample > durationSamples
    )
      throw new Error("Invalid supplied timing");
    // Retain physical lines. Only the first owns the supplied cue span; other lines remain unmatched.
    const text = lines
      .join("\n")
      .replace(/<[^>]*>/g, "")
      .replace(
        /&(?:amp|lt|gt|nbsp);/g,
        (entity) => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&nbsp;": " " })[entity]!,
      );
    if (!text.trim()) throw new Error("Empty subtitle cue");
    texts.push(text);
    timings.push({ startSample, endSample });
    for (
      let index = 1;
      index < text.split("\n").filter((line) => line.trim().length > 0).length;
      index++
    )
      timings.push(undefined);
    previousEnd = endSample;
  }
  if (texts.length === 0) throw new Error("No subtitle cues");
  return { text: texts.join("\n"), timings };
}

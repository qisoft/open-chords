import { exportLoss, receiptLosses, type ExportLoss } from "./export-losses.ts";
import { hasControlCharacter, replaceControlCharacters } from "./export-text.ts";
import type { OpenChordsJsonSnapshot } from "./json-export.ts";

export type LrcProjection =
  | { kind: "lrc"; text: string; losses: ExportLoss[] }
  | { kind: "unavailable"; reason: "no_lyrics" | "no_line_timing" | "no_emittable_lines" };
type OmissionReason = "unmatched" | "empty" | "unsafe_text" | "out_of_range" | "non_monotonic";

const maxCentiseconds = 100n * 60n * 100n;

function timestamp(centiseconds: bigint): string {
  const minutes = centiseconds / 6000n;
  const seconds = (centiseconds / 100n) % 60n;
  const fraction = centiseconds % 100n;
  return `[${[minutes, seconds].map((part) => String(part).padStart(2, "0")).join(":")}.${String(fraction).padStart(2, "0")}]`;
}

export function projectLrc(
  snapshot: OpenChordsJsonSnapshot,
  options: { title: string },
): LrcProjection {
  const document = snapshot.lyrics?.document;
  if (!document) return { kind: "unavailable", reason: "no_lyrics" };
  const alignment = snapshot.lyrics?.effectiveAlignment;
  if (!alignment?.lineOccurrences.some(({ timing }) => timing.state === "matched"))
    return { kind: "unavailable", reason: "no_line_timing" };
  const timings = new Map(alignment.lineOccurrences.map(({ lineId, timing }) => [lineId, timing]));
  const sampleRate = BigInt(snapshot.project.sampleRate);
  const lines = document.lines.map((line) => {
    const timing = timings.get(line.id)!;
    return {
      id: line.id,
      text: document.text.slice(line.startOffset, line.endOffset),
      timing,
      onset: timing.state === "matched" ? (BigInt(timing.startSample) * 100n) / sampleRate : null,
    };
  });
  const onsets = lines.flatMap(({ onset }, index) => (onset === null ? [] : [{ onset, index }]));
  const reason = (line: (typeof lines)[number], index: number): OmissionReason | null => {
    if (line.onset === null) return "unmatched";
    if (line.text.trim() === "") return "empty";
    if (hasControlCharacter(line.text) || line.text.startsWith("[")) return "unsafe_text";
    if (line.onset >= maxCentiseconds) return "out_of_range";
    const onset = line.onset;
    const monotonic = onsets.every(
      (other) =>
        other.index === index || (other.index < index ? other.onset < onset : other.onset > onset),
    );
    return monotonic ? null : "non_monotonic";
  };
  const losses: ExportLoss[] = [
    "analysis_provenance_not_represented",
    "edit_history_not_represented",
    "lyrics_mismatch_not_represented",
    "sample_timing_not_represented",
    "stable_identity_not_represented",
    "line_end_timing_not_represented",
  ];
  const emitted: string[] = [];
  for (const [index, line] of lines.entries()) {
    const omitted = reason(line, index);
    if (omitted !== null) {
      losses.push(exportLoss("lrc_line_omitted", `${omitted}:${line.id}`));
      continue;
    }
    if (line.timing.state === "matched" && line.timing.assertion.state === "low_confidence")
      losses.push("confidence_not_represented");
    emitted.push(`${timestamp(line.onset!)}${line.text}`);
  }
  if (emitted.length === 0) return { kind: "unavailable", reason: "no_emittable_lines" };
  losses.push(exportLoss("lrc_line_coverage", `${String(emitted.length)}/${String(lines.length)}`));
  if (alignment.occurrences.some(({ timing }) => timing.state === "matched"))
    losses.push("word_timing_not_represented");
  if (document.attribution.length > 0 || document.notices.length > 0)
    losses.push("lyrics_notices_not_represented");
  const title = replaceControlCharacters(options.title, "").replaceAll("]", "");
  return {
    kind: "lrc",
    text: `${[...(title === "" ? [] : [`[ti:${title}]`]), ...emitted].join("\n")}\n`,
    losses: receiptLosses(losses),
  };
}

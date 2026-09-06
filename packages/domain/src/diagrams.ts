import { pianoDiagramPack, stringDiagramPacks } from "./diagram-packs.ts";
import { pitchClassNumber } from "./presentation.ts";
import { ChordValueSchema, type ChordValue } from "./schema.ts";

export type ChordDiagram =
  | { kind: "unavailable"; reason: string }
  | { kind: "strings"; packId: string; tuning: number[]; frets: number[]; barre: number | null }
  | { kind: "piano"; packId: string; notes: number[]; bass: number | null };

export function chordDiagram(
  rawValue: ChordValue,
  instrument: "guitar" | "ukulele" | "piano",
): ChordDiagram {
  const value = ChordValueSchema.parse(rawValue);
  if (value.kind === "no_chord") return { kind: "unavailable", reason: "N — no chord to play." };
  const unavailable = {
    kind: "unavailable",
    reason: "No diagram in this pack; the full chord symbol is retained.",
  } as const;
  if (value.additions.length > 0 || value.alterations.length > 0 || value.omissions.length > 0)
    return unavailable;
  const dominant =
    value.quality === "major" && value.extensions.length === 1 && value.extensions[0] === "7";
  if (value.extensions.length > 0 && !dominant) return unavailable;
  const quality = dominant ? "dominant7" : value.quality;
  const root = pitchClassNumber(value.root);
  if (instrument === "piano") {
    const intervals = pianoDiagramPack.intervals[quality];
    return {
      kind: "piano",
      packId: pianoDiagramPack.id,
      notes: intervals.map((interval) => 48 + root + interval),
      bass: value.bass === undefined ? null : 36 + pitchClassNumber(value.bass),
    };
  }
  const pack = stringDiagramPacks[instrument];
  if (
    quality !== "major" &&
    quality !== "minor" &&
    quality !== "major7" &&
    quality !== "minor7" &&
    quality !== "dominant7"
  )
    return unavailable;
  const shape = pack.shapes[quality];
  const offset = (root - pack.root + 12) % 12;
  const frets = shape.map((fret) => fret + offset);
  if (
    value.bass !== undefined &&
    Math.min(...frets.map((fret, index) => pack.tuning[index]! + fret)) % 12 !==
      pitchClassNumber(value.bass)
  )
    return unavailable;
  return {
    kind: "strings",
    packId: pack.id,
    tuning: [...pack.tuning],
    frets,
    barre: offset === 0 ? null : offset,
  };
}

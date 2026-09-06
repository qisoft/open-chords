import { ActiveViewSchema, ChordValueSchema, type ActiveView, type ChordValue } from "./schema.ts";

const sharpNotes = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"] as const;
const flatNotes = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"] as const;
export function pitchClassNumber(note: string): number {
  const result = sharpNotes.findIndex((name) => name === note);
  return result >= 0 ? result : flatNotes.findIndex((name) => name === note);
}

export function presentChord(
  input: ChordValue,
  rawPresentation: ActiveView["presentation"],
): ChordValue {
  const value = structuredClone(ChordValueSchema.parse(input));
  const presentation = ActiveViewSchema.shape.presentation.parse(rawPresentation);
  if (value.kind === "no_chord") return value;
  const notes =
    presentation.enharmonicPreference === "flat" ||
    (presentation.enharmonicPreference === "contextual" && value.root.includes("b"))
      ? flatNotes
      : sharpNotes;
  const shift = (note: string) =>
    notes[(pitchClassNumber(note) + presentation.transposeSemitones + 12) % 12]!;
  value.root = shift(value.root);
  if (value.bass !== undefined) value.bass = shift(value.bass);
  if (
    presentation.beginnerView &&
    value.alterations.length === 0 &&
    value.omissions.length === 0 &&
    ["major", "minor", "major7", "minor7"].includes(value.quality)
  ) {
    value.quality = value.quality === "minor" || value.quality === "minor7" ? "minor" : "major";
    value.extensions = [];
    value.additions = [];
  }
  return value;
}

export function capoGuidance(transpose: number, instrument: string): string | null {
  return instrument !== "piano" && Number.isInteger(transpose) && transpose >= -11 && transpose < 0
    ? `Capo ${String(-transpose)}: these shapes match the Original recording.`
    : null;
}

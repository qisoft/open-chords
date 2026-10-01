import { chordSpokenName, chordSymbol, spokenNoteName } from "./chord-symbol.ts";
import { chordDiagram, type ChordDiagram } from "./diagrams.ts";
import { exportLoss, type ExportLoss } from "./export-losses.ts";
import type { ChordValue } from "./schema.ts";

export type Instrument = "guitar" | "ukulele" | "piano";
export type LeadSheetDiagram = {
  symbol: string;
  alt: string;
  diagram: Exclude<ChordDiagram, { kind: "unavailable" }>;
};
export type LeadSheetDiagrams = {
  instrument: Instrument;
  entries: LeadSheetDiagram[];
  unavailable: string[];
};

const sharpNames = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"] as const;
const flatNames = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"] as const;

function noteName(midi: number, flats: boolean): string {
  return (flats ? flatNames : sharpNames)[midi % 12]!;
}

function stringNames(tuning: number[], flats: boolean): string[] {
  const names = tuning.map((midi) => noteName(midi, flats));
  return names.map((name, index) => {
    const repeated = names.filter((other) => other === name).length > 1;
    if (!repeated) return spokenNoteName(name);
    const lowest = tuning.every((midi, other) => names[other] !== name || midi >= tuning[index]!);
    return `${lowest ? "low" : "high"} ${spokenNoteName(name)}`;
  });
}

function altText(value: ChordValue, diagram: LeadSheetDiagram["diagram"], instrument: Instrument) {
  const flats = value.kind === "chord" && value.root.includes("b");
  if (diagram.kind === "piano") {
    const notes = diagram.notes.map(
      (midi) => `${spokenNoteName(noteName(midi, flats))} ${String(Math.floor(midi / 12) - 1)}`,
    );
    const bass =
      diagram.bass === null
        ? ""
        : `; bass ${spokenNoteName(noteName(diagram.bass, flats))} ${String(Math.floor(diagram.bass / 12) - 1)}`;
    return `${chordSpokenName(value)}, ${instrument}: ${notes.join(", ")}${bass}`;
  }
  const strings = stringNames(diagram.tuning, flats).map(
    (name, index) =>
      `${name} ${diagram.frets[index] === 0 ? "open" : `fret ${String(diagram.frets[index])}`}`,
  );
  const barre = diagram.barre === null ? "" : `; barre at fret ${String(diagram.barre)}`;
  return `${chordSpokenName(value)}, ${instrument}: ${strings.join(", ")}${barre}`;
}

export function leadSheetDiagrams(
  values: ChordValue[],
  instrument: Instrument,
): { diagrams: LeadSheetDiagrams; losses: ExportLoss[] } {
  const seen = new Set<string>();
  const entries: LeadSheetDiagram[] = [];
  const unavailable: string[] = [];
  for (const value of values) {
    const symbol = chordSymbol(value);
    if (value.kind === "no_chord" || seen.has(symbol)) continue;
    seen.add(symbol);
    const diagram = chordDiagram(value, instrument);
    if (diagram.kind === "unavailable") unavailable.push(symbol);
    else entries.push({ symbol, alt: altText(value, diagram, instrument), diagram });
  }
  return {
    diagrams: { instrument, entries, unavailable },
    losses: unavailable.map((symbol) => exportLoss("chord_diagram_unavailable", symbol)),
  };
}

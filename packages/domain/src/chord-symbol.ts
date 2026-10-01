import type { ChordValue } from "./schema.ts";

type Chord = Extract<ChordValue, { kind: "chord" }>;
type Quality = Chord["quality"];

const qualities: Record<Quality, { suffix: string; words: string }> = {
  major: { suffix: "", words: "major" },
  minor: { suffix: "m", words: "minor" },
  diminished: { suffix: "dim", words: "diminished" },
  augmented: { suffix: "aug", words: "augmented" },
  sus2: { suffix: "sus2", words: "suspended two" },
  sus4: { suffix: "sus4", words: "suspended four" },
  major7: { suffix: "maj7", words: "major seven" },
  minor7: { suffix: "m7", words: "minor seven" },
  diminished7: { suffix: "dim7", words: "diminished seven" },
  half_diminished: { suffix: "m7b5", words: "minor seven flat five" },
};
const portableSuffixes = new Set([
  "",
  "m",
  "dim",
  "aug",
  "sus2",
  "sus4",
  "maj7",
  "m7",
  "dim7",
  "m7b5",
  "7",
  "6",
  "m6",
  "9",
  "m9",
  "add9",
  "7sus4",
  "maj9",
]);
const numberWords: Record<string, string> = {
  "2": "two",
  "3": "three",
  "4": "four",
  "5": "five",
  "6": "six",
  "7": "seven",
  "9": "nine",
  "11": "eleven",
  "13": "thirteen",
};
const detailPrefixWords: Record<string, string> = { add: "add", no: "no", b: "flat", "#": "sharp" };

// Sus chords lead with their extensions (C7sus4) and a seventh quality takes a higher
// extension in place of its 7 (Cmaj9); otherwise extensions follow the quality (Cm9).
function placement(value: Chord): "lead" | "replace_seventh" | "append" {
  if (value.extensions.length === 0) return "append";
  if (value.quality === "sus2" || value.quality === "sus4") return "lead";
  return value.quality === "major7" || value.quality === "minor7" ? "replace_seventh" : "append";
}

const degree = (part: string) => Number(/\d+$/.exec(part)![0]);

// Stored parts are sorted lexicographically ("#11" before "b9"); spelling orders them by degree.
function details(value: Chord): string[] {
  return [value.additions, value.alterations, value.omissions].flatMap((parts) =>
    parts.toSorted((a, b) => degree(a) - degree(b) || (a < b ? -1 : 1)),
  );
}

function suffix(value: Chord): string {
  const quality = qualities[value.quality].suffix;
  const extensions = value.extensions.join("");
  const core = {
    lead: `${extensions}${quality}`,
    replace_seventh: quality.replace(/7$/, extensions),
    append: `${quality}${extensions}`,
  }[placement(value)];
  return `${core}${details(value).join("")}`;
}

export function chordSymbol(value: ChordValue): string {
  if (value.kind === "no_chord") return "N.C.";
  return `${value.root}${suffix(value)}${value.bass === undefined ? "" : `/${value.bass}`}`;
}

export function isPortableChordSymbol(value: ChordValue): boolean {
  return value.kind === "no_chord" || portableSuffixes.has(suffix(value));
}

export function spokenNoteName(note: string): string {
  return note.replace(/#$/, " sharp").replace(/(?<=.)b$/, " flat");
}

function spokenDetail(detail: string): string {
  const [, prefix = "", number = ""] = /^(add|no|b|#)(\d+)$/.exec(detail) ?? [];
  return `${detailPrefixWords[prefix] ?? prefix} ${numberWords[number] ?? number}`;
}

export function chordSpokenName(value: ChordValue): string {
  if (value.kind === "no_chord") return "no chord";
  const plainMajor =
    value.quality === "major" && value.extensions.length === 0 && value.additions.length === 0;
  const quality = value.quality === "major" && !plainMajor ? "" : qualities[value.quality].words;
  const extensions = value.extensions.map((extension) => numberWords[extension]!).join(" ");
  const core = {
    lead: `${extensions} ${quality}`,
    replace_seventh: quality.replace(/seven$/, extensions),
    append: `${quality} ${extensions}`,
  }[placement(value)];
  return [
    spokenNoteName(value.root),
    core.trim(),
    ...details(value).map(spokenDetail),
    ...(value.bass === undefined ? [] : [`over ${spokenNoteName(value.bass)}`]),
  ]
    .filter((word) => word !== "")
    .join(" ");
}

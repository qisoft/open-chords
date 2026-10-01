import { expect, it } from "vitest";

import {
  chordSpokenName,
  chordSymbol,
  isPortableChordSymbol,
} from "../packages/domain/src/chord-symbol.ts";
import type { ChordValue } from "../packages/domain/src/schema.ts";

const chord = (value: Partial<Extract<ChordValue, { kind: "chord" }>>): ChordValue => ({
  kind: "chord",
  root: "C",
  quality: "major",
  extensions: [],
  additions: [],
  alterations: [],
  omissions: [],
  ...value,
});

it.each([
  [chord({}), "C", "C major", true],
  [chord({ extensions: ["7"] }), "C7", "C seven", true],
  [chord({ quality: "minor", extensions: ["9"] }), "Cm9", "C minor nine", true],
  [
    chord({ extensions: ["7"], alterations: ["#11", "b9"], bass: "G" }),
    "C7b9#11/G",
    "C seven flat nine sharp eleven over G",
    false,
  ],
  [
    chord({ root: "A", quality: "half_diminished", bass: "G" }),
    "Am7b5/G",
    "A minor seven flat five over G",
    true,
  ],
  [chord({ additions: ["add9"], omissions: ["no3"] }), "Cadd9no3", "C add nine no three", false],
  [chord({ additions: ["add9"] }), "Cadd9", "C add nine", true],
  [
    chord({
      root: "A",
      quality: "minor7",
      extensions: ["9"],
      additions: ["add11", "add9"],
      bass: "E",
    }),
    "Am9add9add11/E",
    "A minor nine add nine add eleven over E",
    false,
  ],
  [chord({ quality: "sus4", extensions: ["7"] }), "C7sus4", "C seven suspended four", true],
  [chord({ quality: "major7", extensions: ["9"] }), "Cmaj9", "C major nine", true],
  [chord({ root: "Bb", quality: "minor", extensions: ["6"] }), "Bbm6", "B flat minor six", true],
  [chord({ root: "F#", quality: "diminished7" }), "F#dim7", "F sharp diminished seven", true],
  [
    chord({
      root: "C#",
      quality: "major7",
      extensions: ["13"],
      alterations: ["#11"],
      omissions: ["no5"],
    }),
    "C#maj13#11no5",
    "C sharp major thirteen sharp eleven no five",
    false,
  ],
  [{ kind: "no_chord" } satisfies ChordValue, "N.C.", "no chord", true],
] as const)("spells %j exactly as %s", (value, symbol, spoken, portable) => {
  expect(chordSymbol(value)).toBe(symbol);
  expect(chordSpokenName(value)).toBe(spoken);
  expect(isPortableChordSymbol(value)).toBe(portable);
});

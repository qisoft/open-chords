// Original data-only voicing packs. Standard guitar and re-entrant GCEA ukulele.
// Frets are ordered from the lowest displayed string to the highest.
export const stringDiagramPacks = {
  guitar: {
    id: "open-chords-guitar-v1",
    root: 4,
    tuning: [40, 45, 50, 55, 59, 64],
    shapes: {
      major: { frets: [0, 2, 2, 1, 0, 0], barre: 0 },
      minor: { frets: [0, 2, 2, 0, 0, 0], barre: 0 },
      major7: { frets: [0, 2, 1, 1, 0, 0], barre: 0 },
      minor7: { frets: [0, 2, 0, 0, 0, 0], barre: 0 },
      dominant7: { frets: [0, 2, 0, 1, 0, 0], barre: 0 },
    },
  },
  ukulele: {
    id: "open-chords-ukulele-v1",
    root: 0,
    tuning: [67, 60, 64, 69],
    shapes: {
      major: { frets: [0, 0, 0, 3], barre: 0 },
      minor: { frets: [0, 3, 3, 3], barre: 3 },
      major7: { frets: [0, 0, 0, 2], barre: 0 },
      minor7: { frets: [3, 3, 3, 3], barre: 3 },
      dominant7: { frets: [0, 0, 0, 1], barre: 0 },
    },
  },
} as const;
export const pianoDiagramPack = {
  id: "open-chords-piano-v1",
  intervals: {
    major: [0, 4, 7],
    minor: [0, 3, 7],
    major7: [0, 4, 7, 11],
    minor7: [0, 3, 7, 10],
    dominant7: [0, 4, 7, 10],
    diminished: [0, 3, 6],
    diminished7: [0, 3, 6, 9],
    half_diminished: [0, 3, 6, 10],
    augmented: [0, 4, 8],
    sus2: [0, 2, 7],
    sus4: [0, 5, 7],
  },
} as const;

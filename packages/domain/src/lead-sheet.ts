import { chordSpokenName, chordSymbol, isPortableChordSymbol } from "./chord-symbol.ts";
import { exportLoss, receiptLosses, type ExportLoss } from "./export-losses.ts";
import type { OpenChordsJsonSnapshot } from "./json-export.ts";
import { leadSheetDiagrams, type LeadSheetDiagrams } from "./lead-sheet-diagrams.ts";
import { presentPitchClass } from "./presentation.ts";
import type { ChordValue } from "./schema.ts";

type Timeline = OpenChordsJsonSnapshot["effectiveTimeline"];
type Bar = Timeline["bars"][number];
type SectionLabel = Timeline["sectionRegions"][number]["label"];
type AssertionState = Timeline["chordEvents"][number]["assertion"]["state"];

export type ChordCell = { symbol: string; spoken: string; state: AssertionState };
export type Directives = { key?: string; time?: string; tempo?: number };
export type LyricSegment = { chord: ChordCell | null; text: string };
export type GridBar = { beats: ChordCell[][] };
export type LeadSheetRow =
  | { kind: "lyric"; lineId: string; directives: Directives; segments: LyricSegment[] }
  | { kind: "chords"; directives: Directives; chords: ChordCell[] }
  | { kind: "grid"; directives: Directives; bars: GridBar[] };
export type LeadSheetSection = {
  label: SectionLabel;
  heading: string;
  layout: "lyrics" | "grid";
  rows: LeadSheetRow[];
};
export type LyricsCredits = {
  provider: string;
  reference: string | null;
  attribution: string[];
  notices: string[];
};
export type LeadSheet = {
  title: string;
  language: string | null;
  header: {
    key: string | null;
    time: string | null;
    tempo: number | null;
    capo: number | null;
    capoGuidance: string | null;
    presentation: string;
  };
  sections: LeadSheetSection[];
  untimedLyrics: { lineId: string; text: string }[] | null;
  diagrams: LeadSheetDiagrams;
  lyricsCredits: LyricsCredits | null;
  losses: ExportLoss[];
};

const headings: Record<SectionLabel, string> = {
  intro: "Intro",
  verse: "Verse",
  pre_chorus: "Pre-chorus",
  chorus: "Chorus",
  bridge: "Bridge",
  solo: "Solo",
  interlude: "Interlude",
  outro: "Outro",
  neutral: "Section",
  unknown: "Unknown section",
};
const constantLosses = [
  "sample_timing_not_represented",
  "stable_identity_not_represented",
  "edit_history_not_represented",
  "analysis_provenance_not_represented",
] as const satisfies ExportLoss[];

type TimedChord = { startSample: number; cell: ChordCell; value: ChordValue };
type TimedLine = { lineId: string; index: number; startSample: number; endSample: number };
type Placed = { at: number | null; row: LeadSheetRow };

const within = (sample: number, interval: { startSample: number; endSample: number }) =>
  interval.startSample <= sample && sample < interval.endSample;

function presentationText(presentation: OpenChordsJsonSnapshot["presentation"], profile: string) {
  if (profile === "original") return "Original presentation";
  const transforms = [
    ...(presentation.transposeSemitones === 0
      ? []
      : [
          `transposed ${presentation.transposeSemitones > 0 ? "+" : ""}${String(presentation.transposeSemitones)} semitones`,
        ]),
    ...(presentation.beginnerView ? ["Beginner View"] : []),
    ...(presentation.enharmonicPreference === "contextual"
      ? []
      : [`${presentation.enharmonicPreference} spelling`]),
  ];
  return transforms.length === 0
    ? "Current presentation, no transforms"
    : `Current presentation: ${transforms.join(", ")}`;
}

function bpm(bars: Bar[], sampleRate: number): number | null {
  const complete = bars.filter(({ status }) => status === "complete");
  const beats = complete.reduce((sum, bar) => sum + bar.beats.length, 0);
  const samples = complete.reduce((sum, bar) => sum + bar.endSample - bar.startSample, 0);
  return beats === 0 ? null : Math.round((60 * sampleRate * beats) / samples);
}

export function projectLeadSheet(
  snapshot: OpenChordsJsonSnapshot,
  options: { title: string },
): LeadSheet {
  const timeline = snapshot.effectiveTimeline;
  const losses: ExportLoss[] = [...constantLosses];
  const { presentation } = snapshot;
  const keyText = (sample: number): string | undefined => {
    const region = timeline.keyRegions.find((candidate) => within(sample, candidate));
    if (region?.value.kind !== "key") return undefined;
    const { mode, tonic } = region.value;
    if (mode !== "major" && mode !== "minor") {
      losses.push(exportLoss("key_mode_not_representable", mode));
      return undefined;
    }
    return `${presentPitchClass(tonic, presentation)}${mode === "minor" ? "m" : ""}`;
  };
  const barAt = (sample: number) => timeline.bars.find((bar) => within(sample, bar));
  const meterText = (bar: Bar | undefined) =>
    bar && `${String(bar.meter.numerator)}/${String(bar.meter.denominator)}`;

  const presented = new Map(snapshot.presentedChords.map(({ eventId, value }) => [eventId, value]));
  const chords: TimedChord[] = timeline.chordEvents.map((event) => {
    const value = presented.get(event.id)!;
    const abstained = event.assertion.state === "abstained";
    if (abstained) losses.push("abstained_chord_marked_unknown");
    else if (!isPortableChordSymbol(value))
      losses.push(exportLoss("chord_symbol_not_portable", chordSymbol(value)));
    if (timeline.unmeteredRegions.some((region) => within(event.startSample, region)))
      losses.push("unmetered_seconds_not_represented");
    return {
      startSample: event.startSample,
      value,
      cell: {
        symbol: abstained ? "?" : chordSymbol(value),
        spoken: abstained ? "unknown chord" : chordSpokenName(value),
        state: event.assertion.state,
      },
    };
  });

  const lyrics = snapshot.lyrics;
  const alignment = lyrics?.effectiveAlignment;
  const document = lyrics?.document;
  const lineText = (line: { startOffset: number; endOffset: number }) =>
    document!.text.slice(line.startOffset, line.endOffset);
  const lineTimings = new Map(
    (alignment?.lineOccurrences ?? []).map(({ lineId, timing }) => [lineId, timing]),
  );
  const tokenTimings = new Map(
    (alignment?.occurrences ?? []).map(({ tokenId, timing }) => [tokenId, timing]),
  );
  const timedLines: TimedLine[] = (document?.lines ?? []).flatMap((line, index) => {
    const timing = lineTimings.get(line.id);
    return timing?.state === "matched"
      ? [{ lineId: line.id, index, startSample: timing.startSample, endSample: timing.endSample }]
      : [];
  });
  const timed = timedLines.length > 0;
  if (document && !timed) losses.push("lyrics_untimed_chords_not_anchored");
  const timings = [...lineTimings.values(), ...tokenTimings.values()];
  if (timings.some((timing) => timing.state === "unmatched"))
    losses.push("lyrics_mismatch_not_represented");
  if (
    [
      ...timeline.chordEvents,
      ...timeline.keyRegions,
      ...timeline.sectionRegions,
      ...timings.flatMap((timing) => (timing.state === "matched" ? [timing] : [])),
    ].some(({ assertion }) => assertion.state !== "asserted")
  )
    losses.push("confidence_not_represented");

  const lyricRow = (line: TimedLine, anchored: TimedChord[]): LeadSheetRow => {
    const record = document!.lines[line.index]!;
    const text = lineText(record);
    const tokens = document!.tokens.filter(({ lineId }) => lineId === line.lineId);
    let floor = 0;
    const anchors = anchored.map((chord) => {
      const token =
        tokens.findLast((candidate) => {
          const timing = tokenTimings.get(candidate.id);
          return timing?.state === "matched" && timing.startSample <= chord.startSample;
        }) ?? tokens[0];
      floor = Math.max(floor, token ? token.startOffset - record.startOffset : 0);
      return { offset: floor, chord: chord.cell };
    });
    const segments: LyricSegment[] = [
      ...(anchors.length === 0 || anchors[0]!.offset > 0
        ? [{ chord: null, text: text.slice(0, anchors[0]?.offset ?? text.length) }]
        : []),
      ...anchors.map(({ offset, chord }, index) => ({
        chord,
        text: text.slice(offset, anchors[index + 1]?.offset ?? text.length),
      })),
    ];
    return { kind: "lyric", lineId: line.lineId, directives: {}, segments };
  };

  const placeLyricSection = (
    lines: TimedLine[],
    sectionChords: TimedChord[],
  ): { placed: Placed[]; rows: Map<string, number> } => {
    const ordered = lines.toSorted((a, b) => a.startSample - b.startSample || a.index - b.index);
    const anchored = new Map(ordered.map((line) => [line.lineId, [] as TimedChord[]]));
    const free: TimedChord[] = [];
    for (const chord of sectionChords) {
      const line = ordered.find((candidate) => within(chord.startSample, candidate));
      if (line) anchored.get(line.lineId)!.push(chord);
      else free.push(chord);
    }
    const items = [
      ...ordered.map((line) => ({ at: line.startSample, line, chord: null })),
      ...free.map((chord) => ({ at: chord.startSample, line: null, chord })),
    ].toSorted((a, b) => a.at - b.at || (a.line ? -1 : 0) - (b.line ? -1 : 0));
    const placed: Placed[] = [];
    const rows = new Map<string, number>();
    for (const item of items) {
      const last = placed.at(-1);
      if (item.line) {
        rows.set(item.line.lineId, placed.length);
        placed.push({ at: item.at, row: lyricRow(item.line, anchored.get(item.line.lineId)!) });
      } else if (last?.row.kind === "chords") last.row.chords.push(item.chord.cell);
      else
        placed.push({
          at: item.at,
          row: { kind: "chords", directives: {}, chords: [item.chord.cell] },
        });
    }
    return { placed, rows };
  };

  const placeGridSection = (
    section: { startSample: number; endSample: number },
    sectionChords: TimedChord[],
  ): Placed[] => {
    const bars = timeline.bars.filter((bar) => within(bar.startSample, section));
    const free = sectionChords.filter(
      (chord) => !bars.some((bar) => within(chord.startSample, bar)),
    );
    const items = [
      ...bars.map((bar) => ({ at: bar.startSample, bar, chord: null })),
      ...free.map((chord) => ({ at: chord.startSample, bar: null, chord })),
    ].toSorted((a, b) => a.at - b.at);
    const placed: Placed[] = [];
    let previousMeter: string | undefined;
    for (const item of items) {
      const last = placed.at(-1);
      if (item.bar) {
        const bar = item.bar;
        const cells = bar.beats.map((beat, index) => {
          const end = bar.beats[index + 1]?.atSample ?? bar.endSample;
          const start = index === 0 ? bar.startSample : beat.atSample;
          return sectionChords.filter((chord) => {
            const inside = start <= chord.startSample && chord.startSample < end;
            if (inside && chord.startSample !== beat.atSample)
              losses.push("mid_beat_position_rounded");
            return inside;
          });
        });
        const gridBar = { beats: cells.map((cell) => cell.map(({ cell: chord }) => chord)) };
        const meter = meterText(bar);
        if (last?.row.kind === "grid" && meter === previousMeter) last.row.bars.push(gridBar);
        else placed.push({ at: item.at, row: { kind: "grid", directives: {}, bars: [gridBar] } });
        previousMeter = meter;
      } else if (last?.row.kind === "chords") last.row.chords.push(item.chord.cell);
      else
        placed.push({
          at: item.at,
          row: { kind: "chords", directives: {}, chords: [item.chord.cell] },
        });
    }
    return placed;
  };

  const followers = new Map<string | null, string[]>();
  let previousTimed: string | null = null;
  for (const line of document?.lines ?? []) {
    if (lineTimings.get(line.id)?.state === "matched") previousTimed = line.id;
    else followers.set(previousTimed, [...(followers.get(previousTimed) ?? []), line.id]);
  }
  const unmatchedRow = (lineId: string): Placed => {
    const record = document!.lines.find(({ id }) => id === lineId)!;
    return {
      at: null,
      row: {
        kind: "lyric",
        lineId,
        directives: {},
        segments: [{ chord: null, text: lineText(record) }],
      },
    };
  };

  const header = {
    key: keyText(timeline.keyRegions[0]!.startSample) ?? null,
    time: meterText(timeline.bars[0]) ?? null,
    tempo: bpm(timeline.bars, snapshot.project.sampleRate),
    capo: presentation.capoGuidance === null ? null : -presentation.transposeSemitones,
    capoGuidance: presentation.capoGuidance,
    presentation: presentationText(presentation, snapshot.profile.presentation),
  };
  const emitted: Directives = {
    ...(header.key === null ? {} : { key: header.key }),
    ...(header.time === null ? {} : { time: header.time }),
    ...(header.tempo === null ? {} : { tempo: header.tempo }),
  };
  let leading = timed ? (followers.get(null) ?? []) : [];
  const sections: LeadSheetSection[] = timeline.sectionRegions.map((region) => {
    const sectionChords = chords.filter((chord) => within(chord.startSample, region));
    const lines = timed ? timedLines.filter((line) => within(line.startSample, region)) : [];
    const layout: LeadSheetSection["layout"] = lines.length > 0 ? "lyrics" : "grid";
    let placed: Placed[];
    if (layout === "lyrics") {
      const section = placeLyricSection(lines, sectionChords);
      placed = [
        ...leading.map(unmatchedRow),
        ...section.placed.flatMap((item) =>
          item.row.kind === "lyric"
            ? [item, ...(followers.get(item.row.lineId) ?? []).map(unmatchedRow)]
            : [item],
        ),
      ];
      leading = [];
    } else placed = placeGridSection(region, sectionChords);
    const tempo = bpm(
      timeline.bars.filter((bar) => within(bar.startSample, region)),
      snapshot.project.sampleRate,
    );
    const rows = placed.map(({ at, row }) => {
      if (at === null) return row;
      const next: Directives = {
        ...(keyText(at) === undefined ? {} : { key: keyText(at)! }),
        ...(meterText(barAt(at)) === undefined ? {} : { time: meterText(barAt(at))! }),
        ...(tempo === null ? {} : { tempo }),
      };
      const directives: Directives = {
        ...(next.key !== undefined && next.key !== emitted.key ? { key: next.key } : {}),
        ...(next.time !== undefined && next.time !== emitted.time ? { time: next.time } : {}),
        ...(next.tempo !== undefined && next.tempo !== emitted.tempo ? { tempo: next.tempo } : {}),
      };
      Object.assign(emitted, directives);
      return { ...row, directives };
    });
    return { label: region.label, heading: headings[region.label], layout, rows };
  });

  const { diagrams, losses: diagramLosses } = leadSheetDiagrams(
    chords.filter(({ cell }) => cell.state !== "abstained").map(({ value }) => value),
    presentation.instrument,
  );
  losses.push(...diagramLosses);
  return {
    title: options.title,
    language: document?.language ?? null,
    header,
    sections,
    untimedLyrics:
      document && !timed
        ? document.lines.map((line) => ({ lineId: line.id, text: lineText(line) }))
        : null,
    diagrams,
    lyricsCredits: document
      ? {
          provider: document.provenance.provider,
          reference: document.provenance.reference ?? null,
          attribution: [...document.attribution],
          notices: [...document.notices],
        }
      : null,
    losses: receiptLosses(losses),
  };
}

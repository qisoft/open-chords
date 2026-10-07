import { exportLoss, receiptLosses, type ExportLoss } from "./export-losses.ts";
import { replaceControlCharacters } from "./export-text.ts";
import type { Instrument, LeadSheetDiagram } from "./lead-sheet-diagrams.ts";
import type { Directives, LeadSheet, LeadSheetRow, LeadSheetSection } from "./lead-sheet.ts";

const environments: Partial<Record<LeadSheetSection["label"], string>> = {
  chorus: "chorus",
  bridge: "bridge",
};

export function serializeChordPro(sheet: LeadSheet): { text: string; losses: ExportLoss[] } {
  const losses: ExportLoss[] = [...sheet.losses];
  const value = (text: string) => {
    const safe = replaceControlCharacters(text, " ").replace(/[{}]/g, "");
    if (safe !== text) losses.push("directive_text_normalized");
    return safe;
  };
  const directive = (name: string, text: string) => `{${name}: ${value(text)}}`;
  const lyric = (lineId: string, text: string) => {
    const safe = replaceControlCharacters(text, " ").replaceAll("[", "(").replaceAll("]", ")");
    if (safe !== text) losses.push(exportLoss("lyric_text_normalized", lineId));
    return safe;
  };
  const lyricLine = (lineId: string, line: string) => {
    if (!/^[{#]/.test(line)) return line;
    losses.push(exportLoss("lyric_text_normalized", lineId));
    return ` ${line}`;
  };
  const directives = (changes: Directives) => [
    ...(changes.key === undefined ? [] : [directive("key", changes.key)]),
    ...(changes.time === undefined ? [] : [directive("time", changes.time)]),
    ...(changes.tempo === undefined ? [] : [directive("tempo", String(changes.tempo))]),
  ];
  const row = (item: LeadSheetRow): string[] => {
    const body =
      item.kind === "lyric"
        ? lyricLine(
            item.lineId,
            item.segments
              .map(
                ({ chord, text }) =>
                  `${chord ? `[${chord.symbol}]` : ""}${lyric(item.lineId, text)}`,
              )
              .join(""),
          )
        : item.kind === "chords"
          ? item.chords.map(({ symbol }) => `[${symbol}]`).join(" ")
          : chunks(item.bars, 4)
              .map(
                (bars) =>
                  `| ${bars
                    .map(({ beats }) =>
                      beats
                        .map((cell) =>
                          cell.length === 0 ? "." : cell.map(({ symbol }) => symbol).join("~"),
                        )
                        .join(" "),
                    )
                    .join(" | ")} |`,
              )
              .join("\n");
    return [...directives(item.directives), body];
  };
  const section = (item: LeadSheetSection): string[] =>
    (item.rows.length === 0 ? [[]] : runs(item.rows)).flatMap((rows) => {
      const label = `label="${value(item.heading)}"`;
      if (rows[0]?.kind === "grid") {
        const bars = rows.flatMap((grid) => (grid.kind === "grid" ? grid.bars : []));
        const shape = `shape="${String(bars.length)}x${String(bars[0]!.beats.length)}"`;
        return [`{start_of_grid: ${label} ${shape}}`, ...rows.flatMap(row), "{end_of_grid}", ""];
      }
      const name = environments[item.label] ?? "verse";
      return [`{start_of_${name}: ${label}}`, ...rows.flatMap(row), `{end_of_${name}}`, ""];
    });
  const { header, lyricsCredits } = sheet;
  const lines = [
    directive("title", sheet.title),
    ...(header.key === null ? [] : [directive("key", header.key)]),
    ...(header.time === null ? [] : [directive("time", header.time)]),
    ...(header.tempo === null ? [] : [directive("tempo", String(header.tempo))]),
    ...(header.capo === null ? [] : [directive("capo", String(header.capo))]),
    ...(lyricsCredits?.notices ?? []).map((notice) => directive("copyright", notice)),
    ...(header.capoGuidance === null ? [] : [directive("comment", header.capoGuidance)]),
    directive("comment", header.presentation),
    ...(lyricsCredits?.attribution ?? []).map((text) => directive("comment", `Lyrics: ${text}`)),
    ...(lyricsCredits
      ? [
          directive(
            "comment",
            `Lyrics source: ${lyricsCredits.provider}${lyricsCredits.reference === null ? "" : ` (${lyricsCredits.reference})`}`,
          ),
        ]
      : []),
    ...sheet.diagrams.entries.map((entry) => define(entry, sheet.diagrams.instrument)),
    "",
    ...sheet.sections.flatMap(section),
    ...(sheet.untimedLyrics === null
      ? []
      : [
          '{start_of_verse: label="Lyrics (untimed)"}',
          ...sheet.untimedLyrics.map(({ lineId, text }) => lyricLine(lineId, lyric(lineId, text))),
          "{end_of_verse}",
          "",
        ]),
  ];
  return { text: `${lines.join("\n").replace(/\n+$/, "")}\n`, losses: receiptLosses(losses) };
}

function define({ symbol, diagram }: LeadSheetDiagram, instrument: Instrument): string {
  if (diagram.kind === "piano") {
    const root = diagram.notes[0]!;
    const keys = [...(diagram.bass === null ? [] : [diagram.bass]), ...diagram.notes].map((note) =>
      String(note - root),
    );
    return `{define-keyboard: ${symbol} keys ${keys.join(" ")}}`;
  }
  const fretted = diagram.frets.filter((fret) => fret > 0);
  const base = Math.max(...diagram.frets) > 4 ? Math.min(...fretted) : 1;
  const frets = diagram.frets.map((fret) => String(fret === 0 ? 0 : fret - base + 1));
  const name = instrument === "ukulele" ? "define-ukulele" : "define";
  return `{${name}: ${symbol} base-fret ${String(base)} frets ${frets.join(" ")}}`;
}

function runs(rows: LeadSheetRow[]): LeadSheetRow[][] {
  return rows.reduce<LeadSheetRow[][]>((groups, row) => {
    const last = groups.at(-1);
    if (last && (last[0]!.kind === "grid") === (row.kind === "grid")) last.push(row);
    else groups.push([row]);
    return groups;
  }, []);
}

function chunks<T>(items: T[], size: number): T[][] {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, index) =>
    items.slice(index * size, index * size + size),
  );
}

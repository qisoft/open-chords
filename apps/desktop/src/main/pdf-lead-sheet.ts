import {
  exportLoss,
  receiptLosses,
  type ChordCell,
  type ExportLoss,
  type LeadSheet,
  type LeadSheetRow,
} from "@open-chords/domain";
import PDFDocument from "pdfkit";

import { DIAGRAM_CELL, drawDiagram } from "./pdf-diagrams.ts";
import { leadSheetFonts } from "./pdf-fonts.ts";

const page = { width: 595.28, height: 841.89, margin: 56 } as const;
const contentWidth = page.width - 2 * page.margin;
const bottom = page.height - page.margin;
const styles = {
  title: { font: "bold", size: 20, leading: 30 },
  heading: { font: "bold", size: 14, leading: 24 },
  meta: { font: "regular", size: 10, leading: 15 },
  chord: { font: "bold", size: 10, leading: 13 },
  lyric: { font: "regular", size: 11, leading: 16 },
  grid: { font: "regular", size: 10, leading: 15 },
} as const;
type Style = (typeof styles)[keyof typeof styles];
type Unit = { chord: ChordCell | null; text: string; width: number };
const fixedDate = new Date("1980-01-01T00:00:00Z");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// pdfkit exposes the embedded fontkit face only through its current font object.
function glyphProbe(doc: PDFKit.PDFDocument): (codePoint: number) => boolean {
  const font: unknown = Reflect.get(doc, "_font");
  const face = isRecord(font) ? font.font : undefined;
  const probe = isRecord(face) ? face.hasGlyphForCodePoint : undefined;
  if (typeof probe !== "function") throw new Error("Embedded PDF font face is unavailable");
  return (codePoint) => Reflect.apply(probe, face, [codePoint]) === true;
}

function directiveText(directives: LeadSheetRow["directives"]): string {
  return [
    ...(directives.key === undefined ? [] : [`Key: ${directives.key}`]),
    ...(directives.time === undefined ? [] : [`Time: ${directives.time}`]),
    ...(directives.tempo === undefined ? [] : [`Tempo: ${String(directives.tempo)} BPM`]),
  ].join(" · ");
}

function gridSummary(row: Extract<LeadSheetRow, { kind: "grid" }>): string {
  return row.bars
    .map(({ beats }, bar) => {
      const changes = beats.flatMap((cell, beat) =>
        cell.map(({ spoken }) => `${spoken} on beat ${String(beat + 1)}`),
      );
      return `Bar ${String(bar + 1)}: ${changes.length === 0 ? "no new chord" : changes.join(", ")}`;
    })
    .join(". ");
}

function gridLines(row: Extract<LeadSheetRow, { kind: "grid" }>): string[] {
  const lines: string[] = [];
  for (const [index, { beats }] of row.bars.entries()) {
    const bar = beats
      .map((cell) => (cell.length === 0 ? "." : cell.map(({ symbol }) => symbol).join("~")))
      .join("   ");
    if (index % 4 === 0) lines.push(`|  ${bar}  |`);
    else lines[lines.length - 1] += `  ${bar}  |`;
  }
  return lines;
}

export function renderLeadSheetPdf(
  sheet: LeadSheet,
): Promise<{ bytes: Buffer; losses: ExportLoss[] }> {
  const fonts = leadSheetFonts();
  const doc = new PDFDocument({
    size: "A4",
    margin: page.margin,
    pdfVersion: "1.7",
    tagged: true,
    lang: "en",
    displayTitle: true,
    // An empty default font keeps pdfkit from loading any standard (non-embedded) AFM font.
    font: "",
    compress: true,
    bufferPages: true,
    info: {
      Title: sheet.title,
      Creator: "Open Chords",
      Producer: "Open Chords",
      CreationDate: fixedDate,
      ModDate: fixedDate,
    },
  });
  const chunks: Buffer[] = [];
  const finished = new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
  doc.registerFont("regular", fonts.regular);
  doc.registerFont("bold", fonts.bold);
  const probes = {
    regular: glyphProbe(doc.font("regular")),
    bold: glyphProbe(doc.font("bold")),
  };
  const losses: ExportLoss[] = [...sheet.losses];
  const lyricLang = sheet.language ?? undefined;
  let y = page.margin;

  const measure = (text: string, style: Style) =>
    doc.font(style.font).fontSize(style.size).widthOfString(text);
  const draw = (text: string, style: Style, x: number, top: number) => {
    for (const character of text) {
      const codePoint = character.codePointAt(0)!;
      if (character.trim() !== "" && !probes[style.font](codePoint))
        losses.push(
          exportLoss(
            "pdf_glyph_unavailable",
            `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`,
          ),
        );
    }
    doc.font(style.font).fontSize(style.size).fillColor("black").text(text, x, top, {
      lineBreak: false,
    });
  };
  const ensure = (height: number) => {
    if (y + height <= bottom) return;
    doc.addPage();
    y = page.margin;
  };
  const root = doc.struct("Document");
  doc.addStructure(root);
  const paragraph = (
    text: string,
    style: Style,
    tag = "P",
    options: PDFKit.Mixins.StructureElementOptions = {},
  ) => {
    const lines = wrapWords(text, style);
    ensure(lines.length * style.leading);
    root.add(
      doc.struct(tag, options, () => {
        for (const line of lines) {
          draw(line, style, page.margin, y);
          y += style.leading;
        }
      }),
    );
  };
  const wrapWords = (text: string, style: Style): string[] => {
    const lines: string[] = [];
    for (const word of text.match(/\S+\s*/g) ?? [""]) {
      const last = lines.at(-1);
      if (last !== undefined && measure(`${last}${word}`.trimEnd(), style) <= contentWidth)
        lines[lines.length - 1] = `${last}${word}`;
      else lines.push(word);
    }
    return lines.map((line) => line.trimEnd());
  };

  const flow = (units: Unit[]): Unit[][] => {
    const lines: Unit[][] = [];
    let width = Infinity;
    for (const unit of units) {
      if (width + unit.width > contentWidth) {
        lines.push([]);
        width = 0;
      }
      lines.at(-1)!.push(unit);
      width += unit.width;
    }
    return lines;
  };
  const lyricText = (lineId: string, text: string) => {
    const safe = text.replaceAll("\t", " ");
    if (safe !== text) losses.push(exportLoss("lyric_text_normalized", lineId));
    return safe;
  };
  const chordWidth = (chord: ChordCell | null) =>
    chord === null ? 0 : measure(chord.symbol, styles.chord) + 6;
  const lyricUnits = (row: Extract<LeadSheetRow, { kind: "lyric" }>): Unit[] =>
    row.segments.flatMap(({ chord, text }) => {
      const words = lyricText(row.lineId, text).match(/\S+\s*|\s+/g) ?? [""];
      return words.map((word, index) => {
        const unitChord = index === 0 ? chord : null;
        return {
          chord: unitChord,
          text: word,
          width: Math.max(chordWidth(unitChord), measure(word, styles.lyric)),
        };
      });
    });

  const rowBlock = (row: LeadSheetRow) => {
    const directives = directiveText(row.directives);
    const directiveHeight = directives === "" ? 0 : styles.meta.leading;
    if (row.kind === "grid") {
      const lines = gridLines(row);
      ensure(directiveHeight + styles.grid.leading);
      if (directives !== "") paragraph(directives, styles.meta);
      ensure(lines.length * styles.grid.leading);
      root.add(
        doc.struct("P", { actual: gridSummary(row) }, () => {
          for (const line of lines) {
            draw(line, styles.grid, page.margin, y);
            y += styles.grid.leading;
          }
        }),
      );
      return;
    }
    const units =
      row.kind === "lyric"
        ? lyricUnits(row)
        : row.chords.map((chord) => ({ chord, text: "", width: chordWidth(chord) + 6 }));
    const lines = flow(units);
    const hasChords = units.some(({ chord }) => chord !== null);
    const hasLyrics = row.kind === "lyric";
    const pairHeight =
      (hasChords ? styles.chord.leading : 0) + (hasLyrics ? styles.lyric.leading : 0);
    ensure(directiveHeight + pairHeight);
    if (directives !== "") paragraph(directives, styles.meta);
    const element = doc.struct("P");
    root.add(element);
    for (const line of lines) {
      ensure(pairHeight);
      let x = page.margin;
      const lyricTop = y + (hasChords ? styles.chord.leading : 0);
      for (const unit of line) {
        const left = x;
        if (unit.chord !== null) {
          const chord = unit.chord;
          element.add(
            doc.struct("Span", { expanded: chord.spoken }, () =>
              draw(chord.symbol, styles.chord, left, y),
            ),
          );
        }
        if (hasLyrics && unit.text !== "")
          element.add(
            doc.struct("Span", lyricLang === undefined ? {} : { lang: lyricLang }, () =>
              draw(unit.text, styles.lyric, left, lyricTop),
            ),
          );
        x += unit.width;
      }
      y += pairHeight;
    }
    element.end();
    y += 4;
  };

  paragraph(sheet.title, styles.title, "H1");
  const { header } = sheet;
  const facts = [
    ...(header.key === null ? [] : [`Key: ${header.key}`]),
    ...(header.time === null ? [] : [`Time: ${header.time}`]),
    ...(header.tempo === null ? [] : [`Tempo: ${String(header.tempo)} BPM`]),
    ...(header.capo === null ? [] : [`Capo: ${String(header.capo)}`]),
  ];
  if (facts.length > 0) paragraph(facts.join(" · "), styles.meta);
  if (header.capoGuidance !== null) paragraph(header.capoGuidance, styles.meta);
  paragraph(header.presentation, styles.meta);
  y += 8;

  const heading = (text: string, following: number) => {
    ensure(styles.heading.leading + following);
    paragraph(text, styles.heading, "H2");
  };
  for (const section of sheet.sections) {
    heading(section.heading, styles.chord.leading + styles.lyric.leading);
    for (const row of section.rows) rowBlock(row);
    y += 6;
  }
  if (sheet.untimedLyrics !== null) {
    heading("Lyrics (untimed)", styles.lyric.leading);
    for (const { lineId, text } of sheet.untimedLyrics)
      paragraph(
        lyricText(lineId, text),
        styles.lyric,
        "P",
        lyricLang === undefined ? {} : { lang: lyricLang },
      );
  }

  heading(`Chord diagrams (${sheet.diagrams.instrument})`, DIAGRAM_CELL.height);
  if (sheet.diagrams.entries.length === 0)
    paragraph("No chord diagram is available for the chords in this song.", styles.meta);
  const perRow = Math.floor(contentWidth / DIAGRAM_CELL.width);
  for (const [index, entry] of sheet.diagrams.entries.entries()) {
    const column = index % perRow;
    if (column === 0) {
      if (index > 0) y += DIAGRAM_CELL.height;
      ensure(DIAGRAM_CELL.height);
    }
    const x = page.margin + column * DIAGRAM_CELL.width;
    const top = y;
    const figure: PDFKit.Mixins.StructureElementOptions & {
      bbox: [number, number, number, number];
    } = {
      alt: entry.alt,
      bbox: [x, top, x + DIAGRAM_CELL.width, top + DIAGRAM_CELL.height],
    };
    root.add(
      doc.struct("Figure", figure, () => {
        draw(entry.symbol, styles.heading, x + 8, top);
        const { baseFret } = drawDiagram(doc, entry, x, top);
        if (baseFret !== null) draw(`fret ${String(baseFret)}`, styles.meta, x + 2, top + 38);
      }),
    );
  }
  if (sheet.diagrams.entries.length > 0) y += DIAGRAM_CELL.height;
  if (sheet.diagrams.unavailable.length > 0)
    paragraph(`No diagram available: ${sheet.diagrams.unavailable.join(", ")}`, styles.meta);

  const credits = sheet.lyricsCredits;
  if (credits !== null) {
    y += 8;
    heading("Lyrics source and notices", styles.meta.leading);
    paragraph(
      `Source: ${credits.provider}${credits.reference === null ? "" : ` (${credits.reference})`}`,
      styles.meta,
    );
    for (const text of credits.attribution) paragraph(`Attribution: ${text}`, styles.meta);
    for (const text of credits.notices) paragraph(`Notice: ${text}`, styles.meta);
  }
  root.end();

  const { start, count } = doc.bufferedPageRange();
  for (const index of Array.from({ length: count }, (_, offset) => start + offset)) {
    doc.switchToPage(index);
    doc.markContent("Artifact", { type: "Pagination" });
    const label = `Page ${String(index + 1)} of ${String(count)}`;
    draw(label, styles.meta, page.width - page.margin - measure(label, styles.meta), bottom + 16);
    doc.endMarkedContent();
  }
  doc.end();
  return finished.then((bytes) => ({ bytes, losses: receiptLosses(losses) }));
}

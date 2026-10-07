import type { LeadSheetDiagram } from "@open-chords/domain";

export const DIAGRAM_CELL = { width: 124, height: 132 } as const;

type Diagram = LeadSheetDiagram["diagram"];
type StringsDiagram = Extract<Diagram, { kind: "strings" }>;
type PianoDiagram = Extract<Diagram, { kind: "piano" }>;

const shownFrets = 4;

function drawStrings(doc: PDFKit.PDFDocument, diagram: StringsDiagram, x: number, y: number) {
  const fretted = diagram.frets.filter((fret) => fret > 0);
  const base = Math.max(...diagram.frets) > shownFrets ? Math.min(...fretted) : 1;
  const spacing = 14;
  const fretHeight = 16;
  const width = spacing * (diagram.frets.length - 1);
  const left = x + (DIAGRAM_CELL.width - width) / 2;
  const top = y + 34;
  doc
    .lineWidth(base === 1 ? 3 : 1)
    .moveTo(left, top)
    .lineTo(left + width, top)
    .stroke();
  doc.lineWidth(1);
  for (const fret of [1, 2, 3, 4])
    doc
      .moveTo(left, top + fret * fretHeight)
      .lineTo(left + width, top + fret * fretHeight)
      .stroke();
  for (const [index] of diagram.frets.entries())
    doc
      .moveTo(left + index * spacing, top)
      .lineTo(left + index * spacing, top + shownFrets * fretHeight)
      .stroke();
  if (diagram.barre !== null && diagram.barre >= base) {
    const row = top + (diagram.barre - base + 0.5) * fretHeight;
    doc
      .lineWidth(6)
      .lineCap("round")
      .moveTo(left, row)
      .lineTo(left + width, row)
      .stroke()
      .lineWidth(1)
      .lineCap("butt");
  }
  for (const [index, fret] of diagram.frets.entries()) {
    const column = left + index * spacing;
    if (fret === 0) doc.circle(column, top - 7, 3.5).stroke();
    else doc.circle(column, top + (fret - base + 0.5) * fretHeight, 5).fill("black");
  }
  return { base, left, top };
}

function drawPiano(doc: PDFKit.PDFDocument, diagram: PianoDiagram, x: number, y: number) {
  const pressed = new Set([...diagram.notes, ...(diagram.bass === null ? [] : [diagram.bass])]);
  const lowest = Math.floor(Math.min(...pressed) / 12) * 12;
  const highest = Math.ceil((Math.max(...pressed) + 1) / 12) * 12;
  const whiteSteps = [0, 2, 4, 5, 7, 9, 11];
  const keys = Array.from({ length: highest - lowest }, (_, index) => lowest + index);
  const whites = keys.filter((key) => whiteSteps.includes(key % 12));
  const keyWidth = Math.min(10, (DIAGRAM_CELL.width - 8) / whites.length);
  const left = x + (DIAGRAM_CELL.width - keyWidth * whites.length) / 2;
  const top = y + 34;
  const height = 60;
  for (const [index, key] of whites.entries()) {
    doc.rect(left + index * keyWidth, top, keyWidth, height).stroke();
    if (pressed.has(key))
      doc.circle(left + (index + 0.5) * keyWidth, top + height - 8, 3).fill("black");
  }
  for (const key of keys.filter((candidate) => !whiteSteps.includes(candidate % 12))) {
    const index = whites.filter((white) => white < key).length;
    const keyLeft = left + index * keyWidth - keyWidth * 0.3;
    doc.rect(keyLeft, top, keyWidth * 0.6, height * 0.6).fill("black");
    if (pressed.has(key))
      doc
        .circle(keyLeft + keyWidth * 0.3, top + height * 0.6 - 6, 2.5)
        .lineWidth(1)
        .fillAndStroke("white", "black");
  }
}

export function drawDiagram(
  doc: PDFKit.PDFDocument,
  { diagram }: LeadSheetDiagram,
  x: number,
  y: number,
): { baseFret: number | null } {
  doc.fillColor("black").strokeColor("black");
  if (diagram.kind === "piano") {
    drawPiano(doc, diagram, x, y);
    return { baseFret: null };
  }
  const { base } = drawStrings(doc, diagram, x, y);
  return { baseFret: base === 1 ? null : base };
}

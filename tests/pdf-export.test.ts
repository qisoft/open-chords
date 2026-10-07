import { createHash } from "node:crypto";

import { expect, it } from "vitest";

import { renderLeadSheetPdf } from "../apps/desktop/src/main/pdf-lead-sheet.ts";
import { captureJsonExport } from "../packages/domain/src/json-export.ts";
import { projectLeadSheet } from "../packages/domain/src/lead-sheet.ts";
import type { ProjectContract } from "../packages/domain/src/schema.ts";
import {
  chord,
  goldenProject,
  leadSheetProject,
  originalTimeline,
} from "./support/export-fixture.ts";
import { inspectPdf } from "./support/pdf-inspection.ts";

const render = (project: ProjectContract) =>
  renderLeadSheetPdf(
    projectLeadSheet(captureJsonExport(project, { presentation: "current" }), {
      title: project.id,
    }),
  );
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

it("renders byte-identical PDF bytes pinned to a golden hash", async () => {
  const first = await render(leadSheetProject());
  const second = await render(leadSheetProject());
  expect(first.bytes.equals(second.bytes)).toBe(true);
  expect(sha256(first.bytes)).toBe(
    "47ec0b527db35d0e42ae169ad80c88fd7e75e21ba6121e8eb22f3eeb01da872e",
  );
  expect(first.losses).toEqual([
    "abstained_chord_marked_unknown",
    "analysis_provenance_not_represented",
    "chord_diagram_unavailable:Gm9add9add11/D",
    "chord_symbol_not_portable:Gm9add9add11/D",
    "confidence_not_represented",
    "edit_history_not_represented",
    "lyrics_mismatch_not_represented",
    "sample_timing_not_represented",
    "stable_identity_not_represented",
    "unmetered_seconds_not_represented",
  ]);
});

it("is tagged, language-declared and embeds every font without a PDF/A or PDF/UA claim", async () => {
  const { bytes } = await render(leadSheetProject());
  const pdf = await inspectPdf(bytes);
  expect(pdf.markInfo).toEqual(
    new Map([
      ["Marked", true],
      ["UserProperties", false],
      ["Suspects", false],
    ]),
  );
  expect(pdf.info).toMatchObject({
    Language: "en",
    PDFFormatVersion: "1.7",
    Title: "project_golden",
    Producer: "Open Chords",
  });
  expect(pdf.pages).toHaveLength(1);
  const [page] = pdf.pages;
  expect(page!.structure).toEqual([
    "H1",
    "P",
    "P",
    "P",
    "H2",
    "P[Bar 1: G minor nine add nine add eleven over D on beat 1]",
    "P",
    "P[Bar 1: unknown chord on beat 1]",
    "H2",
    "P(Span{en},Span{en})",
    "P(Span,Span{en},Span{en})",
    "P(Span)",
    "H2",
    "Figure[F seven, guitar: low E fret 1, A fret 3, D fret 1, G fret 2, B fret 1, high E fret 1; barre at fret 1]",
    "P",
    "H2",
    "P",
    "P",
    "P",
  ]);
  expect(page!.text).toEqual([
    "project_golden",
    "Key: Gm · Time: 4/4 · Tempo: 360 BPM · Capo: 2",
    "Capo 2: these shapes match the Original recording.",
    "Current presentation: transposed -2 semitones",
    "Intro",
    "| Gm9add9add11/D",
    ". |",
    "Time: 3/4",
    "| ?",
    ".",
    ". |",
    "Chorus",
    "go",
    "go",
    "N.C.",
    "home",
    "go",
    "F7",
    "Chord diagrams (guitar)",
    "F7",
    "No diagram available: Gm9add9add11/D",
    "Lyrics source and notices",
    "Source: user",
    "Attribution: User-supplied fixture text",
    "Notice: Test fixture only",
    "Page 1 of 1",
  ]);
  expect(page!.fonts).toEqual([
    { name: "CZZZZZ+NotoSans-Bold", embedded: true },
    { name: "BZZZZZ+NotoSans-Regular", embedded: true },
  ]);
  const raw = bytes.toString("latin1");
  expect(raw.match(/\/FontFile2 /g)).toHaveLength(2);
  expect(raw).toContain("/DisplayDocTitle true");
  expect(raw).not.toMatch(/pdfuaid|pdfaid/);
});

it("prints unsupported rich chords exactly and lists them without inventing a diagram", async () => {
  const project = goldenProject();
  const events = originalTimeline(project).chordEvents;
  events[0]!.value = chord({ additions: ["add9"], omissions: ["no3"] });
  events[3]!.value = chord({ extensions: ["7"], alterations: ["#11", "b9"], bass: "G" });
  project.activeView!.presentation.beginnerView = true;
  const { bytes, losses } = await render(project);
  const [page] = (await inspectPdf(bytes)).pages;
  expect(page!.text).toEqual(
    expect.arrayContaining(["Cadd9no3", "C7b9#11/G", "No diagram available: Cadd9no3, C7b9#11/G"]),
  );
  expect(page!.structure.filter((role) => role.startsWith("Figure"))).toEqual([]);
  expect(losses).toEqual(
    expect.arrayContaining([
      "chord_symbol_not_portable:C7b9#11/G",
      "chord_diagram_unavailable:C7b9#11/G",
      "chord_symbol_not_portable:Cadd9no3",
      "chord_diagram_unavailable:Cadd9no3",
    ]),
  );
});

it("reports missing glyphs and paginates with page artifacts", async () => {
  const project = goldenProject();
  project.lyricsDocuments[0]!.notices = Array.from(
    { length: 60 },
    (_, index) => `Notice ${String(index + 1)} 愛`,
  );
  const { bytes, losses } = await render(project);
  expect(losses).toContain("pdf_glyph_unavailable:U+611B");
  const pages = (await inspectPdf(bytes)).pages;
  expect(pages.map(({ text }) => text.at(-1))).toEqual(["Page 1 of 2", "Page 2 of 2"]);
  expect(pages[1]!.text[0]).toMatch(/^Notice: Notice \d+ /);
});

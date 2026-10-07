export const EXPORT_LOSS_CODES = [
  "abstained_chord_marked_unknown",
  "analysis_provenance_not_represented",
  "chord_diagram_unavailable",
  "chord_symbol_not_portable",
  "confidence_not_represented",
  "directive_text_normalized",
  "edit_history_not_represented",
  "key_mode_not_representable",
  "line_end_timing_not_represented",
  "lrc_line_coverage",
  "lrc_line_omitted",
  "lyric_text_normalized",
  "lyrics_mismatch_not_represented",
  "lyrics_notices_not_represented",
  "lyrics_untimed_chords_not_anchored",
  "mid_beat_position_rounded",
  "pdf_glyph_unavailable",
  "sample_timing_not_represented",
  "stable_identity_not_represented",
  "unmetered_seconds_not_represented",
  "word_timing_not_represented",
] as const;
export type ExportLossCode = (typeof EXPORT_LOSS_CODES)[number];
export type ExportLoss = ExportLossCode | `${ExportLossCode}:${string}`;

export function exportLoss(code: ExportLossCode, subject?: string): ExportLoss {
  return subject === undefined ? code : `${code}:${subject}`;
}

export function receiptLosses(losses: Iterable<ExportLoss>): ExportLoss[] {
  return [...new Set(losses)].sort();
}

export function parseExportLoss(
  value: string,
): { code: ExportLossCode; subject: string | null } | null {
  const separator = value.indexOf(":");
  const code = separator < 0 ? value : value.slice(0, separator);
  const known = EXPORT_LOSS_CODES.find((candidate) => candidate === code);
  if (known === undefined) return null;
  return { code: known, subject: separator < 0 ? null : value.slice(separator + 1) };
}

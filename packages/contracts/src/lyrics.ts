import { z } from "zod";

export const LyricsSearchSchema = z.strictObject({
  provider: z.enum(["lrclib", "youtube"]),
  query: z.string().trim().min(1).max(200),
});
export const LyricsCandidateSchema = z.strictObject({
  id: z.string().regex(/^candidate_[a-f0-9]{32}$/),
  label: z.string().max(700),
  provider: z.enum(["lrclib", "youtube_human", "youtube_automatic"]),
  language: z.string().max(35),
  timingKind: z.enum(["untimed", "line"]),
});
export type LyricsSearch = z.infer<typeof LyricsSearchSchema>;
export type LyricsCandidate = z.infer<typeof LyricsCandidateSchema>;

import { z } from "zod";

import type { ProjectContract } from "./schema.ts";

const sha = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const id = z.string().min(1).max(160);
export const LyricsAnchorSchema = z.strictObject({
  id,
  lyricsDocumentId: id,
  analysisRevisionId: id,
  firstTokenId: id,
  lastTokenId: id,
  startSample: z.number().int().nonnegative(),
  endSample: z.number().int().positive(),
});
export type LyricsAnchor = z.infer<typeof LyricsAnchorSchema>;
export const AlignmentRecipeSchema = z.strictObject({
  version: z.literal("1.0"),
  projectId: id,
  lyricsDocumentId: id,
  documentHash: sha,
  analysisRevisionId: id,
  revisionHash: sha,
  canonicalAudioFingerprint: sha,
  durationSamples: z.number().int().positive(),
  sampleRate: z.number().int().positive(),
  normalization: z.literal("unicode_nfkc_lower_v1"),
  anchors: z.array(LyricsAnchorSchema).max(1000),
  packId: id,
  runtimeId: id,
  runtimeManifestHash: z.union([z.string().regex(/^[a-f0-9]{64}$/), z.literal("unavailable")]),
  workerProfile: z.literal("kalpy_single_primary_v1_beam10_retry40"),
  artifacts: z
    .array(z.strictObject({ id, version: id, sha256: z.string().regex(/^[a-f0-9]{64}$/) }))
    .max(2),
});
export const AlignmentProvenanceSchema = z.strictObject({
  recipe: AlignmentRecipeSchema,
  recipeHash: sha,
  resultHash: sha,
  qualityStatus: z.literal("benchmark_pending"),
});
export type AlignmentRecipe = z.infer<typeof AlignmentRecipeSchema>;

export function resolveLyricsAnchors(project: ProjectContract): LyricsAnchor[] {
  const active = project.activeView;
  if (!active) return [];
  const layer = project.editLayers.find((item) => item.id === active.editLayerId);
  if (!layer) return [];
  const transactions: typeof layer.transactions = [];
  const byId = new Map(layer.transactions.map((item) => [item.id, item]));
  let current = layer.transactions[active.editHistoryPosition - 1];
  while (current) {
    transactions.unshift(current);
    current =
      current.parentTransactionId === null ? undefined : byId.get(current.parentTransactionId);
  }
  const anchors = new Map<string, LyricsAnchor>();
  for (const transaction of transactions)
    for (const operation of transaction.operations) {
      if (operation.type === "set_lyrics_anchor")
        anchors.set(operation.anchor.id, operation.anchor);
      if (operation.type === "remove_lyrics_anchor") anchors.delete(operation.anchorId);
    }
  return structuredClone(
    [...anchors.values()].filter(
      (anchor) =>
        anchor.lyricsDocumentId === active.lyricsDocumentId &&
        anchor.analysisRevisionId === active.analysisRevisionId,
    ),
  );
}

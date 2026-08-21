import { StableIdSchema } from "@open-chords/domain";
import { z } from "zod";

const Sha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const TimestampSchema = z.iso.datetime({ offset: true });

export const SourceLocatorSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    fingerprint: Sha256Schema,
    id: StableIdSchema,
    kind: z.literal("local_file"),
    path: z.string().min(1),
    status: z.enum(["available", "unavailable"]),
    verifiedAt: TimestampSchema,
  }),
  z.strictObject({
    canonicalUrl: z.url().startsWith("https://www.youtube.com/watch?v="),
    id: StableIdSchema,
    kind: z.literal("youtube"),
    observedAt: TimestampSchema,
    videoId: z.string().regex(/^[A-Za-z0-9_-]{11}$/),
  }),
]);

const SelectedMediaFormatSchema = z.strictObject({
  audioCodec: z.string().min(1),
  container: z.string().min(1),
  mimeType: z.string().min(1),
  providerFormatId: z.string().min(1).optional(),
});

const ComponentProvenanceSchema = z.strictObject({
  hash: Sha256Schema,
  id: z.string().min(1),
  version: z.string().min(1),
});
const ComponentsSchema = z
  .array(ComponentProvenanceSchema)
  .min(1)
  .refine(
    (components) => new Set(components.map(({ id }) => id)).size === components.length,
    "Component provenance IDs must be unique",
  );

export const SourceSnapshotSchema = z.strictObject({
  byteFingerprint: Sha256Schema,
  byteSize: z.number().int().positive(),
  canonicalAudioFingerprint: Sha256Schema,
  durationSamples: z.number().int().positive(),
  id: StableIdSchema,
  metadataObservationIds: z
    .array(StableIdSchema)
    .refine((ids) => new Set(ids).size === ids.length, "Metadata observation IDs must be unique"),
  observedAt: TimestampSchema,
  provenance: z.discriminatedUnion("kind", [
    z.strictObject({
      components: ComponentsSchema,
      kind: z.literal("local_file"),
    }),
    z.strictObject({
      acquisitionAttemptId: StableIdSchema,
      brokerSummary: z.strictObject({
        downloadedBytes: z.number().int().positive(),
        redirectCount: z.number().int().nonnegative(),
        requestCount: z.number().int().positive(),
        wallTimeMs: z.number().int().positive(),
      }),
      canonicalUrl: z.url().startsWith("https://www.youtube.com/watch?v="),
      components: ComponentsSchema,
      kind: z.literal("youtube_acquisition"),
      policy: z.strictObject({
        hash: Sha256Schema,
        id: z.string().min(1),
        version: z.string().min(1),
      }),
      provider: z.literal("youtube"),
      videoId: z.string().regex(/^[A-Za-z0-9_-]{11}$/),
    }),
  ]),
  selectedFormat: SelectedMediaFormatSchema,
});

export const SourceMetadataObservationSchema = z.strictObject({
  declaredDurationSeconds: z.number().finite().nonnegative().optional(),
  id: StableIdSchema,
  observedAt: TimestampSchema,
  provider: z.string().min(1),
  thumbnailUrl: z.url().optional(),
  title: z.string().min(1).optional(),
  uploader: z.string().min(1).optional(),
});

export const SourceRecordSchema = z.strictObject({
  id: StableIdSchema,
  identity: z.discriminatedUnion("kind", [
    z.strictObject({ fingerprint: Sha256Schema, kind: z.literal("local_file") }),
    z.strictObject({
      kind: z.literal("youtube"),
      provider: z.literal("youtube"),
      videoId: z.string().regex(/^[A-Za-z0-9_-]{11}$/),
    }),
  ]),
  locators: z.array(SourceLocatorSchema),
  metadataObservations: z.array(SourceMetadataObservationSchema),
  snapshots: z.array(SourceSnapshotSchema),
});

export const ExportReceiptSchema = z.strictObject({
  activeViewHash: Sha256Schema,
  createdAt: TimestampSchema,
  format: z.enum(["open_chords_json", "chordpro", "lrc", "pdf", "project_archive"]),
  id: StableIdSchema,
  omissions: z.array(z.string().min(1)),
  outputHash: Sha256Schema,
  outputLocation: z.string().min(1),
  profileVersion: z.string().min(1),
});

export const ProjectOwnedRecordsSchema = z
  .strictObject({
    exportReceipts: z.array(ExportReceiptSchema),
    extensions: z.record(z.string().regex(/^[a-z0-9]+(?:\.[a-z0-9-]+)+$/), z.unknown()),
    projectRange: z.strictObject({
      endSourceSample: z.number().int().positive(),
      sourceId: StableIdSchema,
      startSourceSample: z.number().int().nonnegative(),
    }),
    sources: z.array(SourceRecordSchema).min(1),
  })
  .superRefine((records, context) => {
    requireUniqueIds(records.sources, "Source", ["sources"], context);
    requireUniqueIds(records.exportReceipts, "Export Receipt", ["exportReceipts"], context);
    for (const [sourceIndex, source] of records.sources.entries()) {
      requireUniqueIds(
        source.locators,
        "Source Locator",
        ["sources", sourceIndex, "locators"],
        context,
      );
      requireUniqueIds(
        source.snapshots,
        "Source Snapshot",
        ["sources", sourceIndex, "snapshots"],
        context,
      );
      requireUniqueIds(
        source.metadataObservations,
        "Source Metadata Observation",
        ["sources", sourceIndex, "metadataObservations"],
        context,
      );
      for (const [locatorIndex, locator] of source.locators.entries()) {
        const identityMatches =
          (source.identity.kind === "local_file" &&
            locator.kind === "local_file" &&
            source.identity.fingerprint === locator.fingerprint) ||
          (source.identity.kind === "youtube" &&
            locator.kind === "youtube" &&
            source.identity.videoId === locator.videoId);
        if (!identityMatches) {
          context.addIssue({
            code: "custom",
            message: "Source Locator does not match Source identity",
            path: ["sources", sourceIndex, "locators", locatorIndex],
          });
        }
        if (
          locator.kind === "youtube" &&
          locator.canonicalUrl !== `https://www.youtube.com/watch?v=${locator.videoId}`
        ) {
          context.addIssue({
            code: "custom",
            message: "YouTube Locator URL must be reconstructed from its exact video ID",
            path: ["sources", sourceIndex, "locators", locatorIndex, "canonicalUrl"],
          });
        }
      }
      for (const [snapshotIndex, snapshot] of source.snapshots.entries()) {
        const observations = new Map(
          source.metadataObservations.map((observation) => [observation.id, observation]),
        );
        for (const [referenceIndex, observationId] of snapshot.metadataObservationIds.entries()) {
          const observation = observations.get(observationId);
          if (
            observation === undefined ||
            (snapshot.provenance.kind === "youtube_acquisition" &&
              observation.provider !== "youtube")
          ) {
            context.addIssue({
              code: "custom",
              message: "Source Snapshot metadata reference is missing or has the wrong provider",
              path: [
                "sources",
                sourceIndex,
                "snapshots",
                snapshotIndex,
                "metadataObservationIds",
                referenceIndex,
              ],
            });
          }
        }
        if (
          snapshot.provenance.kind === "youtube_acquisition" &&
          snapshot.metadataObservationIds.length === 0
        ) {
          context.addIssue({
            code: "custom",
            message: "YouTube Source Snapshot requires acquisition-time metadata",
            path: ["sources", sourceIndex, "snapshots", snapshotIndex, "metadataObservationIds"],
          });
        }
        const snapshotMatches =
          (source.identity.kind === "local_file" &&
            snapshot.provenance.kind === "local_file" &&
            snapshot.byteFingerprint === source.identity.fingerprint) ||
          (source.identity.kind === "youtube" &&
            snapshot.provenance.kind === "youtube_acquisition" &&
            snapshot.provenance.videoId === source.identity.videoId &&
            snapshot.provenance.canonicalUrl ===
              `https://www.youtube.com/watch?v=${source.identity.videoId}` &&
            snapshot.selectedFormat.providerFormatId !== undefined &&
            snapshot.provenance.brokerSummary.downloadedBytes === snapshot.byteSize);
        if (!snapshotMatches) {
          context.addIssue({
            code: "custom",
            message: "Source Snapshot provenance does not match Source identity",
            path: ["sources", sourceIndex, "snapshots", snapshotIndex],
          });
        }
      }
    }
    if (!records.sources.some(({ id }) => id === records.projectRange.sourceId)) {
      context.addIssue({
        code: "custom",
        message: "Project Range references an unknown Source",
        path: ["projectRange", "sourceId"],
      });
    }
    if (records.projectRange.endSourceSample <= records.projectRange.startSourceSample) {
      context.addIssue({
        code: "custom",
        message: "Project Range must be half-open with start < end",
        path: ["projectRange"],
      });
    }
  });

export type ProjectOwnedRecords = z.infer<typeof ProjectOwnedRecordsSchema>;

function requireUniqueIds(
  records: readonly { id: string }[],
  label: string,
  path: Array<number | string>,
  context: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  for (const [index, record] of records.entries()) {
    if (seen.has(record.id)) {
      context.addIssue({
        code: "custom",
        message: `${label} IDs must be unique`,
        path: [...path, index, "id"],
      });
    }
    seen.add(record.id);
  }
}

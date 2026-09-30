import { createHash } from "node:crypto";
import { basename } from "node:path";

import { ProjectEnvelopeSchema } from "@open-chords/contracts";
import { canonicalSerialize, StableIdSchema } from "@open-chords/domain";
import { z } from "zod";

import { writeArchiveZip } from "./project-archive-zip.ts";
import { ProjectOwnedRecordsSchema, type ProjectOwnedRecords } from "./project-library-records.ts";

export const ARCHIVE_FORMAT = "open-chords/portable-project-archive";
export const ARCHIVED_PROJECT_FORMAT = "open-chords/portable-project";
export const ARCHIVE_FORMAT_VERSION = "1.0";
export const ARCHIVE_EXTENSION = ".ocarchive";
export const ARCHIVE_ENTRIES = {
  manifest: "manifest.json",
  media: "media/project-range.pcm",
  project: "project.json",
} as const;
export const ARCHIVE_ENTRY_LIMITS = {
  manifest: 64 * 1024,
  media: 128 * 1024 * 1024,
  project: 32 * 1024 * 1024,
} as const;

const Sha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const RequirementText = z.string().min(1).max(200);

export const ArchiveRequirementSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    id: RequirementText,
    kind: z.literal("analysis_component"),
    sha256: Sha256Schema,
    version: RequirementText,
  }),
  z.strictObject({
    id: RequirementText,
    kind: z.literal("model_artifact"),
    sha256: Sha256Schema,
    version: RequirementText,
  }),
  z.strictObject({
    id: RequirementText,
    kind: z.literal("alignment_runtime"),
    sha256: Sha256Schema,
  }),
]);

export const ArchiveMediaDeclarationSchema = z.strictObject({
  byteSize: z.number().int().positive().max(ARCHIVE_ENTRY_LIMITS.media),
  channels: z.literal(1),
  encoding: z.literal("pcm_s16le"),
  endSourceSample: z.number().int().positive(),
  path: z.literal(ARCHIVE_ENTRIES.media),
  sampleRate: z.number().int().positive().max(384_000),
  sha256: Sha256Schema,
  sourceId: StableIdSchema,
  sourceSnapshotId: StableIdSchema,
  startSourceSample: z.number().int().nonnegative(),
});

export const ArchiveManifestSchema = z.strictObject({
  format: z.literal(ARCHIVE_FORMAT),
  formatVersion: z.literal(ARCHIVE_FORMAT_VERSION),
  media: ArchiveMediaDeclarationSchema.optional(),
  project: z.strictObject({
    byteSize: z.number().int().positive().max(ARCHIVE_ENTRY_LIMITS.project),
    path: z.literal(ARCHIVE_ENTRIES.project),
    sha256: Sha256Schema,
  }),
  requirements: z.array(ArchiveRequirementSchema).max(1000),
});

export const ArchivedProjectSchema = z.strictObject({
  envelope: ProjectEnvelopeSchema,
  format: z.literal(ARCHIVED_PROJECT_FORMAT),
  formatVersion: z.literal(ARCHIVE_FORMAT_VERSION),
  records: ProjectOwnedRecordsSchema,
});

export type ArchiveManifest = z.infer<typeof ArchiveManifestSchema>;
export type ArchiveMediaDeclaration = z.infer<typeof ArchiveMediaDeclarationSchema>;
export type ArchiveRequirement = z.infer<typeof ArchiveRequirementSchema>;
export type ArchivedProject = z.infer<typeof ArchivedProjectSchema>;

export type ArchiveOmission =
  | "local_source_locators_omitted"
  | "receipt_locations_reduced_to_names";

export const sha256 = (bytes: Buffer | string) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

// The archive carries every retained Project record except machine-local authority:
// local file Locators and private receipt destinations.
export function archivedProjectFor(project: {
  envelope: z.infer<typeof ProjectEnvelopeSchema>;
  records: ProjectOwnedRecords;
}): { document: ArchivedProject; omissions: ArchiveOmission[] } {
  const omissions = new Set<ArchiveOmission>();
  const { envelope, records } = structuredClone(project);
  const sources = records.sources.map((source) => {
    const locators = source.locators.filter((locator) => locator.kind === "youtube");
    if (locators.length !== source.locators.length) omissions.add("local_source_locators_omitted");
    return { ...source, locators };
  });
  const exportReceipts = records.exportReceipts.map((receipt) => {
    const name = receiptDisplayName(receipt.outputLocation);
    if (name !== receipt.outputLocation) omissions.add("receipt_locations_reduced_to_names");
    return { ...receipt, outputLocation: name };
  });
  return {
    document: ArchivedProjectSchema.parse({
      envelope,
      format: ARCHIVED_PROJECT_FORMAT,
      formatVersion: ARCHIVE_FORMAT_VERSION,
      records: { ...records, exportReceipts, sources },
    }),
    omissions: [...omissions].toSorted(),
  };
}

export function receiptDisplayName(location: string): string {
  return basename(location.replaceAll("\\", "/")).slice(0, 240) || "Export";
}

export function archiveRequirementsFor(document: ArchivedProject): ArchiveRequirement[] {
  const requirements = [
    ...document.records.analysisManifests.flatMap(({ manifest }) =>
      [...manifest.recipe.components, manifest.recipe.numericalBackend].map((component) => ({
        id: component.id,
        kind: "analysis_component" as const,
        sha256: component.hash,
        version: component.version,
      })),
    ),
    ...document.envelope.payload.lyricsAlignments.flatMap((alignment) => {
      const recipe = alignment.provenance?.recipe;
      if (recipe === undefined) return [];
      return [
        ...recipe.artifacts.map((artifact) => ({
          id: artifact.id,
          kind: "model_artifact" as const,
          sha256: `sha256:${artifact.sha256}`,
          version: artifact.version,
        })),
        ...(recipe.runtimeManifestHash === "unavailable"
          ? []
          : [
              {
                id: recipe.runtimeId,
                kind: "alignment_runtime" as const,
                sha256: `sha256:${recipe.runtimeManifestHash}`,
              },
            ]),
      ];
    }),
  ];
  const unique = new Map(
    requirements.map((requirement) => [canonicalSerialize(requirement), requirement]),
  );
  return [...unique.entries()]
    .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([, requirement]) => ArchiveRequirementSchema.parse(requirement));
}

export function writePortableProjectArchive(input: {
  document: ArchivedProject;
  media?: Omit<ArchiveMediaDeclaration, "byteSize" | "path" | "sha256"> & { bytes: Buffer };
}): { archive: Buffer; manifestHash: string; projectHash: string } {
  const project = Buffer.from(canonicalSerialize(input.document), "utf8");
  if (project.length > ARCHIVE_ENTRY_LIMITS.project)
    throw new Error("Portable Project Archive exceeds its Project size budget");
  const media =
    input.media === undefined
      ? undefined
      : (() => {
          const { bytes, ...declaration } = input.media;
          return {
            bytes,
            declaration: ArchiveMediaDeclarationSchema.parse({
              ...declaration,
              byteSize: bytes.length,
              path: ARCHIVE_ENTRIES.media,
              sha256: sha256(bytes),
            }),
          };
        })();
  const manifest = Buffer.from(
    canonicalSerialize(
      ArchiveManifestSchema.parse({
        format: ARCHIVE_FORMAT,
        formatVersion: ARCHIVE_FORMAT_VERSION,
        ...(media === undefined ? {} : { media: media.declaration }),
        project: {
          byteSize: project.length,
          path: ARCHIVE_ENTRIES.project,
          sha256: sha256(project),
        },
        requirements: archiveRequirementsFor(input.document),
      }),
    ),
    "utf8",
  );
  return {
    archive: writeArchiveZip([
      { name: ARCHIVE_ENTRIES.manifest, bytes: manifest },
      { name: ARCHIVE_ENTRIES.project, bytes: project },
      ...(media === undefined ? [] : [{ name: ARCHIVE_ENTRIES.media, bytes: media.bytes }]),
    ]),
    manifestHash: sha256(manifest),
    projectHash: sha256(project),
  };
}

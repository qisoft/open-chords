import { createHash } from "node:crypto";

import {
  CONTRACT_VERSION,
  parseContractEnvelope,
  ProjectEnvelopeSchema,
} from "@open-chords/contracts";
import { validateAnalysisManifestProvenance, type AnalysisManifest } from "@open-chords/domain";
import { z } from "zod";

import { ProjectOwnedRecordsSchema, type ProjectOwnedRecords } from "./project-library-records.ts";

export const StoredProjectPayloadSchema = z.strictObject({
  envelope: ProjectEnvelopeSchema,
  format: z.literal("open-chords/project-library-payload"),
  records: ProjectOwnedRecordsSchema,
  schemaVersion: z.literal("1.0"),
});
export type StoredProjectPayload = z.infer<typeof StoredProjectPayloadSchema>;

export class ProjectLibraryIncompatibleSchemaError extends Error {
  constructor(schemaVersion: string) {
    super(`Project schema ${schemaVersion} has an unsupported major version`);
    this.name = "ProjectLibraryIncompatibleSchemaError";
  }
}

export function validateStoredPayload(input: unknown): StoredProjectPayload {
  const payload = StoredProjectPayloadSchema.parse(input);
  const supportedMajor = parseSchemaVersion(CONTRACT_VERSION).major;
  const envelopeMajor = parseSchemaVersion(payload.envelope.schemaVersion).major;
  const projectMajor = parseSchemaVersion(payload.envelope.payload.schemaVersion).major;
  if (envelopeMajor !== supportedMajor)
    throw new ProjectLibraryIncompatibleSchemaError(payload.envelope.schemaVersion);
  if (projectMajor !== supportedMajor)
    throw new ProjectLibraryIncompatibleSchemaError(payload.envelope.payload.schemaVersion);
  parseContractEnvelope(payload.envelope);
  const manifestsByRevision = new Map(
    payload.records.analysisManifests.map((record) => [record.analysisRevisionId, record]),
  );
  const legacyManifestless = new Set(payload.records.legacyManifestlessAnalysisRevisionIds);
  for (const revision of payload.envelope.payload.analysisRevisions) {
    const record = manifestsByRevision.get(revision.id);
    if ((record === undefined) === !legacyManifestless.has(revision.id)) {
      throw new Error("Analysis Revision must have exactly one Manifest or explicit legacy state");
    }
    if (record !== undefined && revision.manifestHash !== record.hash) {
      throw new Error("Analysis Manifest record does not match its Analysis Revision");
    }
    if (record !== undefined) {
      validateAnalysisManifestProvenance({
        digest: hashContent,
        manifest: record.manifest,
        revision,
      });
      if (!analysisManifestSourceIsVerified(payload.records, record.manifest)) {
        throw new Error("Analysis Manifest Source identity is not retained by Project authority");
      }
    }
  }
  for (const revisionId of [...manifestsByRevision.keys(), ...legacyManifestless]) {
    if (!payload.envelope.payload.analysisRevisions.some(({ id }) => id === revisionId)) {
      throw new Error("Analysis Manifest provenance references an unknown Analysis Revision");
    }
  }
  const { projectRange } = payload.records;
  if (
    projectRange.endSourceSample - projectRange.startSourceSample !==
    payload.envelope.payload.durationSamples
  ) {
    throw new Error("Project Range length must equal Project durationSamples");
  }
  const source = payload.records.sources.find(({ id }) => id === projectRange.sourceId);
  if (
    source === undefined ||
    !source.snapshots.some(({ durationSamples }) => durationSamples >= projectRange.endSourceSample)
  ) {
    throw new Error("Project Range must fit a retained Source Snapshot");
  }
  return payload;
}

export function assertValidProjectPayload(input: {
  envelope: unknown;
  records: ProjectOwnedRecords;
}): void {
  buildStoredPayload(input);
}

export function buildStoredPayload(input: {
  envelope: unknown;
  records: ProjectOwnedRecords;
}): StoredProjectPayload {
  return validateStoredPayload({
    envelope: input.envelope,
    format: "open-chords/project-library-payload",
    records: input.records,
    schemaVersion: "1.0",
  });
}

export function analysisManifestSourceIsVerified(
  records: ProjectOwnedRecords,
  manifest: AnalysisManifest,
): boolean {
  const identity = manifest.candidateIdentity;
  const source = records.sources.find(({ id }) => id === records.projectRange.sourceId);
  const snapshot = source?.snapshots.find((candidate) =>
    identity.sourceIdentityKind === "source_snapshot"
      ? candidate.id === identity.sourceSnapshotId
      : candidate.canonicalAudioFingerprint === identity.canonicalAudioFingerprint,
  );
  return snapshot?.canonicalAudioFingerprint === identity.canonicalAudioFingerprint;
}

export function hashContent(content: string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

export function parseSchemaVersion(version: string): { major: number; minor: number } {
  const match = /^(\d+)\.(\d+)$/.exec(version);
  if (match?.[1] === undefined || match[2] === undefined) throw new Error("Invalid schema version");
  return { major: Number(match[1]), minor: Number(match[2]) };
}

export function compareSchemaVersions(left: string, right: string): number {
  const leftVersion = parseSchemaVersion(left);
  const rightVersion = parseSchemaVersion(right);
  if (leftVersion.major !== rightVersion.major) return leftVersion.major - rightVersion.major;
  return leftVersion.minor - rightVersion.minor;
}

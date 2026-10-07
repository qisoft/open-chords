import { CONTRACT_MAJOR, CONTRACT_MINOR } from "@open-chords/contracts";
import { canonicalSerialize } from "@open-chords/domain";
import { z } from "zod";

import {
  ARCHIVE_ENTRIES,
  ARCHIVE_ENTRY_LIMITS,
  ARCHIVE_FORMAT,
  ARCHIVE_FORMAT_VERSION,
  ARCHIVED_PROJECT_FORMAT,
  ArchiveManifestSchema,
  archiveRequirementsFor,
  ArchivedProjectSchema,
  receiptDisplayName,
  sha256,
  type ArchiveMediaDeclaration,
  type ArchivedProject,
} from "./project-archive-format.ts";
import {
  ArchiveZipError,
  readArchiveZip,
  type ArchiveZipRejection,
} from "./project-archive-zip.ts";
import { assertValidProjectPayload } from "./project-payload.ts";

export type ArchiveRejection =
  | ArchiveZipRejection
  | "active_content"
  | "declaration_mismatch"
  | "hash_mismatch"
  | "invariant_invalid"
  | "missing_entry"
  | "reference_invalid"
  | "schema_invalid"
  | "undeclared_entry"
  | "unsupported_version";

export class ArchiveRejectionError extends Error {
  readonly reason: ArchiveRejection;
  constructor(reason: ArchiveRejection) {
    super(`Portable Project Archive rejected: ${reason}`);
    this.name = "ArchiveRejectionError";
    this.reason = reason;
  }
}

export type InspectedArchive = {
  document: ArchivedProject;
  manifestHash: string;
  media?: { bytes: Buffer; declaration: ArchiveMediaDeclaration };
};

const ACTIVE_CONTENT_EXTENSION =
  /\.(?:app|applescript|bat|cjs|cmd|com|command|cpl|desktop|dll|dylib|exe|hta|htm|html|jar|js|jse|lnk|mjs|msi|node|pif|ps1|py|scpt|scr|sh|so|svg|url|vbe|vbs|wasm|workflow|ws|wsf|xhtml)$/iu;
const VersionProbeSchema = z.object({
  format: z.string(),
  formatVersion: z.string().regex(/^\d+\.\d+$/),
});
const EnvelopeVersionProbeSchema = z.object({
  envelope: z.object({
    payload: z.object({ schemaVersion: z.string().regex(/^\d+\.\d+$/) }),
    schemaVersion: z.string().regex(/^\d+\.\d+$/),
  }),
});

function reject(reason: ArchiveRejection): never {
  throw new ArchiveRejectionError(reason);
}

// The archive is quarantined as a private in-memory copy. Nothing in it reaches the
// Library, the Offline Media Cache or the filesystem until every check here passes.
export function inspectPortableProjectArchive(bytes: Buffer): InspectedArchive {
  let entries: ReturnType<typeof readArchiveZip>;
  try {
    entries = readArchiveZip(bytes);
  } catch (error) {
    if (error instanceof ArchiveZipError) reject(error.reason);
    throw error;
  }
  if (entries.some(({ name }) => ACTIVE_CONTENT_EXTENSION.test(name))) reject("active_content");
  const known = new Set<string>(Object.values(ARCHIVE_ENTRIES));
  if (entries.some(({ name }) => !known.has(name))) reject("undeclared_entry");
  const entry = (name: string) => entries.find((candidate) => candidate.name === name);
  const read = (name: string, limit: number, declaredSize?: number) => {
    const found = entry(name);
    if (found === undefined) reject("missing_entry");
    if (found.size > limit) reject("size_limit");
    if (declaredSize !== undefined && found.size !== declaredSize) reject("declaration_mismatch");
    try {
      return found.read();
    } catch (error) {
      if (error instanceof ArchiveZipError) reject(error.reason);
      throw error;
    }
  };

  const manifestBytes = read(ARCHIVE_ENTRIES.manifest, ARCHIVE_ENTRY_LIMITS.manifest);
  const manifestJson = parseCanonicalJson(manifestBytes);
  assertFormatVersion(manifestJson, ARCHIVE_FORMAT);
  const manifest = parseWith(ArchiveManifestSchema, manifestJson);
  if (entry(ARCHIVE_ENTRIES.media) !== undefined && manifest.media === undefined)
    reject("undeclared_entry");

  const projectBytes = read(
    ARCHIVE_ENTRIES.project,
    ARCHIVE_ENTRY_LIMITS.project,
    manifest.project.byteSize,
  );
  if (sha256(projectBytes) !== manifest.project.sha256) reject("hash_mismatch");
  const projectJson = parseCanonicalJson(projectBytes);
  assertFormatVersion(projectJson, ARCHIVED_PROJECT_FORMAT);
  assertContractVersion(projectJson);
  const document = parseWith(ArchivedProjectSchema, projectJson);
  assertPortableDocument(document);
  try {
    assertValidProjectPayload(document);
  } catch {
    reject("invariant_invalid");
  }
  if (
    canonicalSerialize(archiveRequirementsFor(document)) !==
    canonicalSerialize(manifest.requirements)
  )
    reject("declaration_mismatch");

  const manifestHash = sha256(manifestBytes);
  if (manifest.media === undefined) return { document, manifestHash };
  const declaration = manifest.media;
  assertMediaDeclaration(document, declaration);
  const mediaBytes = read(ARCHIVE_ENTRIES.media, ARCHIVE_ENTRY_LIMITS.media, declaration.byteSize);
  const mediaHash = sha256(mediaBytes);
  if (mediaHash !== declaration.sha256) reject("hash_mismatch");
  const snapshot = snapshotFor(document, declaration);
  if (
    declaration.startSourceSample === 0 &&
    declaration.endSourceSample === snapshot.durationSamples &&
    mediaHash !== snapshot.canonicalAudioFingerprint
  )
    reject("hash_mismatch");
  return { document, manifestHash, media: { bytes: mediaBytes, declaration } };
}

function parseCanonicalJson(bytes: Buffer): unknown {
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    const value: unknown = JSON.parse(text);
    if (canonicalSerialize(value) === text) return value;
  } catch {
    return reject("schema_invalid");
  }
  return reject("schema_invalid");
}

function parseWith<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  return reject(
    parsed.error.issues.some(({ code }) => code === "custom")
      ? "reference_invalid"
      : "schema_invalid",
  );
}

function assertFormatVersion(value: unknown, format: string): void {
  const probe = VersionProbeSchema.safeParse(value);
  if (!probe.success || probe.data.format !== format) reject("schema_invalid");
  if (probe.data.formatVersion !== ARCHIVE_FORMAT_VERSION) reject("unsupported_version");
}

function assertContractVersion(value: unknown): void {
  const probe = EnvelopeVersionProbeSchema.safeParse(value);
  if (!probe.success) reject("schema_invalid");
  for (const version of [
    probe.data.envelope.schemaVersion,
    probe.data.envelope.payload.schemaVersion,
  ]) {
    const [major, minor] = version.split(".").map(Number);
    if (major !== CONTRACT_MAJOR || (minor ?? 0) > CONTRACT_MINOR) reject("unsupported_version");
  }
}

function assertPortableDocument(document: ArchivedProject): void {
  const { records } = document;
  if (
    records.sources.some(({ locators }) => locators.some(({ kind }) => kind === "local_file")) ||
    records.exportReceipts.some(
      ({ outputLocation }) => receiptDisplayName(outputLocation) !== outputLocation,
    )
  )
    reject("schema_invalid");
}

function snapshotFor(document: ArchivedProject, declaration: ArchiveMediaDeclaration) {
  const source = document.records.sources.find(({ id }) => id === declaration.sourceId);
  const snapshot = source?.snapshots.find(({ id }) => id === declaration.sourceSnapshotId);
  if (snapshot === undefined) return reject("reference_invalid");
  return snapshot;
}

function assertMediaDeclaration(
  document: ArchivedProject,
  declaration: ArchiveMediaDeclaration,
): void {
  const { projectRange } = document.records;
  const snapshot = snapshotFor(document, declaration);
  if (
    declaration.sourceId !== projectRange.sourceId ||
    declaration.startSourceSample !== projectRange.startSourceSample ||
    declaration.endSourceSample !== projectRange.endSourceSample ||
    declaration.endSourceSample > snapshot.durationSamples
  )
    reject("reference_invalid");
  if (
    declaration.sampleRate !== document.envelope.payload.sampleRate ||
    declaration.byteSize !== (declaration.endSourceSample - declaration.startSourceSample) * 2
  )
    reject("declaration_mismatch");
}

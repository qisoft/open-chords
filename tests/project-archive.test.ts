import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ProjectEnvelopeSchema } from "@open-chords/contracts";
import { canonicalSerialize } from "@open-chords/domain";
import { monoPcmWav } from "@open-chords/testkit/media";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LocalMediaService } from "../apps/desktop/src/main/local-media.ts";
import { openOfflineMediaCache } from "../apps/desktop/src/main/offline-media-cache.ts";
import {
  ArchivedProjectSchema,
  archivedProjectFor,
  ArchiveManifestSchema,
  writePortableProjectArchive,
  type ArchivedProject,
} from "../apps/desktop/src/main/project-archive-format.ts";
import { ProjectArchiveImports } from "../apps/desktop/src/main/project-archive-imports.ts";
import { readArchiveZip, writeArchiveZip } from "../apps/desktop/src/main/project-archive-zip.ts";
import { openProjectExports } from "../apps/desktop/src/main/project-exports.ts";
import {
  openProjectLibrary,
  type ProjectLibrary,
} from "../apps/desktop/src/main/project-library.ts";
import { rawZip, sha256, signedArchiveEntries } from "./support/archive-zip.ts";
import { goldenRecords } from "./support/editor-fixture.ts";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(prefix: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  roots.push(root);
  return root;
}

const goldenEnvelope = () =>
  ProjectEnvelopeSchema.parse(
    JSON.parse(readFileSync("packages/testkit/contracts/v1/valid/project-envelope.json", "utf8")),
  );

async function libraryWithGolden(root: string) {
  const library = await openProjectLibrary({ stateRoot: join(root, "state") });
  await library.createProject({ envelope: goldenEnvelope(), records: goldenRecords() });
  return library;
}

async function importerFor(root: string, archivePath: () => string, library?: ProjectLibrary) {
  const target = library ?? (await openProjectLibrary({ stateRoot: join(root, "state") }));
  const cache = await openOfflineMediaCache({ stateRoot: join(root, "state") });
  return {
    cache,
    imports: new ProjectArchiveImports({
      cache,
      library: target,
      pickArchive: async () => archivePath(),
    }),
    library: target,
  };
}

async function exportArchive(
  library: ProjectLibrary,
  root: string,
  options: { includeMedia?: boolean; media?: LocalMediaService; projectId?: string } = {},
) {
  const projectId = options.projectId ?? "project_golden";
  const target = join(root, `${projectId}-${String(Date.now())}.ocarchive`);
  const exports = await openProjectExports({
    library,
    ...(options.media ? { media: options.media } : {}),
    stateRoot: join(root, "state"),
    pickTarget: async (format) => (format === "project_archive" ? target : null),
  });
  const result = await exports.saveArchive({
    expectedProjectRevisionId: (await library.readProject(projectId)).projectRevisionId,
    includeMedia: options.includeMedia ?? false,
    projectId,
  });
  return { result, target };
}

function goldenDocument(): ArchivedProject {
  return archivedProjectFor({ envelope: goldenEnvelope(), records: goldenRecords() }).document;
}

describe("Portable Project Archive round trip", () => {
  it("round-trips complete retained history, practice, receipts and safe provenance", async () => {
    const origin = await temporaryRoot("oc-archive-origin-");
    const library = await libraryWithGolden(origin);
    const practiced = await library.changePractice({
      action: { speed: 0.75, type: "settings" },
      expectedProjectRevisionId: (await library.readProject("project_golden")).projectRevisionId,
      projectId: "project_golden",
    });
    expect(practiced).toHaveProperty("projectRevisionId");
    const jsonTarget = join(origin, "score.json");
    const exports = await openProjectExports({
      library,
      stateRoot: join(origin, "state"),
      pickTarget: async (format) =>
        format === "open_chords_json" ? jsonTarget : join(origin, "project.ocarchive"),
    });
    expect(
      await exports.saveJson({
        expectedProjectRevisionId: (await library.readProject("project_golden")).projectRevisionId,
        presentation: "current",
        projectId: "project_golden",
      }),
    ).toEqual({ state: "saved" });
    const before = await library.readProject("project_golden");
    expect(
      await exports.saveArchive({
        expectedProjectRevisionId: before.projectRevisionId,
        includeMedia: false,
        projectId: "project_golden",
      }),
    ).toEqual({ state: "saved" });

    const archiveBytes = await readFile(join(origin, "project.ocarchive"));
    const receipts = library.listExportReceipts("project_golden");
    expect(receipts.map(({ format }) => format)).toEqual(["open_chords_json", "project_archive"]);
    expect(receipts[1]).toMatchObject({
      omissions: ["local_source_locators_omitted", "receipt_locations_reduced_to_names"],
      outputHash: sha256(archiveBytes),
      profileVersion: "project_archive/1.0/no_media",
    });
    expect(archiveBytes.includes(Buffer.from(origin))).toBe(false);
    expect(archiveBytes.includes(Buffer.from("/unavailable/golden-fixture.wav"))).toBe(false);

    const destination = await temporaryRoot("oc-archive-destination-");
    const { imports, library: imported } = await importerFor(destination, () =>
      join(origin, "project.ocarchive"),
    );
    expect(await imports.importArchive()).toEqual({
      importedCopy: false,
      offlineMedia: "not_included",
      projectId: "project_golden",
      state: "imported",
    });
    const restored = await imported.readProject("project_golden");
    expect(restored.envelope).toEqual(before.envelope);
    expect(restored.envelope.payload.practice?.speed).toBe(0.75);
    expect(restored.envelope.payload.analysisRevisions.map(({ id }) => id)).toEqual([
      "revision_original",
      "revision_reviewable",
    ]);
    expect(restored.envelope.payload.editLayers).toEqual(before.envelope.payload.editLayers);
    expect(restored.envelope.payload.lyricsDocuments).toEqual(
      before.envelope.payload.lyricsDocuments,
    );
    expect(restored.records.exportReceipts).toEqual([
      { ...receipts[0]!, outputLocation: "score.json" },
    ]);
    expect(restored.records.sources[0]).toEqual({ ...goldenRecords().sources[0]!, locators: [] });
    expect(restored.records.projectRange).toEqual(before.records.projectRange);
  });

  it("writes deterministic bytes whose manifest hashes and declares every entry", () => {
    const first = writePortableProjectArchive({ document: goldenDocument() });
    const second = writePortableProjectArchive({ document: goldenDocument() });
    expect(first.archive.equals(second.archive)).toBe(true);
    expect(readArchiveZip(first.archive).map(({ name }) => name)).toEqual([
      "manifest.json",
      "project.json",
    ]);
    const manifest = readEntry(first.archive, "manifest.json");
    expect(sha256(manifest)).toBe(first.manifestHash);
    expect(JSON.parse(manifest.toString("utf8"))).toEqual({
      format: "open-chords/portable-project-archive",
      formatVersion: "1.0",
      project: {
        byteSize: readEntry(first.archive, "project.json").length,
        path: "project.json",
        sha256: first.projectHash,
      },
      requirements: [],
    });
  });

  it("declares exact external analysis requirements and rejects altered declarations", async () => {
    const document = goldenDocument();
    const component = { hash: `sha256:${"1".repeat(64)}`, id: "rhythm-model", version: "1.0.0" };
    const backend = { hash: `sha256:${"2".repeat(64)}`, id: "numpy", version: "2.4.2" };
    const manifestProject = withAnalysisManifest(document, component, backend);
    const archive = writePortableProjectArchive({ document: manifestProject });
    const manifest = ArchiveManifestSchema.parse(
      JSON.parse(readEntry(archive.archive, "manifest.json").toString("utf8")),
    );
    expect(manifest.requirements).toEqual([
      { id: "numpy", kind: "analysis_component", sha256: backend.hash, version: "2.4.2" },
      { id: "rhythm-model", kind: "analysis_component", sha256: component.hash, version: "1.0.0" },
    ]);
    const root = await temporaryRoot("oc-archive-requirements-");
    const accepted = join(root, "accepted.ocarchive");
    await writeFile(accepted, archive.archive);
    const { imports } = await importerFor(root, () => accepted);
    expect(await imports.importArchive()).toMatchObject({ state: "imported" });
    const altered = join(root, "altered.ocarchive");
    await writeFile(
      altered,
      rawZip(signedArchiveEntries(manifestProject, { requirements: [manifest.requirements[0]] })),
    );
    const second = await importerFor(
      await temporaryRoot("oc-archive-requirements-b-"),
      () => altered,
    );
    expect(await second.imports.importArchive()).toEqual({
      reason: "declaration_mismatch",
      state: "rejected",
    });
  });
});

describe("Portable Project Archive identity", () => {
  it("never overwrites or merges: duplicates converge, conflicts become Imported Project Copies", async () => {
    const root = await temporaryRoot("oc-archive-identity-");
    const library = await libraryWithGolden(root);
    const { result, target } = await exportArchive(library, root);
    expect(result).toEqual({ state: "saved" });
    const localHead = (await library.readProject("project_golden")).projectRevisionId;
    const { imports } = await importerFor(root, () => target, library);

    const first = await imports.importArchive();
    expect(first).toMatchObject({ importedCopy: true, state: "imported" });
    if (first.state !== "imported") throw new Error("Copy was not imported");
    expect(first.projectId).toMatch(/^project_[a-f0-9]{32}$/);
    const copy = await library.readProject(first.projectId);
    const manifestHash = sha256(readEntry(await readFile(target), "manifest.json"));
    expect(copy.envelope.payload.importOrigins).toEqual([
      { archiveManifestHash: manifestHash, projectId: "project_golden" },
    ]);
    expect(copy.envelope.payload.analysisRevisions.map(({ projectId }) => projectId)).toEqual([
      "project_golden",
      "project_golden",
    ]);
    expect((await library.readProject("project_golden")).projectRevisionId).toBe(localHead);
    expect(library.listExportReceipts("project_golden")).toHaveLength(1);

    expect(await imports.importArchive()).toEqual({ ...first, state: "already_present" });
    expect(library.listProjects()).toHaveLength(2);

    await library.changePractice({
      action: { speed: 1.25, type: "settings" },
      expectedProjectRevisionId: copy.projectRevisionId,
      projectId: first.projectId,
    });
    const second = await imports.importArchive();
    expect(second).toMatchObject({ importedCopy: true, state: "imported" });
    if (second.state !== "imported") throw new Error("Second copy was not imported");
    expect(second.projectId).not.toBe(first.projectId);
    expect((await library.readProject(first.projectId)).envelope.payload.practice?.speed).toBe(
      1.25,
    );
    expect(library.listProjects()).toHaveLength(3);
  });

  it("imports an identical history once and treats retries as already present", async () => {
    const origin = await temporaryRoot("oc-archive-duplicate-origin-");
    const { target } = await exportArchive(await libraryWithGolden(origin), origin);
    const destination = await temporaryRoot("oc-archive-duplicate-destination-");
    const { imports, library } = await importerFor(destination, () => target);
    expect(await imports.importArchive()).toMatchObject({ state: "imported", importedCopy: false });
    const head = (await library.readProject("project_golden")).projectRevisionId;
    expect(await imports.importArchive()).toMatchObject({
      importedCopy: false,
      projectId: "project_golden",
      state: "already_present",
    });
    expect((await library.readProject("project_golden")).projectRevisionId).toBe(head);
  });

  it("rejects an archive that redefines a Library Source Snapshot", async () => {
    const root = await temporaryRoot("oc-archive-source-conflict-");
    const library = await libraryWithGolden(root);
    const document = goldenDocument();
    document.envelope.payload.id = "project_other";
    for (const revision of document.envelope.payload.analysisRevisions)
      revision.projectId = "project_other";
    document.records.sources[0]!.snapshots[0]!.durationSamples = 96_000;
    const path = join(root, "conflict.ocarchive");
    await writeFile(path, rawZip(signedArchiveEntries(document)));
    const { imports } = await importerFor(root, () => path, library);
    expect(await imports.importArchive()).toEqual({ reason: "source_conflict", state: "rejected" });
    expect(library.listProjects().map(({ projectId }) => projectId)).toEqual(["project_golden"]);
  });
});

describe("Portable Project Archive media", () => {
  it("includes only the verified Project Range, which imports as verified Offline Media Cache", async () => {
    const origin = await temporaryRoot("oc-archive-media-origin-");
    const mediaPath = join(origin, "recording.wav");
    await writeFile(mediaPath, monoPcmWav([10, 20, 30, 40, 50, 60]));
    const library = await openProjectLibrary({ stateRoot: join(origin, "state") });
    const media = new LocalMediaService({ library, pickFile: async () => mediaPath });
    media.activateGeneration("generation_fixture");
    const selected = await media.pickLocalFile("generation_fixture");
    if (selected.kind !== "selected") throw new Error("Fixture selection was cancelled");
    const created = await media.createProject({
      capabilityId: selected.capabilityId,
      endSourceSample: 5,
      generationId: "generation_fixture",
      startSourceSample: 2,
    });
    const { result, target } = await exportArchive(library, origin, {
      includeMedia: true,
      media,
      projectId: created.projectId,
    });
    expect(result).toEqual({ state: "saved" });
    const archive = await readFile(target);
    expect(archive.includes(Buffer.from(mediaPath))).toBe(false);
    expect(library.listExportReceipts(created.projectId)[0]?.profileVersion).toBe(
      "project_archive/1.0/project_range_media",
    );

    const destination = await temporaryRoot("oc-archive-media-destination-");
    const { cache, imports, library: imported } = await importerFor(destination, () => target);
    expect(await imports.importArchive()).toEqual({
      importedCopy: false,
      offlineMedia: "cached",
      projectId: created.projectId,
      state: "imported",
    });
    const [entry] = await cache.list();
    const expected = Buffer.alloc(6);
    [30, 40, 50].forEach((sample, index) => expected.writeInt16LE(sample, index * 2));
    expect(entry).toMatchObject({
      byteSize: 6,
      range: { endSourceSample: 5, sourceId: created.sourceId, startSourceSample: 2 },
      sha256: sha256(expected),
    });
    expect(await cache.read(entry!.id)).toEqual(expected);
    const importedMedia = new LocalMediaService({ library: imported, pickFile: async () => null });
    importedMedia.activateGeneration("generation_fixture");
    expect(
      await importedMedia.openPlayback({
        generationId: "generation_fixture",
        projectId: created.projectId,
      }),
    ).toMatchObject({ kind: "unavailable", sourceId: created.sourceId });
    expect((await imported.readProject(created.projectId)).records.sources[0]?.locators).toEqual(
      [],
    );
  });

  it("refuses media inclusion when the Project Range cannot be verified", async () => {
    const root = await temporaryRoot("oc-archive-media-unavailable-");
    const library = await libraryWithGolden(root);
    const media = new LocalMediaService({ library, pickFile: async () => null });
    const { result, target } = await exportArchive(library, root, { includeMedia: true, media });
    expect(result).toEqual({ state: "media_unavailable" });
    await expect(readFile(target)).rejects.toMatchObject({ code: "ENOENT" });
    expect(library.listExportReceipts("project_golden")).toEqual([]);
  });

  it("rejects full-range media that does not match its Source Snapshot audio fingerprint", async () => {
    const root = await temporaryRoot("oc-archive-media-fingerprint-");
    const bytes = Buffer.alloc(96_000);
    const path = join(root, "media.ocarchive");
    await writeFile(
      path,
      rawZip(
        signedArchiveEntries(goldenDocument(), {
          media: {
            bytes,
            declaration: {
              channels: 1,
              encoding: "pcm_s16le",
              endSourceSample: 48_000,
              sampleRate: 48_000,
              sourceId: "source_fixture",
              sourceSnapshotId: "snapshot_fixture",
              startSourceSample: 0,
            },
          },
        }),
      ),
    );
    const { cache, imports, library } = await importerFor(root, () => path);
    expect(await imports.importArchive()).toEqual({ reason: "hash_mismatch", state: "rejected" });
    expect(library.listProjects()).toEqual([]);
    expect(await cache.list()).toEqual([]);
  });

  it("removes newly cached media when Library publication fails after validation", async () => {
    const root = await temporaryRoot("oc-archive-media-rollback-");
    const library = await libraryWithGolden(root);
    const document = goldenDocument();
    const fingerprint = `sha256:${"f".repeat(64)}`;
    document.envelope.payload.id = "project_foreign";
    for (const revision of document.envelope.payload.analysisRevisions)
      revision.projectId = "project_foreign";
    const source = document.records.sources[0]!;
    source.id = "source_foreign";
    source.identity = { fingerprint, kind: "local_file" };
    source.snapshots[0]!.byteFingerprint = fingerprint;
    source.snapshots[0]!.durationSamples = 96_000;
    document.records.projectRange.sourceId = "source_foreign";
    const path = join(root, "rollback.ocarchive");
    await writeFile(
      path,
      rawZip(
        signedArchiveEntries(document, {
          media: {
            bytes: Buffer.alloc(96_000, 1),
            declaration: {
              channels: 1,
              encoding: "pcm_s16le",
              endSourceSample: 48_000,
              sampleRate: 48_000,
              sourceId: "source_foreign",
              sourceSnapshotId: "snapshot_fixture",
              startSourceSample: 0,
            },
          },
        }),
      ),
    );
    const { cache, imports } = await importerFor(root, () => path, library);
    await expect(imports.importArchive()).rejects.toThrow(/Snapshot snapshot_fixture conflicts/);
    expect(await cache.list()).toEqual([]);
    expect(library.listProjects().map(({ projectId }) => projectId)).toEqual(["project_golden"]);
  });
});

describe("Portable Project Archive Source authority and migration", () => {
  it("uses the Library's Source record, so an archive cannot extend a known Source", async () => {
    const root = await temporaryRoot("oc-archive-source-extend-");
    const library = await libraryWithGolden(root);
    const document = goldenDocument();
    document.envelope.payload.id = "project_extending";
    for (const revision of document.envelope.payload.analysisRevisions)
      revision.projectId = "project_extending";
    const snapshot = document.records.sources[0]!.snapshots[0]!;
    document.records.sources[0]!.snapshots.push({ ...snapshot, id: "snapshot_injected" });
    const path = join(root, "extend.ocarchive");
    await writeFile(path, rawZip(signedArchiveEntries(document)));
    const { imports } = await importerFor(root, () => path, library);
    expect(await imports.importArchive()).toMatchObject({
      projectId: "project_extending",
      state: "imported",
    });
    const snapshotIds = (project: Awaited<ReturnType<ProjectLibrary["readProject"]>>) =>
      project.records.sources[0]!.snapshots.map(({ id }) => id);
    expect(snapshotIds(await library.readProject("project_extending"))).toEqual([
      "snapshot_fixture",
    ]);
    expect(library.getSourceById("source_fixture")?.snapshots.map(({ id }) => id)).toEqual([
      "snapshot_fixture",
    ]);
  });

  it("migrates an older supported contract and treats its retry as already present", async () => {
    const root = await temporaryRoot("oc-archive-older-minor-");
    const document = goldenDocument();
    document.envelope.schemaVersion = "1.3";
    document.envelope.payload.schemaVersion = "1.3";
    const path = join(root, "older.ocarchive");
    await writeFile(path, rawZip(signedArchiveEntries(document)));
    const { imports, library } = await importerFor(root, () => path);
    expect(await imports.importArchive()).toMatchObject({
      importedCopy: false,
      state: "imported",
    });
    expect((await library.readProject("project_golden")).envelope.schemaVersion).toBe("1.4");
    expect(await imports.importArchive()).toMatchObject({
      importedCopy: false,
      projectId: "project_golden",
      state: "already_present",
    });
    expect(library.listProjects()).toHaveLength(1);
  });

  it("stores highly compressible media so the reader accepts the writer's own archive", () => {
    const silence = Buffer.alloc(2 * 1024 * 1024);
    const archive = writeArchiveZip([{ bytes: silence, name: "media/project-range.pcm" }]);
    expect(archive.length).toBeGreaterThan(silence.length);
    expect(readArchiveZip(archive)[0]!.read().equals(silence)).toBe(true);
  });
});

function withAnalysisManifest(
  document: ArchivedProject,
  component: { hash: string; id: string; version: string },
  backend: { hash: string; id: string; version: string },
): ArchivedProject {
  const next = structuredClone(document);
  const revision = next.envelope.payload.analysisRevisions[0]!;
  const recipe = {
    capabilities: ["rhythm" as const],
    components: [component],
    numericalBackend: backend,
    pipeline: [
      "preflight" as const,
      "canonical_decode" as const,
      "shared_features" as const,
      "rhythm" as const,
      "assemble" as const,
      "main_validation" as const,
      "publish" as const,
    ],
    profile: {
      hash: `sha256:${"3".repeat(64)}`,
      id: "balanced",
      name: "balanced" as const,
      version: "1.0.0",
    },
    seeds: { rhythm: 7 },
    settings: { hopLength: 512 },
  };
  const manifest = {
    acceptedOutputHashes: {
      supportClaimIds: hashCanonical(revision.supportClaimIds),
      timeline: hashCanonical(revision.timeline),
    },
    candidateIdentity: {
      attemptId: "attempt_archive",
      canonicalAudioFingerprint: next.records.sources[0]!.snapshots[0]!.canonicalAudioFingerprint,
      jobKey: `sha256:${"a".repeat(64)}`,
      projectId: "project_golden",
      recipeHash: hashCanonical(recipe),
      sourceIdentityKind: "source_snapshot" as const,
      sourceSnapshotId: "snapshot_fixture",
    },
    format: "open-chords/analysis-manifest" as const,
    recipe,
    reproducibilityConditions: {
      componentHashes: [component.hash],
      numericalBackendHash: backend.hash,
      profileHash: recipe.profile.hash,
      seedsHash: hashCanonical(recipe.seeds),
      settingsHash: hashCanonical(recipe.settings),
    },
    stageOutcomes: [
      { stage: "preflight" as const, state: "completed" as const },
      { stage: "canonical_decode" as const, state: "completed" as const },
      { stage: "shared_features" as const, state: "completed" as const },
      { stage: "rhythm" as const, state: "completed" as const },
      { stage: "assemble" as const, state: "completed" as const },
    ],
    warnings: [],
  };
  const manifestHash = hashCanonical(manifest);
  const revisionId = `revision_${manifestHash.slice("sha256:".length)}`;
  const previousId = revision.id;
  revision.id = revisionId;
  revision.manifestHash = manifestHash;
  const serialized = canonicalSerialize(next).replaceAll(`"${previousId}"`, `"${revisionId}"`);
  const rewritten = ArchivedProjectSchema.parse(JSON.parse(serialized));
  rewritten.records.analysisManifests = [
    { analysisRevisionId: revisionId, hash: manifestHash, manifest },
  ];
  rewritten.records.legacyManifestlessAnalysisRevisionIds =
    rewritten.records.legacyManifestlessAnalysisRevisionIds.filter((id) => id !== revisionId);
  return rewritten;
}

function hashCanonical(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalSerialize(value)).digest("hex")}`;
}

function readEntry(archive: Buffer, name: string): Buffer {
  const entry = readArchiveZip(archive).find((candidate) => candidate.name === name);
  if (entry === undefined) throw new Error(`Archive entry ${name} is missing`);
  return entry.read();
}

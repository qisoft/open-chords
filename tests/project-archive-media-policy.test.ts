import { readFileSync } from "node:fs";
import { mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ProjectEnvelopeSchema } from "@open-chords/contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  OfflineMediaBlockedError,
  openOfflineMediaCache,
} from "../apps/desktop/src/main/offline-media-cache.ts";
import {
  archivedProjectFor,
  type ArchivedProject,
} from "../apps/desktop/src/main/project-archive-format.ts";
import { ProjectArchiveImports } from "../apps/desktop/src/main/project-archive-imports.ts";
import { openProjectLibrary } from "../apps/desktop/src/main/project-library.ts";
import { rawZip, sha256, signedArchiveEntries } from "./support/archive-zip.ts";
import { goldenRecords } from "./support/editor-fixture.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const envelope = () =>
  ProjectEnvelopeSchema.parse(
    JSON.parse(readFileSync("packages/testkit/contracts/v1/valid/project-envelope.json", "utf8")),
  );

function trimmedDocument(): ArchivedProject {
  const records = goldenRecords();
  records.sources[0]!.snapshots[0]!.durationSamples = 96_000;
  return archivedProjectFor({ envelope: envelope(), records }).document;
}

function fullRangeDocument(media: Buffer): ArchivedProject {
  const records = goldenRecords();
  records.sources[0]!.snapshots[0]!.canonicalAudioFingerprint = sha256(media);
  return archivedProjectFor({ envelope: envelope(), records }).document;
}

const rangeDeclaration = {
  channels: 1,
  encoding: "pcm_s16le",
  endSourceSample: 48_000,
  sampleRate: 48_000,
  sourceId: "source_fixture",
  sourceSnapshotId: "snapshot_fixture",
  startSourceSample: 0,
};

const withMedia = (document: ArchivedProject, bytes: Buffer) =>
  rawZip(signedArchiveEntries(document, { media: { bytes, declaration: rangeDeclaration } }));

async function harness(
  prefix: string,
  cacheOptions: Omit<Parameters<typeof openOfflineMediaCache>[0], "stateRoot"> = {},
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  roots.push(root);
  const stateRoot = join(root, "state");
  const library = await openProjectLibrary({ stateRoot });
  const cache = await openOfflineMediaCache({
    freeDiskBytes: async () => 64 * 1024 ** 3,
    ...cacheOptions,
    stateRoot,
  });
  const importFile = async (name: string, bytes: Buffer, adoptOfflineMedia: boolean) => {
    const path = join(root, name);
    await writeFile(path, bytes);
    return new ProjectArchiveImports({
      cache,
      library,
      pickArchive: async () => path,
    }).importArchive({ adoptOfflineMedia });
  };
  return { cache, importFile, library, stateRoot };
}

describe("Offline Media Cache adoption from archives", () => {
  it("adds nothing unless the user asks for included media", async () => {
    const { cache, importFile } = await harness("oc-media-opt-in-");
    expect(
      await importFile("a.ocarchive", withMedia(trimmedDocument(), Buffer.alloc(96_000, 1)), false),
    ).toMatchObject({
      offlineMedia: { state: "declined" },
      state: "imported",
    });
    expect(await cache.list()).toEqual([]);
  });

  it("never binds archive-attested partial-range bytes to a Source the Library already owns", async () => {
    const { cache, importFile } = await harness("oc-media-known-partial-");
    expect(
      await importFile("clean.ocarchive", rawZip(signedArchiveEntries(trimmedDocument())), true),
    ).toMatchObject({
      state: "imported",
    });
    expect(
      await importFile(
        "tampered.ocarchive",
        withMedia(trimmedDocument(), Buffer.alloc(96_000, 0x5a)),
        true,
      ),
    ).toEqual({
      importedCopy: false,
      offlineMedia: { reason: "unverifiable_for_known_source", state: "blocked" },
      projectId: "project_golden",
      state: "already_present",
    });
    expect(await cache.list()).toEqual([]);
  });

  it("labels media for a Source the archive introduces as archive-attested", async () => {
    const { cache, importFile } = await harness("oc-media-new-source-");
    const bytes = Buffer.alloc(96_000, 3);
    expect(
      await importFile("new.ocarchive", withMedia(trimmedDocument(), bytes), true),
    ).toMatchObject({
      offlineMedia: { state: "cached", verification: "archive_attested" },
    });
    expect(await cache.list()).toMatchObject([
      { sha256: sha256(bytes), verification: "archive_attested" },
    ]);
  });

  it("verifies full-range media against the Library's retained Snapshot fingerprint", async () => {
    const { cache, importFile } = await harness("oc-media-known-full-");
    const bytes = Buffer.alloc(96_000, 7);
    const document = fullRangeDocument(bytes);
    expect(
      await importFile("clean.ocarchive", rawZip(signedArchiveEntries(document)), true),
    ).toMatchObject({
      offlineMedia: { state: "not_included" },
      state: "imported",
    });
    expect(await importFile("media.ocarchive", withMedia(document, bytes), true)).toMatchObject({
      offlineMedia: { state: "cached", verification: "snapshot_fingerprint" },
      state: "already_present",
    });
    expect(await cache.list()).toMatchObject([{ verification: "snapshot_fingerprint" }]);
  });

  it("keeps an already-present Project import successful when the cache refuses its media", async () => {
    const { importFile, stateRoot } = await harness("oc-media-already-present-");
    expect(
      await importFile("a.ocarchive", withMedia(trimmedDocument(), Buffer.alloc(96_000, 1)), true),
    ).toMatchObject({
      offlineMedia: { state: "cached" },
      state: "imported",
    });
    expect(
      await importFile("b.ocarchive", withMedia(trimmedDocument(), Buffer.alloc(96_000, 2)), true),
    ).toMatchObject({
      offlineMedia: { state: "blocked" },
      state: "already_present",
    });
    expect(await readdir(join(stateRoot, "offline-media-cache"))).toHaveLength(2);
  });

  it("blocks entries that would exceed the capacity or the free-disk reserve", async () => {
    const full = await harness("oc-media-capacity-", { capacityBytes: 1024 });
    expect(
      await full.importFile(
        "a.ocarchive",
        withMedia(trimmedDocument(), Buffer.alloc(96_000, 1)),
        true,
      ),
    ).toMatchObject({
      offlineMedia: { reason: "capacity", state: "blocked" },
      state: "imported",
    });
    expect(await full.cache.list()).toEqual([]);
    const disk = await harness("oc-media-disk-", {
      freeDiskBytes: async () => 1024 ** 3 + 50_000,
      reserveBytes: 1024 ** 3,
    });
    expect(
      await disk.importFile(
        "a.ocarchive",
        withMedia(trimmedDocument(), Buffer.alloc(96_000, 1)),
        true,
      ),
    ).toMatchObject({
      offlineMedia: { reason: "disk_space", state: "blocked" },
      state: "imported",
    });
    expect(await disk.cache.list()).toEqual([]);
  });
});

describe("Offline Media Cache attestation", () => {
  const range = (bytes: Buffer) => ({
    canonicalAudioFingerprint: sha256(bytes),
    endSourceSample: bytes.length / 2,
    sampleRate: 48_000,
    sourceId: "source_fixture",
    sourceSnapshotId: "snapshot_fixture",
    startSourceSample: 0,
  });

  it("only labels bytes equal to the Snapshot fingerprint as verified", async () => {
    const { cache } = await harness("oc-media-label-");
    const bytes = Buffer.alloc(8, 1);
    await expect(
      cache.store({
        archiveManifestHash: sha256("manifest"),
        bytes: Buffer.alloc(8, 2),
        range: range(bytes),
        verification: "snapshot_fingerprint",
      }),
    ).rejects.toThrow(/Snapshot canonical audio/);
    expect(await cache.list()).toEqual([]);
  });

  it("lets verified bytes replace archive-attested bytes, but never the reverse", async () => {
    const { cache } = await harness("oc-media-upgrade-");
    const verified = Buffer.alloc(8, 1);
    const attested = await cache.store({
      archiveManifestHash: sha256("attested"),
      bytes: Buffer.alloc(8, 9),
      range: range(verified),
      verification: "archive_attested",
    });
    expect(attested.state).toBe("cached");
    expect(
      (
        await cache.store({
          archiveManifestHash: sha256("verified"),
          bytes: verified,
          range: range(verified),
          verification: "snapshot_fingerprint",
        })
      ).entry,
    ).toMatchObject({ sha256: sha256(verified), verification: "snapshot_fingerprint" });
    await expect(
      cache.store({
        archiveManifestHash: sha256("late"),
        bytes: Buffer.alloc(8, 5),
        range: range(verified),
        verification: "archive_attested",
      }),
    ).rejects.toBeInstanceOf(OfflineMediaBlockedError);
    expect(await cache.read(attested.entry.id)).toEqual(verified);
  });
});

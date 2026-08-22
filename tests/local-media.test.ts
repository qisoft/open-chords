import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { monoPcmWav } from "@open-chords/testkit/media";
import { afterEach, describe, expect, it } from "vitest";

import {
  handleLocalMediaRequest,
  isLocalMediaRequestUrl,
} from "../apps/desktop/src/main/local-media-protocol.ts";
import {
  LocalMediaService,
  nodeLocalMediaFileSystem,
} from "../apps/desktop/src/main/local-media.ts";
import { openProjectLibrary } from "../apps/desktop/src/main/project-library.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(path);
  return realpath(path);
}

function createMediaService(
  options: ConstructorParameters<typeof LocalMediaService>[0],
  generationIds: readonly string[] = ["generation_fixture"],
): LocalMediaService {
  const media = new LocalMediaService(options);
  for (const generationId of generationIds) media.activateGeneration(generationId);
  return media;
}

function controlledReadFileSystem(options: { failFirstClose?: boolean } = {}) {
  let blockReads = false;
  let closeCalls = 0;
  let confirmReadStarted: (() => void) | undefined;
  let releaseReads: (() => void) | undefined;
  let readsBlocked = Promise.resolve();
  return {
    block() {
      blockReads = true;
      const started = new Promise<void>((resolve) => {
        confirmReadStarted = resolve;
      });
      readsBlocked = new Promise<void>((resolve) => {
        releaseReads = resolve;
      });
      return started;
    },
    get closeCalls() {
      return closeCalls;
    },
    fileSystem: {
      ...nodeLocalMediaFileSystem,
      open: async (path: string, flags: number) => {
        const handle = await nodeLocalMediaFileSystem.open(path, flags);
        return {
          close: async () => {
            closeCalls += 1;
            if (options.failFirstClose === true && closeCalls === 1) {
              throw new Error("Fixture verification cleanup failed");
            }
            await handle.close();
          },
          read: async (buffer: Buffer, offset: number, length: number, position: number) => {
            if (blockReads) {
              confirmReadStarted?.();
              await readsBlocked;
            }
            return handle.read(buffer, offset, length, position);
          },
          stat: (statOptions: { bigint: true }) => handle.stat(statOptions),
        };
      },
    },
    release() {
      blockReads = false;
      releaseReads?.();
    },
  };
}

function failFirstHandleCloseFileSystem() {
  let closeAttempts = 0;
  let closedHandles = 0;
  return {
    get closeAttempts() {
      return closeAttempts;
    },
    get closedHandles() {
      return closedHandles;
    },
    fileSystem: {
      ...nodeLocalMediaFileSystem,
      open: async (path: string, flags: number) => {
        const handle = await nodeLocalMediaFileSystem.open(path, flags);
        let failedOnce = false;
        return {
          close: async () => {
            closeAttempts += 1;
            if (!failedOnce) {
              failedOnce = true;
              throw new Error("Fixture transient cleanup failed");
            }
            await handle.close();
            closedHandles += 1;
          },
          read: (buffer: Buffer, offset: number, length: number, position: number) =>
            handle.read(buffer, offset, length, position),
          stat: (options: { bigint: true }) => handle.stat(options),
        };
      },
    },
  };
}

describe("LocalMediaService", () => {
  it("routes media only through the exact hardened application origin", () => {
    const capabilityId = "playbackcapability_11111111111141118111111111111111";
    expect(isLocalMediaRequestUrl(`open-chords://app/media/${capabilityId}`)).toBe(true);
    expect(isLocalMediaRequestUrl(`open-chords://other/media/${capabilityId}`)).toBe(false);
    expect(isLocalMediaRequestUrl(`open-chords://app/media/%2e%2e/${capabilityId}`)).toBe(false);
  });

  it("replaces a generation's prior selection capability", async () => {
    const stateRoot = await temporaryDirectory("open-chords-local-media-capability-state-");
    const mediaRoot = await temporaryDirectory("open-chords-local-media-capability-source-");
    const mediaPath = join(mediaRoot, "recording.wav");
    await writeFile(mediaPath, monoPcmWav([0, 1, 2, 3]));
    const media = createMediaService({
      library: await openProjectLibrary({ stateRoot }),
      pickFile: async () => mediaPath,
    });

    const first = await media.pickLocalFile("generation_fixture");
    const second = await media.pickLocalFile("generation_fixture");
    if (first.kind !== "selected" || second.kind !== "selected") {
      throw new Error("Fixture selection was cancelled");
    }
    await expect(
      media.createProject({
        capabilityId: first.capabilityId,
        endSourceSample: 4,
        generationId: "generation_fixture",
        startSourceSample: 0,
      }),
    ).rejects.toThrow(/capability.*unavailable/i);
    await expect(
      media.createProject({
        capabilityId: second.capabilityId,
        endSourceSample: 4,
        generationId: "generation_fixture",
        startSourceSample: 0,
      }),
    ).resolves.toMatchObject({ projectId: expect.stringMatching(/^project_/) });
  });

  it("cannot publish a capability after its renderer generation is revoked", async () => {
    const stateRoot = await temporaryDirectory("open-chords-local-media-revoke-race-state-");
    const mediaRoot = await temporaryDirectory("open-chords-local-media-revoke-race-source-");
    const mediaPath = join(mediaRoot, "recording.wav");
    await writeFile(mediaPath, monoPcmWav([0, 1, 2, 3]));
    const controlled = controlledReadFileSystem({ failFirstClose: true });
    const verificationStarted = controlled.block();
    const media = createMediaService(
      {
        fileSystem: controlled.fileSystem,
        library: await openProjectLibrary({ stateRoot }),
        pickFile: async () => mediaPath,
      },
      ["generation_revoked"],
    );

    const selection = media.pickLocalFile("generation_revoked");
    await verificationStarted;
    const revocation = media.revokeGeneration("generation_revoked");
    controlled.release();
    await expect(selection).rejects.toThrow(/generation was revoked|capability is unavailable/i);
    await revocation;
    expect(controlled.closeCalls).toBe(2);
  });

  it("cannot publish a Project after revocation during selection revalidation", async () => {
    const stateRoot = await temporaryDirectory("open-chords-local-media-create-revoke-state-");
    const mediaRoot = await temporaryDirectory("open-chords-local-media-create-revoke-source-");
    const mediaPath = join(mediaRoot, "recording.wav");
    await writeFile(mediaPath, monoPcmWav([0, 1, 2, 3]));
    const controlled = controlledReadFileSystem();
    const library = await openProjectLibrary({ stateRoot });
    const media = createMediaService({
      fileSystem: controlled.fileSystem,
      library,
      pickFile: async () => mediaPath,
    });
    const selected = await media.pickLocalFile("generation_fixture");
    if (selected.kind !== "selected") throw new Error("Fixture selection was cancelled");

    const verificationStarted = controlled.block();
    const creation = media.createProject({
      capabilityId: selected.capabilityId,
      endSourceSample: 4,
      generationId: "generation_fixture",
      startSourceSample: 0,
    });
    await verificationStarted;
    const revocation = media.revokeGeneration("generation_fixture");
    controlled.release();

    await expect(creation).rejects.toThrow(/generation was revoked|capability is unavailable/i);
    await revocation;
    expect(library.listProjects()).toEqual([]);
  });

  it("cannot publish a matching Locator after revocation during relink verification", async () => {
    const stateRoot = await temporaryDirectory("open-chords-local-media-relink-revoke-state-");
    const mediaRoot = await temporaryDirectory("open-chords-local-media-relink-revoke-source-");
    const originalPath = join(mediaRoot, "original.wav");
    const movedPath = join(mediaRoot, "moved.wav");
    const original = monoPcmWav([0, 1, 2, 3]);
    await writeFile(originalPath, original);
    await writeFile(movedPath, original);
    const library = await openProjectLibrary({ stateRoot });
    const ingestion = createMediaService({ library, pickFile: async () => originalPath });
    const selected = await ingestion.pickLocalFile("generation_fixture");
    if (selected.kind !== "selected") throw new Error("Fixture selection was cancelled");
    const created = await ingestion.createProject({
      capabilityId: selected.capabilityId,
      endSourceSample: 4,
      generationId: "generation_fixture",
      startSourceSample: 0,
    });
    const controlled = controlledReadFileSystem();
    const relink = createMediaService({
      fileSystem: controlled.fileSystem,
      library,
      pickFile: async () => movedPath,
    });

    const verificationStarted = controlled.block();
    const relinking = relink.relinkSource({
      generationId: "generation_fixture",
      sourceId: created.sourceId,
    });
    await verificationStarted;
    const revocation = relink.revokeGeneration("generation_fixture");
    controlled.release();

    await expect(relinking).rejects.toThrow(/generation was revoked|capability is unavailable/i);
    await revocation;
    expect((await library.readProject(created.projectId)).records.sources[0]?.locators).toEqual([
      expect.objectContaining({ path: originalPath, status: "available" }),
    ]);
  });

  it("creates a durable immutable Project Range through an opaque native-picker capability", async () => {
    const stateRoot = await temporaryDirectory("open-chords-local-media-state-");
    const mediaRoot = await temporaryDirectory("open-chords-local-media-source-");
    const mediaPath = join(mediaRoot, "private recording.wav");
    await writeFile(mediaPath, monoPcmWav([0, 1000, -1000, 2000, -2000, 3000, -3000, 0]));
    const library = await openProjectLibrary({ stateRoot });
    const media = createMediaService({
      library,
      now: () => new Date("2026-08-21T12:00:00.000Z"),
      pickFile: async () => mediaPath,
    });

    const selected = await media.pickLocalFile("generation_fixture");
    expect(selected).toMatchObject({
      byteSize: 60,
      durationSamples: 8,
      kind: "selected",
      mimeType: "audio/wav",
      sampleRate: 48_000,
    });
    expect(JSON.stringify(selected)).not.toContain(mediaPath);
    if (selected.kind !== "selected") throw new Error("Fixture selection was cancelled");

    const created = await media.createProject({
      capabilityId: selected.capabilityId,
      endSourceSample: 7,
      generationId: "generation_fixture",
      startSourceSample: 2,
    });

    expect(JSON.stringify(created)).not.toContain(mediaPath);
    const stored = await library.readProject(created.projectId);
    expect(stored.records.projectRange).toEqual({
      endSourceSample: 7,
      sourceId: created.sourceId,
      startSourceSample: 2,
    });
    expect(stored.envelope.payload).toMatchObject({
      activeView: null,
      analysisRevisions: [],
      durationSamples: 5,
      editLayers: [],
      id: created.projectId,
      sampleRate: 48_000,
    });
    expect(stored.records.sources[0]).toMatchObject({
      id: created.sourceId,
      identity: { kind: "local_file" },
      locators: [{ kind: "local_file", path: mediaPath, status: "available" }],
      snapshots: [
        {
          byteSize: 60,
          durationSamples: 8,
          selectedFormat: {
            audioCodec: "pcm_s16le",
            container: "wav",
            mimeType: "audio/wav",
          },
        },
      ],
    });
  }, 15_000);

  it("rejects spoofed media before issuing a capability", async () => {
    const stateRoot = await temporaryDirectory("open-chords-local-media-hostile-state-");
    const mediaRoot = await temporaryDirectory("open-chords-local-media-hostile-source-");
    const spoofedPath = join(mediaRoot, "spoofed.wav");
    await writeFile(spoofedPath, Buffer.from("not audio despite its extension"));
    const library = await openProjectLibrary({ stateRoot });

    await expect(
      createMediaService({ library, pickFile: async () => spoofedPath }).pickLocalFile(
        "generation_fixture",
      ),
    ).rejects.toThrow(/supported media/i);
    expect(library.listProjects()).toEqual([]);
  });

  it("retains a failed verification close for lifecycle cleanup", async () => {
    const stateRoot = await temporaryDirectory("open-chords-local-media-probe-cleanup-state-");
    const mediaRoot = await temporaryDirectory("open-chords-local-media-probe-cleanup-source-");
    const spoofedPath = join(mediaRoot, "spoofed.wav");
    await writeFile(spoofedPath, Buffer.from("not audio despite its extension"));
    const cleanup = failFirstHandleCloseFileSystem();
    const media = createMediaService({
      fileSystem: cleanup.fileSystem,
      library: await openProjectLibrary({ stateRoot }),
      pickFile: async () => spoofedPath,
    });

    await expect(media.pickLocalFile("generation_fixture")).rejects.toThrow(/supported media/i);
    expect(cleanup.closeAttempts).toBe(1);
    expect(cleanup.closedHandles).toBe(0);
    await media.revokeGeneration("generation_fixture");
    expect(cleanup.closeAttempts).toBe(2);
    expect(cleanup.closedHandles).toBe(1);
  });

  it.runIf(process.platform !== "win32")("rejects a directly selected symbolic link", async () => {
    const stateRoot = await temporaryDirectory("open-chords-local-media-symlink-state-");
    const mediaRoot = await temporaryDirectory("open-chords-local-media-symlink-source-");
    const targetPath = join(mediaRoot, "target.wav");
    const symlinkPath = join(mediaRoot, "alias.wav");
    await writeFile(targetPath, monoPcmWav([0, 1, -1, 0]));
    await symlink(targetPath, symlinkPath);
    const library = await openProjectLibrary({ stateRoot });

    await expect(
      createMediaService({ library, pickFile: async () => symlinkPath }).pickLocalFile(
        "generation_fixture",
      ),
    ).rejects.toThrow(/symbolic link|junction/i);
    expect(library.listProjects()).toEqual([]);
  });

  it("rejects media reached through a symlinked directory or Windows junction", async () => {
    const stateRoot = await temporaryDirectory("open-chords-local-media-link-state-");
    const mediaRoot = await temporaryDirectory("open-chords-local-media-link-source-");
    const targetRoot = join(mediaRoot, "target");
    const linkedRoot = join(mediaRoot, "linked");
    await mkdir(targetRoot);
    await writeFile(join(targetRoot, "recording.wav"), monoPcmWav([0, 1, -1, 0]));
    await symlink(targetRoot, linkedRoot, process.platform === "win32" ? "junction" : "dir");
    const library = await openProjectLibrary({ stateRoot });

    await expect(
      createMediaService({
        library,
        pickFile: async () => join(linkedRoot, "recording.wav"),
      }).pickLocalFile("generation_fixture"),
    ).rejects.toThrow(/symbolic link|junction/i);
    expect(library.listProjects()).toEqual([]);
  });

  it("aborts when a verified parent is replaced by a symlink or junction before open", async () => {
    const stateRoot = await temporaryDirectory("open-chords-local-media-parent-race-state-");
    const mediaRoot = await temporaryDirectory("open-chords-local-media-parent-race-source-");
    const selectedRoot = join(mediaRoot, "selected");
    const displacedRoot = join(mediaRoot, "selected-before-swap");
    const replacementRoot = join(mediaRoot, "replacement");
    const mediaPath = join(selectedRoot, "recording.wav");
    await mkdir(selectedRoot);
    await mkdir(replacementRoot);
    await writeFile(mediaPath, monoPcmWav([0, 1, 2, 3]));
    await writeFile(join(replacementRoot, "recording.wav"), monoPcmWav([4, 5, 6, 7]));
    const library = await openProjectLibrary({ stateRoot });
    let selectedRootChecks = 0;
    const media = createMediaService({
      fileSystem: {
        ...nodeLocalMediaFileSystem,
        lstat: async (path) => {
          if (path === selectedRoot && (selectedRootChecks += 1) === 2) {
            await rename(selectedRoot, displacedRoot);
            await symlink(
              replacementRoot,
              selectedRoot,
              process.platform === "win32" ? "junction" : "dir",
            );
          }
          return nodeLocalMediaFileSystem.lstat(path);
        },
      },
      library,
      pickFile: async () => mediaPath,
    });

    await expect(media.pickLocalFile("generation_fixture")).rejects.toThrow(
      /ancestor|symbolic link|junction/i,
    );
    expect(library.listProjects()).toEqual([]);
  });

  it("aborts a concurrent path replacement without publishing a Project", async () => {
    const stateRoot = await temporaryDirectory("open-chords-local-media-race-state-");
    const mediaRoot = await temporaryDirectory("open-chords-local-media-race-source-");
    const mediaPath = join(mediaRoot, "recording.wav");
    const displacedPath = join(mediaRoot, "recording-before-swap.wav");
    await writeFile(mediaPath, monoPcmWav([0, 1, 2, 3]));
    const library = await openProjectLibrary({ stateRoot });
    let mediaPathChecks = 0;
    const media = createMediaService({
      fileSystem: {
        ...nodeLocalMediaFileSystem,
        lstat: async (path) => {
          if (path === mediaPath && (mediaPathChecks += 1) === 2) {
            await rename(mediaPath, displacedPath);
            await writeFile(mediaPath, monoPcmWav([4, 5, 6, 7]));
          }
          return nodeLocalMediaFileSystem.lstat(path);
        },
      },
      library,
      pickFile: async () => mediaPath,
    });

    await expect(media.pickLocalFile("generation_fixture")).rejects.toThrow(/changed/i);
    expect(library.listProjects()).toEqual([]);
  });

  it("revalidates a selection capability before publishing its Project", async () => {
    const stateRoot = await temporaryDirectory("open-chords-local-media-stale-state-");
    const mediaRoot = await temporaryDirectory("open-chords-local-media-stale-source-");
    const mediaPath = join(mediaRoot, "recording.wav");
    const displacedPath = join(mediaRoot, "selected-recording.wav");
    await writeFile(mediaPath, monoPcmWav([0, 1, 2, 3]));
    const library = await openProjectLibrary({ stateRoot });
    const media = createMediaService({ library, pickFile: async () => mediaPath });
    const selected = await media.pickLocalFile("generation_fixture");
    if (selected.kind !== "selected") throw new Error("Fixture selection was cancelled");
    await rename(mediaPath, displacedPath);
    await writeFile(mediaPath, monoPcmWav([4, 5, 6, 7]));

    await expect(
      media.createProject({
        capabilityId: selected.capabilityId,
        endSourceSample: 4,
        generationId: "generation_fixture",
        startSourceSample: 0,
      }),
    ).rejects.toThrow(/changed/i);
    expect(library.listProjects()).toEqual([]);
  });

  it("rejects Project Range abuse and a capability from another renderer generation", async () => {
    const stateRoot = await temporaryDirectory("open-chords-local-media-range-state-");
    const mediaRoot = await temporaryDirectory("open-chords-local-media-range-source-");
    const mediaPath = join(mediaRoot, "recording.wav");
    await writeFile(mediaPath, monoPcmWav([0, 1, 2, 3]));
    const library = await openProjectLibrary({ stateRoot });
    const media = createMediaService({ library, pickFile: async () => mediaPath });
    const selected = await media.pickLocalFile("generation_fixture");
    if (selected.kind !== "selected") throw new Error("Fixture selection was cancelled");

    await expect(
      media.createProject({
        capabilityId: selected.capabilityId,
        endSourceSample: 5,
        generationId: "generation_fixture",
        startSourceSample: 0,
      }),
    ).rejects.toThrow(/outside verified media/i);
    await expect(
      media.createProject({
        capabilityId: selected.capabilityId,
        endSourceSample: 4,
        generationId: "generation_hostile",
        startSourceSample: 0,
      }),
    ).rejects.toThrow(/unavailable/i);
    expect(library.listProjects()).toEqual([]);
  });

  it("relinks only matching content and routes a mismatch into a new-Source capability", async () => {
    const stateRoot = await temporaryDirectory("open-chords-local-media-relink-state-");
    const mediaRoot = await temporaryDirectory("open-chords-local-media-relink-source-");
    const originalPath = join(mediaRoot, "original.wav");
    const movedPath = join(mediaRoot, "moved.wav");
    const differentPath = join(mediaRoot, "different.wav");
    const original = monoPcmWav([0, 100, -100, 0]);
    await writeFile(originalPath, original);
    await writeFile(movedPath, original);
    await writeFile(differentPath, monoPcmWav([0, 200, -200, 0]));
    const library = await openProjectLibrary({ stateRoot });
    const createMedia = createMediaService({ library, pickFile: async () => originalPath });
    const selected = await createMedia.pickLocalFile("generation_fixture");
    if (selected.kind !== "selected") throw new Error("Fixture selection was cancelled");
    const created = await createMedia.createProject({
      capabilityId: selected.capabilityId,
      endSourceSample: 4,
      generationId: "generation_fixture",
      startSourceSample: 0,
    });

    const matching = await createMediaService({
      library,
      pickFile: async () => movedPath,
    }).relinkSource({ generationId: "generation_fixture", sourceId: created.sourceId });
    expect(matching).toEqual({ kind: "relinked", sourceId: created.sourceId });
    expect(JSON.stringify(matching)).not.toContain(movedPath);
    expect((await library.readProject(created.projectId)).records.sources[0]?.locators).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: originalPath, status: "available" }),
        expect.objectContaining({ path: movedPath, status: "available" }),
      ]),
    );
    const reopenedAfterRelink = await openProjectLibrary({ stateRoot });
    expect(
      (await reopenedAfterRelink.readProject(created.projectId)).records.sources[0]?.locators,
    ).toEqual(expect.arrayContaining([expect.objectContaining({ path: movedPath })]));

    const mismatchMedia = createMediaService({
      library,
      pickFile: async () => differentPath,
    });
    const mismatch = await mismatchMedia.relinkSource({
      generationId: "generation_fixture",
      sourceId: created.sourceId,
    });
    expect(mismatch).toMatchObject({ kind: "different_source" });
    expect(JSON.stringify(mismatch)).not.toContain(differentPath);
    if (mismatch.kind !== "different_source") throw new Error("Expected a new-Source capability");
    const second = await mismatchMedia.createProject({
      capabilityId: mismatch.capabilityId,
      endSourceSample: 4,
      generationId: "generation_fixture",
      startSourceSample: 0,
    });
    expect(second.sourceId).not.toBe(created.sourceId);
    expect((await library.readProject(created.projectId)).records.sources[0]?.identity).toEqual({
      fingerprint: expect.any(String),
      kind: "local_file",
    });
  });

  it("reports committed create and relink results while retrying transient handle cleanup", async () => {
    const stateRoot = await temporaryDirectory("open-chords-local-media-transient-cleanup-state-");
    const mediaRoot = await temporaryDirectory("open-chords-local-media-transient-cleanup-source-");
    const mediaPath = join(mediaRoot, "recording.wav");
    const movedPath = join(mediaRoot, "moved.wav");
    const wav = monoPcmWav([0, 1, 2, 3]);
    await writeFile(mediaPath, wav);
    await writeFile(movedPath, wav);
    const library = await openProjectLibrary({ stateRoot });
    const createCleanup = failFirstHandleCloseFileSystem();
    const media = createMediaService({
      fileSystem: createCleanup.fileSystem,
      library,
      pickFile: async () => mediaPath,
    });
    const selected = await media.pickLocalFile("generation_fixture");
    if (selected.kind !== "selected") throw new Error("Fixture selection was cancelled");
    const created = await media.createProject({
      capabilityId: selected.capabilityId,
      endSourceSample: 4,
      generationId: "generation_fixture",
      startSourceSample: 0,
    });
    expect(library.listProjects()).toEqual([
      expect.objectContaining({ projectId: created.projectId, status: "active" }),
    ]);
    expect(createCleanup.closeAttempts).toBe(2);
    expect(createCleanup.closedHandles).toBe(0);
    await media.revokeGeneration("generation_fixture");
    expect(createCleanup.closeAttempts).toBe(4);
    expect(createCleanup.closedHandles).toBe(2);

    const relinkCleanup = failFirstHandleCloseFileSystem();
    const relink = createMediaService({
      fileSystem: relinkCleanup.fileSystem,
      library,
      pickFile: async () => movedPath,
    });
    await expect(
      relink.relinkSource({
        generationId: "generation_fixture",
        sourceId: created.sourceId,
      }),
    ).resolves.toEqual({ kind: "relinked", sourceId: created.sourceId });
    expect(relinkCleanup.closeAttempts).toBe(1);
    expect(relinkCleanup.closedHandles).toBe(0);
    await relink.revokeGeneration("generation_fixture");
    expect(relinkCleanup.closeAttempts).toBe(2);
    expect(relinkCleanup.closedHandles).toBe(1);
  });

  it("reopens offline playback through bounded read-only byte ranges without exposing a path", async () => {
    const stateRoot = await temporaryDirectory("open-chords-local-media-playback-state-");
    const mediaRoot = await temporaryDirectory("open-chords-local-media-playback-source-");
    const mediaPath = join(mediaRoot, "recording.wav");
    await writeFile(mediaPath, monoPcmWav([0, 100, -100, 200, -200, 0]));
    const library = await openProjectLibrary({ stateRoot });
    const ingestion = createMediaService({ library, pickFile: async () => mediaPath });
    const selected = await ingestion.pickLocalFile("generation_fixture");
    if (selected.kind !== "selected") throw new Error("Fixture selection was cancelled");
    const created = await ingestion.createProject({
      capabilityId: selected.capabilityId,
      endSourceSample: 5,
      generationId: "generation_fixture",
      startSourceSample: 1,
    });

    const reopenedLibrary = await openProjectLibrary({ stateRoot });
    const playback = createMediaService(
      {
        library: reopenedLibrary,
        pickFile: async () => null,
      },
      ["generation_reopened", "generation_replacement_probe"],
    );
    const opened = await playback.openPlayback({
      generationId: "generation_reopened",
      projectId: created.projectId,
    });
    expect(opened).toMatchObject({
      endSourceSample: 5,
      kind: "ready",
      mimeType: "audio/wav",
      startSourceSample: 1,
    });
    expect(JSON.stringify(opened)).not.toContain(mediaPath);
    if (opened.kind !== "ready") throw new Error("Fixture Source was unavailable");
    expect(new URL(opened.playbackUrl)).toMatchObject({
      host: "app",
      pathname: expect.stringMatching(/^\/media\/playbackcapability_/),
      protocol: "open-chords:",
    });
    const range = await playback.readPlaybackRange({
      capabilityId: opened.capabilityId,
      endByteExclusive: 12,
      startByte: 0,
    });
    expect(range.bytes.toString("ascii")).toBe("RIFF0\u0000\u0000\u0000WAVE");
    expect(range).toMatchObject({ byteSize: 56, endByteExclusive: 12, startByte: 0 });
    await expect(
      playback.readPlaybackRange({
        capabilityId: opened.capabilityId,
        endByteExclusive: 57,
        startByte: 0,
      }),
    ).rejects.toThrow(/range/i);

    const response = await handleLocalMediaRequest(
      playback,
      new Request(opened.playbackUrl, { headers: { Range: "bytes=0-11" } }),
    );
    expect(response.status).toBe(206);
    expect(response.headers.get("Accept-Ranges")).toBe("bytes");
    expect(response.headers.get("Content-Range")).toBe("bytes 0-11/56");
    expect(Buffer.from(await response.arrayBuffer()).toString("ascii")).toBe(
      "RIFF0\u0000\u0000\u0000WAVE",
    );
    const openEnded = await handleLocalMediaRequest(
      playback,
      new Request(opened.playbackUrl, { headers: { Range: "bytes=44-" } }),
    );
    expect(openEnded.status).toBe(206);
    expect(openEnded.headers.get("Content-Range")).toBe("bytes 44-55/56");
    expect((await openEnded.arrayBuffer()).byteLength).toBe(12);
    expect(
      (
        await handleLocalMediaRequest(
          playback,
          new Request(opened.playbackUrl, { headers: { Range: "bytes=0-1,4-5" } }),
        )
      ).status,
    ).toBe(416);

    const replacement = await playback.openPlayback({
      generationId: "generation_reopened",
      projectId: created.projectId,
    });
    if (replacement.kind !== "ready") {
      throw new Error("Fixture Source was unavailable before capability replacement");
    }
    await expect(
      playback.readPlaybackRange({
        capabilityId: opened.capabilityId,
        endByteExclusive: 12,
        startByte: 0,
      }),
    ).rejects.toThrow(/unavailable/i);
    await expect(
      playback.readPlaybackRange({
        capabilityId: replacement.capabilityId,
        endByteExclusive: 12,
        startByte: 0,
      }),
    ).resolves.toMatchObject({ endByteExclusive: 12, startByte: 0 });

    await playback.revokeGeneration("generation_reopened");
    await expect(
      playback.readPlaybackRange({
        capabilityId: replacement.capabilityId,
        endByteExclusive: 12,
        startByte: 0,
      }),
    ).rejects.toThrow(/unavailable/i);
    const reopenedCapability = await playback.openPlayback({
      generationId: "generation_replacement_probe",
      projectId: created.projectId,
    });
    if (reopenedCapability.kind !== "ready") {
      throw new Error("Fixture Source was unavailable before replacement probe");
    }

    await rename(mediaPath, `${mediaPath}.displaced`);
    await writeFile(mediaPath, monoPcmWav([9, 9, 9, 9, 9, 9]));
    await expect(
      playback.readPlaybackRange({
        capabilityId: reopenedCapability.capabilityId,
        endByteExclusive: 12,
        startByte: 0,
      }),
    ).rejects.toThrow(/changed/i);
    await playback.revokeGeneration("generation_replacement_probe");
  });

  it("bounds concurrent playback range reads", async () => {
    const stateRoot = await temporaryDirectory("open-chords-local-media-range-limit-state-");
    const mediaRoot = await temporaryDirectory("open-chords-local-media-range-limit-source-");
    const mediaPath = join(mediaRoot, "recording.wav");
    await writeFile(mediaPath, monoPcmWav([0, 1, 2, 3]));
    const library = await openProjectLibrary({ stateRoot });
    let blockReads = false;
    let blockedReads = 0;
    let releaseReads!: () => void;
    const readsBlocked = new Promise<void>((resolve) => {
      releaseReads = resolve;
    });
    let confirmLimitReached!: () => void;
    const limitReached = new Promise<void>((resolve) => {
      confirmLimitReached = resolve;
    });
    const fileSystem = {
      ...nodeLocalMediaFileSystem,
      open: async (path: string, flags: number) => {
        const handle = await nodeLocalMediaFileSystem.open(path, flags);
        return {
          close: () => handle.close(),
          read: async (buffer: Buffer, offset: number, length: number, position: number) => {
            if (blockReads) {
              blockedReads += 1;
              if (blockedReads === 8) confirmLimitReached();
              await readsBlocked;
            }
            return handle.read(buffer, offset, length, position);
          },
          stat: (options: { bigint: true }) => handle.stat(options),
        };
      },
    };
    const media = createMediaService({ library, fileSystem, pickFile: async () => mediaPath });
    const selected = await media.pickLocalFile("generation_fixture");
    if (selected.kind !== "selected") throw new Error("Fixture selection was cancelled");
    const created = await media.createProject({
      capabilityId: selected.capabilityId,
      endSourceSample: 4,
      generationId: "generation_fixture",
      startSourceSample: 0,
    });
    const playback = await media.openPlayback({
      generationId: "generation_fixture",
      projectId: created.projectId,
    });
    if (playback.kind !== "ready") throw new Error("Fixture Source was unavailable");

    blockReads = true;
    const activeReads = Array.from({ length: 8 }, () =>
      media.readPlaybackRange({
        capabilityId: playback.capabilityId,
        endByteExclusive: 12,
        startByte: 0,
      }),
    );
    await limitReached;
    await expect(
      media.readPlaybackRange({
        capabilityId: playback.capabilityId,
        endByteExclusive: 12,
        startByte: 0,
      }),
    ).rejects.toThrow(/too many local media reads/i);
    releaseReads();
    await expect(Promise.all(activeReads)).resolves.toHaveLength(8);
    await media.revokeGeneration("generation_fixture");
  });

  it("does not invalidate a verified Locator when playback capability cleanup fails", async () => {
    const stateRoot = await temporaryDirectory("open-chords-local-media-cleanup-state-");
    const mediaRoot = await temporaryDirectory("open-chords-local-media-cleanup-source-");
    const mediaPath = join(mediaRoot, "recording.wav");
    await writeFile(mediaPath, monoPcmWav([0, 1, 2, 3]));
    const library = await openProjectLibrary({ stateRoot });
    const ingestion = createMediaService({ library, pickFile: async () => mediaPath });
    const selected = await ingestion.pickLocalFile("generation_fixture");
    if (selected.kind !== "selected") throw new Error("Fixture selection was cancelled");
    const created = await ingestion.createProject({
      capabilityId: selected.capabilityId,
      endSourceSample: 4,
      generationId: "generation_fixture",
      startSourceSample: 0,
    });

    let firstHandleClosed = false;
    let firstHandleCloseAttempts = 0;
    let confirmFirstCloseStarted!: () => void;
    let releaseFirstClose!: () => void;
    let openedHandles = 0;
    const firstCloseStarted = new Promise<void>((resolve) => {
      confirmFirstCloseStarted = resolve;
    });
    const firstCloseReleased = new Promise<void>((resolve) => {
      releaseFirstClose = resolve;
    });
    const playback = createMediaService({
      fileSystem: {
        ...nodeLocalMediaFileSystem,
        open: async (path, flags) => {
          const handle = await nodeLocalMediaFileSystem.open(path, flags);
          openedHandles += 1;
          const handleNumber = openedHandles;
          return {
            close: async () => {
              if (handleNumber === 1) {
                firstHandleCloseAttempts += 1;
                if (firstHandleCloseAttempts === 1) {
                  confirmFirstCloseStarted();
                  await firstCloseReleased;
                  throw new Error("Fixture capability cleanup failed");
                }
              }
              await handle.close();
              if (handleNumber === 1) firstHandleClosed = true;
            },
            read: (buffer, offset, length, position) =>
              handle.read(buffer, offset, length, position),
            stat: (options) => handle.stat(options),
          };
        },
      },
      library,
      pickFile: async () => null,
    });
    await expect(
      playback.openPlayback({
        generationId: "generation_fixture",
        projectId: created.projectId,
      }),
    ).resolves.toMatchObject({ kind: "ready" });
    const replacement = playback.openPlayback({
      generationId: "generation_fixture",
      projectId: created.projectId,
    });
    await firstCloseStarted;
    expect(firstHandleClosed).toBe(false);
    const revocation = playback.revokeGeneration("generation_fixture");
    releaseFirstClose();
    await expect(replacement).rejects.toThrow("Fixture capability cleanup failed");

    expect((await library.readProject(created.projectId)).records.sources[0]?.locators).toEqual([
      expect.objectContaining({ path: mediaPath, status: "available" }),
    ]);
    await revocation;
    expect(firstHandleCloseAttempts).toBe(2);
    expect(firstHandleClosed).toBe(true);
  });

  it("reads only through its retained handle during a transient ancestor link swap", async () => {
    const stateRoot = await temporaryDirectory("open-chords-local-media-playback-link-state-");
    const mediaRoot = await temporaryDirectory("open-chords-local-media-playback-link-source-");
    const selectedRoot = join(mediaRoot, "selected");
    const displacedRoot = join(mediaRoot, "selected-before-link");
    const mediaPath = join(selectedRoot, "recording.wav");
    await mkdir(selectedRoot);
    await writeFile(mediaPath, monoPcmWav([0, 1, 2, 3]));
    const library = await openProjectLibrary({ stateRoot });
    let openCalls = 0;
    let swapOnRead = false;
    let transientSwapCompleted = false;
    let windowsRenameBlocked = false;
    const media = createMediaService({
      fileSystem: {
        ...nodeLocalMediaFileSystem,
        open: async (path, flags) => {
          openCalls += 1;
          const handle = await nodeLocalMediaFileSystem.open(path, flags);
          return {
            close: () => handle.close(),
            read: async (buffer, offset, length, position) => {
              if (!swapOnRead) return handle.read(buffer, offset, length, position);
              swapOnRead = false;
              try {
                await rename(selectedRoot, displacedRoot);
              } catch (error) {
                const code =
                  typeof error === "object" && error !== null && "code" in error
                    ? error.code
                    : null;
                if (process.platform !== "win32" || code !== "EPERM") throw error;
                windowsRenameBlocked = true;
                return handle.read(buffer, offset, length, position);
              }
              await symlink(
                displacedRoot,
                selectedRoot,
                process.platform === "win32" ? "junction" : "dir",
              );
              try {
                return await handle.read(buffer, offset, length, position);
              } finally {
                await rm(selectedRoot, { force: true, recursive: true });
                await rename(displacedRoot, selectedRoot);
                transientSwapCompleted = true;
              }
            },
            stat: (options) => handle.stat(options),
          };
        },
      },
      library,
      pickFile: async () => mediaPath,
    });
    const selected = await media.pickLocalFile("generation_fixture");
    if (selected.kind !== "selected") throw new Error("Fixture selection was cancelled");
    const created = await media.createProject({
      capabilityId: selected.capabilityId,
      endSourceSample: 4,
      generationId: "generation_fixture",
      startSourceSample: 0,
    });
    const playback = await media.openPlayback({
      generationId: "generation_fixture",
      projectId: created.projectId,
    });
    if (playback.kind !== "ready") throw new Error("Fixture Source was unavailable");

    const opensBeforePlaybackRead = openCalls;
    swapOnRead = true;
    const range = await media.readPlaybackRange({
      capabilityId: playback.capabilityId,
      endByteExclusive: 12,
      startByte: 0,
    });
    expect(range.bytes.toString("ascii")).toBe("RIFF,\u0000\u0000\u0000WAVE");
    expect(openCalls).toBe(opensBeforePlaybackRead);
    expect(windowsRenameBlocked || transientSwapCompleted).toBe(true);
    expect(await realpath(mediaPath)).toBe(mediaPath);
    await media.revokeGeneration("generation_fixture");
  });

  it("gives a cache adapter only an immutable Project Range and range-bounded PCM reader", async () => {
    const stateRoot = await temporaryDirectory("open-chords-local-media-cache-state-");
    const mediaRoot = await temporaryDirectory("open-chords-local-media-cache-source-");
    const mediaPath = join(mediaRoot, "recording.wav");
    await writeFile(mediaPath, monoPcmWav([0, 100, 200, 300, 400]));
    const library = await openProjectLibrary({ stateRoot });
    const ingestion = createMediaService({ library, pickFile: async () => mediaPath });
    const selected = await ingestion.pickLocalFile("generation_fixture");
    if (selected.kind !== "selected") throw new Error("Fixture selection was cancelled");
    const created = await ingestion.createProject({
      capabilityId: selected.capabilityId,
      endSourceSample: 4,
      generationId: "generation_fixture",
      startSourceSample: 1,
    });

    let cachedSamples: number[] = [];
    const cacheMedia = createMediaService({
      library,
      pickFile: async () => null,
      rangeCache: {
        cacheProjectRange: async (input) => {
          expect(Object.keys(input).sort()).toEqual([
            "canonicalAudioFingerprint",
            "endSourceSample",
            "projectId",
            "readCanonicalPcm",
            "sampleRate",
            "sourceId",
            "sourceSnapshotId",
            "startSourceSample",
          ]);
          expect(JSON.stringify(input)).not.toContain(mediaPath);
          expect(input).toMatchObject({
            endSourceSample: 4,
            projectId: created.projectId,
            sourceId: created.sourceId,
            startSourceSample: 1,
          });
          const bytes = Buffer.from(
            await input.readCanonicalPcm({ endProjectSample: 3, startProjectSample: 0 }),
          );
          cachedSamples = [bytes.readInt16LE(0), bytes.readInt16LE(2), bytes.readInt16LE(4)];
          await expect(
            input.readCanonicalPcm({ endProjectSample: 4, startProjectSample: 0 }),
          ).rejects.toThrow(/Project Range/i);
        },
      },
    });

    await cacheMedia.cacheProjectRange(created.projectId);
    expect(cachedSamples).toEqual([100, 200, 300]);
  });

  it("retries failed cache handle cleanup before the cache operation completes", async () => {
    const stateRoot = await temporaryDirectory("open-chords-local-media-cache-cleanup-state-");
    const mediaRoot = await temporaryDirectory("open-chords-local-media-cache-cleanup-source-");
    const mediaPath = join(mediaRoot, "recording.wav");
    await writeFile(mediaPath, monoPcmWav([0, 1, 2, 3]));
    const library = await openProjectLibrary({ stateRoot });
    const ingestion = createMediaService({ library, pickFile: async () => mediaPath });
    const selected = await ingestion.pickLocalFile("generation_fixture");
    if (selected.kind !== "selected") throw new Error("Fixture selection was cancelled");
    const created = await ingestion.createProject({
      capabilityId: selected.capabilityId,
      endSourceSample: 4,
      generationId: "generation_fixture",
      startSourceSample: 0,
    });
    const cleanup = failFirstHandleCloseFileSystem();
    const cacheMedia = createMediaService({
      fileSystem: cleanup.fileSystem,
      library,
      pickFile: async () => null,
      rangeCache: { cacheProjectRange: async () => undefined },
    });

    await expect(cacheMedia.cacheProjectRange(created.projectId)).resolves.toBeUndefined();
    expect(cleanup.closeAttempts).toBe(2);
    expect(cleanup.closedHandles).toBe(1);
  });

  it("keeps a Project when its Source is unavailable and durably marks the failed Locator", async () => {
    const stateRoot = await temporaryDirectory("open-chords-local-media-unavailable-state-");
    const mediaRoot = await temporaryDirectory("open-chords-local-media-unavailable-source-");
    const mediaPath = join(mediaRoot, "recording.wav");
    await writeFile(mediaPath, monoPcmWav([0, 1, 2, 3]));
    const library = await openProjectLibrary({ stateRoot });
    const ingestion = createMediaService({ library, pickFile: async () => mediaPath });
    const selected = await ingestion.pickLocalFile("generation_fixture");
    if (selected.kind !== "selected") throw new Error("Fixture selection was cancelled");
    const created = await ingestion.createProject({
      capabilityId: selected.capabilityId,
      endSourceSample: 4,
      generationId: "generation_fixture",
      startSourceSample: 0,
    });
    await rm(mediaPath);

    const result = await createMediaService({
      library,
      now: () => new Date("2026-08-21T12:00:01.000Z"),
      pickFile: async () => null,
    }).openPlayback({ generationId: "generation_fixture", projectId: created.projectId });
    expect(result).toEqual({
      kind: "unavailable",
      projectId: created.projectId,
      sourceId: created.sourceId,
    });
    expect(JSON.stringify(result)).not.toContain(mediaPath);

    const reopened = await openProjectLibrary({ stateRoot });
    expect((await reopened.readProject(created.projectId)).records.sources[0]?.locators).toEqual([
      expect.objectContaining({ path: mediaPath, status: "unavailable" }),
    ]);
  });
});

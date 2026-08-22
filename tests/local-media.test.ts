import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { handleLocalMediaRequest } from "../apps/desktop/src/main/local-media-protocol.ts";
import { LocalMediaService } from "../apps/desktop/src/main/local-media.ts";
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

function monoPcmWav(samples: readonly number[], sampleRate = 48_000): Buffer {
  const bytesPerSample = 2;
  const dataSize = samples.length * bytesPerSample;
  const wav = Buffer.alloc(44 + dataSize);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(36 + dataSize, 4);
  wav.write("WAVE", 8, "ascii");
  wav.write("fmt ", 12, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * bytesPerSample, 28);
  wav.writeUInt16LE(bytesPerSample, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(dataSize, 40);
  samples.forEach((sample, index) => wav.writeInt16LE(sample, 44 + index * bytesPerSample));
  return wav;
}

describe("LocalMediaService", () => {
  it("creates a durable immutable Project Range through an opaque native-picker capability", async () => {
    const stateRoot = await temporaryDirectory("open-chords-local-media-state-");
    const mediaRoot = await temporaryDirectory("open-chords-local-media-source-");
    const mediaPath = join(mediaRoot, "private recording.wav");
    await writeFile(mediaPath, monoPcmWav([0, 1000, -1000, 2000, -2000, 3000, -3000, 0]));
    const library = await openProjectLibrary({ stateRoot });
    const media = new LocalMediaService({
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
      durationSamples: 5,
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
  });

  it("rejects spoofed media before issuing a capability", async () => {
    const stateRoot = await temporaryDirectory("open-chords-local-media-hostile-state-");
    const mediaRoot = await temporaryDirectory("open-chords-local-media-hostile-source-");
    const spoofedPath = join(mediaRoot, "spoofed.wav");
    await writeFile(spoofedPath, Buffer.from("not audio despite its extension"));
    const library = await openProjectLibrary({ stateRoot });

    await expect(
      new LocalMediaService({ library, pickFile: async () => spoofedPath }).pickLocalFile(
        "generation_fixture",
      ),
    ).rejects.toThrow(/supported media/i);
    expect(library.listProjects()).toEqual([]);
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
      new LocalMediaService({ library, pickFile: async () => symlinkPath }).pickLocalFile(
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
      new LocalMediaService({
        library,
        pickFile: async () => join(linkedRoot, "recording.wav"),
      }).pickLocalFile("generation_fixture"),
    ).rejects.toThrow(/symbolic link|junction/i);
    expect(library.listProjects()).toEqual([]);
  });

  it("aborts a concurrent path replacement without publishing a Project", async () => {
    const stateRoot = await temporaryDirectory("open-chords-local-media-race-state-");
    const mediaRoot = await temporaryDirectory("open-chords-local-media-race-source-");
    const mediaPath = join(mediaRoot, "recording.wav");
    const displacedPath = join(mediaRoot, "recording-before-swap.wav");
    await writeFile(mediaPath, monoPcmWav([0, 1, 2, 3]));
    const library = await openProjectLibrary({ stateRoot });
    const media = new LocalMediaService({
      afterVerificationRead: async () => {
        await rename(mediaPath, displacedPath);
        await writeFile(mediaPath, monoPcmWav([4, 5, 6, 7]));
      },
      library,
      pickFile: async () => mediaPath,
    });

    await expect(media.pickLocalFile("generation_fixture")).rejects.toThrow(/changed/i);
    expect(library.listProjects()).toEqual([]);
  });

  it("rejects Project Range abuse and a capability from another renderer generation", async () => {
    const stateRoot = await temporaryDirectory("open-chords-local-media-range-state-");
    const mediaRoot = await temporaryDirectory("open-chords-local-media-range-source-");
    const mediaPath = join(mediaRoot, "recording.wav");
    await writeFile(mediaPath, monoPcmWav([0, 1, 2, 3]));
    const library = await openProjectLibrary({ stateRoot });
    const media = new LocalMediaService({ library, pickFile: async () => mediaPath });
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
    const createMedia = new LocalMediaService({ library, pickFile: async () => originalPath });
    const selected = await createMedia.pickLocalFile("generation_fixture");
    if (selected.kind !== "selected") throw new Error("Fixture selection was cancelled");
    const created = await createMedia.createProject({
      capabilityId: selected.capabilityId,
      endSourceSample: 4,
      generationId: "generation_fixture",
      startSourceSample: 0,
    });

    const matching = await new LocalMediaService({
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

    const mismatchMedia = new LocalMediaService({
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

  it("reopens offline playback through bounded read-only byte ranges without exposing a path", async () => {
    const stateRoot = await temporaryDirectory("open-chords-local-media-playback-state-");
    const mediaRoot = await temporaryDirectory("open-chords-local-media-playback-source-");
    const mediaPath = join(mediaRoot, "recording.wav");
    await writeFile(mediaPath, monoPcmWav([0, 100, -100, 200, -200, 0]));
    const library = await openProjectLibrary({ stateRoot });
    const ingestion = new LocalMediaService({ library, pickFile: async () => mediaPath });
    const selected = await ingestion.pickLocalFile("generation_fixture");
    if (selected.kind !== "selected") throw new Error("Fixture selection was cancelled");
    const created = await ingestion.createProject({
      capabilityId: selected.capabilityId,
      endSourceSample: 5,
      generationId: "generation_fixture",
      startSourceSample: 1,
    });

    const reopenedLibrary = await openProjectLibrary({ stateRoot });
    const playback = new LocalMediaService({
      library: reopenedLibrary,
      pickFile: async () => null,
    });
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
    expect(
      (
        await handleLocalMediaRequest(
          playback,
          new Request(opened.playbackUrl, { headers: { Range: "bytes=0-1,4-5" } }),
        )
      ).status,
    ).toBe(416);

    await rename(mediaPath, `${mediaPath}.displaced`);
    await writeFile(mediaPath, monoPcmWav([9, 9, 9, 9, 9, 9]));
    await expect(
      playback.readPlaybackRange({
        capabilityId: opened.capabilityId,
        endByteExclusive: 12,
        startByte: 0,
      }),
    ).rejects.toThrow(/changed/i);
  });

  it("gives a cache adapter only an immutable Project Range and range-bounded PCM reader", async () => {
    const stateRoot = await temporaryDirectory("open-chords-local-media-cache-state-");
    const mediaRoot = await temporaryDirectory("open-chords-local-media-cache-source-");
    const mediaPath = join(mediaRoot, "recording.wav");
    await writeFile(mediaPath, monoPcmWav([0, 100, 200, 300, 400]));
    const library = await openProjectLibrary({ stateRoot });
    const ingestion = new LocalMediaService({ library, pickFile: async () => mediaPath });
    const selected = await ingestion.pickLocalFile("generation_fixture");
    if (selected.kind !== "selected") throw new Error("Fixture selection was cancelled");
    const created = await ingestion.createProject({
      capabilityId: selected.capabilityId,
      endSourceSample: 4,
      generationId: "generation_fixture",
      startSourceSample: 1,
    });

    let cachedSamples: number[] = [];
    const cacheMedia = new LocalMediaService({
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

  it("keeps a Project when its Source is unavailable and durably marks the failed Locator", async () => {
    const stateRoot = await temporaryDirectory("open-chords-local-media-unavailable-state-");
    const mediaRoot = await temporaryDirectory("open-chords-local-media-unavailable-source-");
    const mediaPath = join(mediaRoot, "recording.wav");
    await writeFile(mediaPath, monoPcmWav([0, 1, 2, 3]));
    const library = await openProjectLibrary({ stateRoot });
    const ingestion = new LocalMediaService({ library, pickFile: async () => mediaPath });
    const selected = await ingestion.pickLocalFile("generation_fixture");
    if (selected.kind !== "selected") throw new Error("Fixture selection was cancelled");
    const created = await ingestion.createProject({
      capabilityId: selected.capabilityId,
      endSourceSample: 4,
      generationId: "generation_fixture",
      startSourceSample: 0,
    });
    await rm(mediaPath);

    const result = await new LocalMediaService({
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

import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ProjectEnvelopeSchema } from "@open-chords/contracts";
import { parseProjectContract } from "@open-chords/domain";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import type { ProjectOwnedRecords } from "../apps/desktop/src/main/project-library-records.ts";
import {
  openProjectLibrary,
  ProjectLibraryDamagedError,
  ProjectLibraryReadOnlyError,
  type ProjectLibraryFaultPoint,
  type ProjectMigration,
} from "../apps/desktop/src/main/project-library.ts";

const fixturePath = join(
  import.meta.dirname,
  "../packages/testkit/contracts/v1/valid/project-envelope.json",
);
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

function goldenEnvelope() {
  return ProjectEnvelopeSchema.parse(JSON.parse(readFileSync(fixturePath, "utf8")));
}

function ownedRecords(): ProjectOwnedRecords {
  return {
    exportReceipts: [
      {
        activeViewHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        createdAt: "2026-08-21T08:00:00Z",
        format: "open_chords_json",
        id: "receipt_fixture",
        omissions: [],
        outputHash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        outputLocation: "/external/exports/project.json",
        profileVersion: "1.0",
      },
    ],
    extensions: {},
    projectRange: {
      endSourceSample: 58_000,
      sourceId: "source_fixture",
      startSourceSample: 10_000,
    },
    sources: [
      {
        id: "source_fixture",
        identity: {
          fingerprint: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
          kind: "local_file",
        },
        locators: [
          {
            fingerprint: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
            id: "locator_fixture",
            kind: "local_file",
            path: "/private/media/fixture.wav",
            status: "available",
            verifiedAt: "2026-08-21T08:00:00Z",
          },
        ],
        metadataObservations: [],
        snapshots: [
          {
            byteFingerprint:
              "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
            canonicalAudioFingerprint:
              "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
            durationSamples: 96_000,
            id: "snapshot_fixture",
            observedAt: "2026-08-21T08:00:00Z",
            provenance: {
              componentHashes: [],
              componentVersions: { probe: "1.0.0" },
              kind: "local_file",
            },
            selectedFormat: {
              audioCodec: "pcm_s16le",
              container: "wav",
              mimeType: "audio/wav",
            },
          },
        ],
      },
    ],
  };
}

function replacementTransaction(id: string) {
  return {
    id,
    operations: [
      {
        eventId: "chord_am7_e",
        type: "replace_chord_value" as const,
        value: { kind: "no_chord" as const },
      },
    ],
    parentTransactionId: null,
  };
}

describe("ProjectLibrary", () => {
  it("publishes immutable revisions, commits through the ProjectAuthority seam, and reopens", async () => {
    const stateRoot = await temporaryDirectory("open-chords-library-state-");
    const library = await openProjectLibrary({ stateRoot });
    const changes: Array<{ projectRevisionId: string; sequence: number }> = [];
    library.subscribe(({ projectRevisionId, sequence }) =>
      changes.push({ projectRevisionId, sequence }),
    );
    const created = await library.createProject({
      envelope: goldenEnvelope(),
      records: ownedRecords(),
    });

    const committed = await library.commitEditTransaction({
      expectedProjectRevisionId: created.projectRevisionId,
      projectId: "project_golden",
      transaction: replacementTransaction("transaction_library"),
    });
    expect(committed).toHaveProperty("projectRevisionId");
    if (!("projectRevisionId" in committed)) throw new Error("Project mutation did not commit");
    expect(committed.projectRevisionId).not.toBe(created.projectRevisionId);
    expect(changes).toEqual([
      { projectRevisionId: created.projectRevisionId, sequence: 1 },
      { projectRevisionId: committed.projectRevisionId, sequence: 2 },
    ]);

    const reopened = await openProjectLibrary({ stateRoot });
    const snapshot = await reopened.getSnapshot("project_golden");
    expect(snapshot).not.toBeNull();
    expect(snapshot).toMatchObject({
      eventSequence: 2,
      projectRevisionId: committed.projectRevisionId,
    });
    const project = parseProjectContract(snapshot?.project);
    expect(project.editLayers[0]?.transactions.at(-1)?.id).toBe("transaction_library");
    expect(project.activeView.editHistoryPosition).toBe(project.editLayers[0]?.transactions.length);

    const stored = await reopened.readProject("project_golden");
    expect(stored.records).toEqual(ownedRecords());
    expect(stored.compatibility).toBe("writable");
    expect(stored.revisions).toHaveLength(2);
  });

  it("never exposes a partial Head when a crash interrupts publication", async () => {
    for (const faultPoint of [
      "after_payload_durable",
      "after_revision_durable",
      "before_head_replace",
      "after_head_replace",
    ] as const satisfies readonly ProjectLibraryFaultPoint[]) {
      const stateRoot = await temporaryDirectory(`open-chords-library-${faultPoint}-`);
      const baseline = await openProjectLibrary({ stateRoot });
      const created = await baseline.createProject({
        envelope: goldenEnvelope(),
        records: ownedRecords(),
      });
      let injected = false;
      const crashing = await openProjectLibrary({
        faultInjector: (point) => {
          if (!injected && point === faultPoint) {
            injected = true;
            throw new Error(`simulated crash at ${point}`);
          }
        },
        stateRoot,
      });

      await expect(
        crashing.commitEditTransaction({
          expectedProjectRevisionId: created.projectRevisionId,
          projectId: "project_golden",
          transaction: replacementTransaction(`transaction_${faultPoint}`),
        }),
      ).rejects.toThrow(/simulated crash/);

      const recovered = await openProjectLibrary({ stateRoot });
      const snapshot = await recovered.getSnapshot("project_golden");
      expect(() => parseProjectContract(snapshot?.project)).not.toThrow();
      expect(snapshot?.eventSequence).toBe(faultPoint === "after_head_replace" ? 2 : 1);
      expect(readdirSync(join(recovered.activeRoot, "staging"))).toHaveLength(0);
    }
  });

  it("quarantines a corrupt active revision and restores the last verified revision", async () => {
    const stateRoot = await temporaryDirectory("open-chords-library-recovery-");
    const library = await openProjectLibrary({ stateRoot });
    const first = await library.createProject({
      envelope: goldenEnvelope(),
      records: ownedRecords(),
    });
    const second = await library.commitEditTransaction({
      expectedProjectRevisionId: first.projectRevisionId,
      projectId: "project_golden",
      transaction: replacementTransaction("transaction_corrupt"),
    });
    if (!("projectRevisionId" in second)) throw new Error("Project mutation did not commit");

    corruptActivePayload(library.activeRoot, "project_golden");
    const recovered = await openProjectLibrary({ stateRoot });
    const snapshot = await recovered.getSnapshot("project_golden");
    expect(snapshot?.projectRevisionId).toBe(first.projectRevisionId);
    expect(snapshot?.eventSequence).toBe(1);
    expect(recovered.listProjects()).toEqual([
      expect.objectContaining({
        projectId: "project_golden",
        recoveryReport: expect.objectContaining({
          lostProjectRevisionId: second.projectRevisionId,
        }),
        status: "active",
      }),
    ]);
    expect(readdirSync(join(recovered.activeRoot, "quarantine"))).toHaveLength(1);
  });

  it("rejects an altered Head that is not the exact verified ledger pointer", async () => {
    const stateRoot = await temporaryDirectory("open-chords-library-head-ledger-");
    const library = await openProjectLibrary({ stateRoot });
    const created = await library.createProject({
      envelope: goldenEnvelope(),
      records: ownedRecords(),
    });
    const headPath = join(library.activeRoot, "projects", "project_golden", "HEAD.json");
    const alteredHead = z
      .object({ sequence: z.number() })
      .loose()
      .parse(JSON.parse(readFileSync(headPath, "utf8")));
    writeFileSync(headPath, JSON.stringify({ ...alteredHead, sequence: 99 }));

    const recovered = await openProjectLibrary({ stateRoot });
    expect((await recovered.getSnapshot("project_golden"))?.projectRevisionId).toBe(
      created.projectRevisionId,
    );
    expect(recovered.listProjects()[0]?.recoveryReport?.lostProjectRevisionId).toBe(
      created.projectRevisionId,
    );
  });

  it("keeps a Project visible as damaged when no verified revision remains", async () => {
    const stateRoot = await temporaryDirectory("open-chords-library-damaged-");
    const library = await openProjectLibrary({ stateRoot });
    await library.createProject({ envelope: goldenEnvelope(), records: ownedRecords() });
    corruptActivePayload(library.activeRoot, "project_golden");

    const reopened = await openProjectLibrary({ stateRoot });
    expect(reopened.listProjects()).toEqual([
      expect.objectContaining({ projectId: "project_golden", status: "damaged" }),
    ]);
    await expect(reopened.readProject("project_golden")).rejects.toBeInstanceOf(
      ProjectLibraryDamagedError,
    );
  });

  it("refuses newer schema writes and leaves a failed legacy migration readable and unchanged", async () => {
    const stateRoot = await temporaryDirectory("open-chords-library-schema-");
    const library = await openProjectLibrary({ stateRoot });
    const newer = structuredClone(goldenEnvelope());
    newer.schemaVersion = "1.1";
    newer.payload.schemaVersion = "1.1";
    await expect(
      library.createProject({ envelope: newer, records: ownedRecords() }),
    ).rejects.toBeInstanceOf(ProjectLibraryReadOnlyError);

    const legacy = structuredClone(goldenEnvelope());
    legacy.schemaVersion = "1.0";
    legacy.payload.schemaVersion = "1.0";
    const migration: ProjectMigration = {
      fromVersion: "1.0",
      migrate: () => {
        throw new Error("migration fixture failed");
      },
      toVersion: "1.1",
    };
    const futureStateRoot = await temporaryDirectory("open-chords-library-future-schema-");
    const futureLibrary = await openProjectLibrary({
      currentSchemaVersion: "1.1",
      migrations: [migration],
      stateRoot: futureStateRoot,
    });
    await expect(
      futureLibrary.restoreProjectRevision({ envelope: legacy, records: ownedRecords() }),
    ).rejects.toThrow(/migration fixture failed/);
    const unchanged = await futureLibrary.readProject("project_golden");
    expect(unchanged.envelope.schemaVersion).toBe("1.0");
    expect(unchanged.compatibility).toBe("read_only");
    expect(unchanged.revisions).toHaveLength(1);
  });

  it("opens safely understood newer minor schemas read-only", async () => {
    const stateRoot = await temporaryDirectory("open-chords-library-newer-");
    const newerEnvelope = structuredClone(goldenEnvelope());
    newerEnvelope.schemaVersion = "1.1";
    newerEnvelope.payload.schemaVersion = "1.1";
    const newerApplication = await openProjectLibrary({
      currentSchemaVersion: "1.1",
      stateRoot,
    });
    const created = await newerApplication.createProject({
      envelope: newerEnvelope,
      records: ownedRecords(),
    });

    const olderApplication = await openProjectLibrary({ stateRoot });
    expect((await olderApplication.readProject("project_golden")).compatibility).toBe("read_only");
    expect(
      await olderApplication.commitEditTransaction({
        expectedProjectRevisionId: created.projectRevisionId,
        projectId: "project_golden",
        transaction: replacementTransaction("transaction_newer_schema"),
      }),
    ).toEqual({ readOnly: true });
  });

  it("opens a structurally understood newer major read-only without quarantine or mutation", async () => {
    const stateRoot = await temporaryDirectory("open-chords-library-newer-major-");
    const futureEnvelope = structuredClone(goldenEnvelope());
    futureEnvelope.schemaVersion = "2.0";
    futureEnvelope.payload.schemaVersion = "2.0";
    const futureApplication = await openProjectLibrary({
      currentSchemaVersion: "2.0",
      stateRoot,
    });
    const created = await futureApplication.createProject({
      envelope: futureEnvelope,
      records: ownedRecords(),
    });

    const olderApplication = await openProjectLibrary({ stateRoot });
    const opened = await olderApplication.readProject("project_golden");
    expect(opened.compatibility).toBe("read_only");
    expect(opened.projectRevisionId).toBe(created.projectRevisionId);
    expect(readdirSync(join(olderApplication.activeRoot, "quarantine"))).toEqual([]);
  });

  it("migrates in a new revision and rolls back by publishing another compatible revision", async () => {
    const stateRoot = await temporaryDirectory("open-chords-library-migration-");
    const migration: ProjectMigration = {
      fromVersion: "1.0",
      migrate: (rawEnvelope) => {
        const envelope = structuredClone(ProjectEnvelopeSchema.parse(rawEnvelope));
        envelope.schemaVersion = "1.1";
        envelope.payload.schemaVersion = "1.1";
        return envelope;
      },
      toVersion: "1.1",
    };
    const library = await openProjectLibrary({
      currentSchemaVersion: "1.1",
      migrations: [migration],
      stateRoot,
    });
    const migrated = await library.restoreProjectRevision({
      envelope: goldenEnvelope(),
      records: ownedRecords(),
    });
    const afterMigration = await library.readProject("project_golden");
    expect(afterMigration.envelope.schemaVersion).toBe("1.1");
    expect(afterMigration.revisions).toHaveLength(2);

    const preMigrationRevision = afterMigration.revisions[0];
    if (preMigrationRevision === undefined) throw new Error("Pre-migration revision is missing");
    const objectCountBeforeRollback = readdirSync(
      join(library.activeRoot, "objects", "sha256"),
    ).length;
    const rolledBack = await library.rollbackProject(
      "project_golden",
      preMigrationRevision.projectRevisionId,
      migrated.projectRevisionId,
    );
    expect(rolledBack.projectRevisionId).not.toBe(migrated.projectRevisionId);
    expect((await library.readProject("project_golden")).revisions).toHaveLength(3);
    expect(readdirSync(join(library.activeRoot, "objects", "sha256"))).toHaveLength(
      objectCountBeforeRollback + 1,
    );
  });

  it("automatically migrates an existing older Library when it opens", async () => {
    const stateRoot = await temporaryDirectory("open-chords-library-open-migration-");
    const olderApplication = await openProjectLibrary({ stateRoot });
    await olderApplication.createProject({ envelope: goldenEnvelope(), records: ownedRecords() });
    const migration: ProjectMigration = {
      fromVersion: "1.0",
      migrate: (rawEnvelope) => {
        const envelope = structuredClone(ProjectEnvelopeSchema.parse(rawEnvelope));
        envelope.schemaVersion = "1.1";
        envelope.payload.schemaVersion = "1.1";
        return envelope;
      },
      toVersion: "1.1",
    };

    const currentApplication = await openProjectLibrary({
      currentSchemaVersion: "1.1",
      migrations: [migration],
      stateRoot,
    });
    const migrated = await currentApplication.readProject("project_golden");
    expect(migrated.compatibility).toBe("writable");
    expect(migrated.envelope.schemaVersion).toBe("1.1");
    expect(migrated.revisions.map(({ reason }) => reason)).toEqual(["created", "migration"]);
  });

  it("keeps an existing older revision read-only when automatic migration fails", async () => {
    const stateRoot = await temporaryDirectory("open-chords-library-open-migration-failure-");
    const olderApplication = await openProjectLibrary({ stateRoot });
    const created = await olderApplication.createProject({
      envelope: goldenEnvelope(),
      records: ownedRecords(),
    });

    const currentApplication = await openProjectLibrary({
      currentSchemaVersion: "1.1",
      migrations: [
        {
          fromVersion: "1.0",
          migrate: () => {
            throw new Error("migration fixture failed");
          },
          toVersion: "1.1",
        },
      ],
      stateRoot,
    });
    const unchanged = await currentApplication.readProject("project_golden");
    expect(unchanged.compatibility).toBe("read_only");
    expect(unchanged.projectRevisionId).toBe(created.projectRevisionId);
    expect(unchanged.revisions).toHaveLength(1);
  });

  it("does not publish an intermediate revision when a later migration step fails", async () => {
    const stateRoot = await temporaryDirectory("open-chords-library-migration-chain-failure-");
    const olderApplication = await openProjectLibrary({ stateRoot });
    const created = await olderApplication.createProject({
      envelope: goldenEnvelope(),
      records: ownedRecords(),
    });
    const currentApplication = await openProjectLibrary({
      currentSchemaVersion: "1.2",
      migrations: [
        {
          fromVersion: "1.0",
          migrate: (rawEnvelope) => {
            const envelope = structuredClone(ProjectEnvelopeSchema.parse(rawEnvelope));
            envelope.schemaVersion = "1.1";
            envelope.payload.schemaVersion = "1.1";
            return envelope;
          },
          toVersion: "1.1",
        },
        {
          fromVersion: "1.1",
          migrate: () => {
            throw new Error("second migration fixture failed");
          },
          toVersion: "1.2",
        },
      ],
      stateRoot,
    });

    const unchanged = await currentApplication.readProject("project_golden");
    expect(unchanged.projectRevisionId).toBe(created.projectRevisionId);
    expect(unchanged.envelope.schemaVersion).toBe("1.0");
    expect(unchanged.revisions).toHaveLength(1);
  });

  it("rejects non-advancing and ambiguous migration graphs before opening", async () => {
    const stateRoot = await temporaryDirectory("open-chords-library-invalid-migrations-");
    const identityMigration = (rawEnvelope: unknown) => rawEnvelope;
    await expect(
      openProjectLibrary({
        currentSchemaVersion: "1.1",
        migrations: [{ fromVersion: "1.0", migrate: identityMigration, toVersion: "1.0" }],
        stateRoot,
      }),
    ).rejects.toThrow(/advance/i);
    await expect(
      openProjectLibrary({
        currentSchemaVersion: "1.1",
        migrations: [
          { fromVersion: "1.0", migrate: identityMigration, toVersion: "1.1" },
          { fromVersion: "1.0", migrate: identityMigration, toVersion: "1.2" },
        ],
        stateRoot,
      }),
    ).rejects.toThrow(/duplicate/i);
  });

  it("migrates independently versioned mixed envelope and Project states", async () => {
    for (const [envelopeVersion, projectVersion] of [
      ["1.0", "1.1"],
      ["1.1", "1.0"],
    ] as const) {
      const stateRoot = await temporaryDirectory(
        `open-chords-library-mixed-${envelopeVersion}-${projectVersion}-`,
      );
      const mixedEnvelope = structuredClone(goldenEnvelope());
      mixedEnvelope.schemaVersion = envelopeVersion;
      mixedEnvelope.payload.schemaVersion = projectVersion;
      const library = await openProjectLibrary({
        currentSchemaVersion: "1.1",
        migrations: [
          {
            fromVersion: "1.0",
            migrate: (rawEnvelope) => {
              const envelope = structuredClone(ProjectEnvelopeSchema.parse(rawEnvelope));
              envelope.schemaVersion = "1.1";
              envelope.payload.schemaVersion = "1.1";
              return envelope;
            },
            toVersion: "1.1",
          },
        ],
        stateRoot,
      });
      await library.restoreProjectRevision({ envelope: mixedEnvelope, records: ownedRecords() });
      const migrated = await library.readProject("project_golden");
      expect(migrated.compatibility).toBe("writable");
      expect(migrated.revisions.map(({ reason }) => reason)).toEqual(["restored", "migration"]);
    }
  });

  it("validates Project Range against Project duration and retained Source Snapshots", async () => {
    const stateRoot = await temporaryDirectory("open-chords-library-range-validation-");
    const library = await openProjectLibrary({ stateRoot });
    const wrongLength = ownedRecords();
    wrongLength.projectRange.endSourceSample -= 1;
    await expect(
      library.createProject({ envelope: goldenEnvelope(), records: wrongLength }),
    ).rejects.toThrow(/range length/i);

    const outsideSnapshot = ownedRecords();
    const snapshot = outsideSnapshot.sources[0]?.snapshots[0];
    if (snapshot === undefined) throw new Error("Source Snapshot fixture is missing");
    snapshot.durationSamples = outsideSnapshot.projectRange.endSourceSample - 1;
    await expect(
      library.createProject({ envelope: goldenEnvelope(), records: outsideSnapshot }),
    ).rejects.toThrow(/fit a retained Source Snapshot/i);
  });

  it("binds canonical YouTube Locators and Snapshot provenance to Source identity", async () => {
    const stateRoot = await temporaryDirectory("open-chords-library-youtube-records-");
    const library = await openProjectLibrary({ stateRoot });
    const records = ownedRecords();
    const source = records.sources[0];
    const snapshot = source?.snapshots[0];
    if (source === undefined || snapshot === undefined)
      throw new Error("Source fixture is missing");
    source.identity = { kind: "youtube", provider: "youtube", videoId: "BBBBBBBBBBB" };
    source.locators = [
      {
        canonicalUrl: "https://www.youtube.com/watch?v=AAAAAAAAAAA&list=playlist",
        id: "locator_youtube",
        kind: "youtube",
        observedAt: "2026-08-21T08:00:00Z",
        videoId: "BBBBBBBBBBB",
      },
    ];
    snapshot.provenance = {
      componentHashes: ["sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"],
      componentVersions: { extractor: "1.0.0" },
      kind: "youtube_acquisition",
      policyHash: "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      policyVersion: "1.0",
      provider: "youtube",
      videoId: "BBBBBBBBBBB",
    };
    await expect(library.createProject({ envelope: goldenEnvelope(), records })).rejects.toThrow(
      /exact video ID/i,
    );

    source.locators = [
      {
        canonicalUrl: "https://www.youtube.com/watch?v=BBBBBBBBBBB",
        id: "locator_youtube",
        kind: "youtube",
        observedAt: "2026-08-21T08:00:00Z",
        videoId: "BBBBBBBBBBB",
      },
    ];
    snapshot.provenance.videoId = "AAAAAAAAAAA";
    await expect(library.createProject({ envelope: goldenEnvelope(), records })).rejects.toThrow(
      /provenance/i,
    );
  });

  it("supports recoverable Trash without deleting external media or export targets", async () => {
    const stateRoot = await temporaryDirectory("open-chords-library-trash-");
    const library = await openProjectLibrary({
      now: () => new Date("2026-08-21T08:00:00Z"),
      stateRoot,
    });
    await library.createProject({ envelope: goldenEnvelope(), records: ownedRecords() });
    await library.trashProject("project_golden");
    expect(library.listProjects()).toEqual([
      expect.objectContaining({ projectId: "project_golden", status: "trashed" }),
    ]);
    expect(readFileSync(fixturePath, "utf8")).toContain("project_golden");

    await library.restoreTrashedProject("project_golden");
    expect((await library.getSnapshot("project_golden"))?.project.id).toBe("project_golden");
    await library.trashProject("project_golden");
    expect(
      await library.emptyTrash({
        olderThan: new Date("2026-09-20T08:00:01Z"),
      }),
    ).toEqual(["project_golden"]);
    expect(library.listProjects()).toEqual([]);
  });

  it("recovers an interrupted Trash restore with a residual marker as active", async () => {
    const stateRoot = await temporaryDirectory("open-chords-library-trash-restore-crash-");
    const library = await openProjectLibrary({ stateRoot });
    await library.createProject({ envelope: goldenEnvelope(), records: ownedRecords() });
    await library.trashProject("project_golden");
    renameSync(
      join(library.activeRoot, "trash", "project_golden"),
      join(library.activeRoot, "projects", "project_golden"),
    );

    const reopened = await openProjectLibrary({ stateRoot });
    expect(reopened.listProjects()).toEqual([
      expect.objectContaining({ projectId: "project_golden", status: "active" }),
    ]);
    expect((await reopened.getSnapshot("project_golden"))?.project.id).toBe("project_golden");
  });

  it("requires exact confirmation for immediate permanent deletion", async () => {
    const stateRoot = await temporaryDirectory("open-chords-library-delete-");
    const library = await openProjectLibrary({ stateRoot });
    await library.createProject({ envelope: goldenEnvelope(), records: ownedRecords() });
    await library.trashProject("project_golden");
    await expect(
      library.permanentlyDeleteProject("project_golden", "project_other"),
    ).rejects.toThrow(/confirmation/i);
    await library.permanentlyDeleteProject("project_golden", "project_golden");
    expect(library.listProjects()).toEqual([]);
    expect(readdirSync(join(library.activeRoot, "objects", "sha256"))).toEqual([]);
  });

  it("does not reclaim immutable objects while another Project is damaged", async () => {
    const stateRoot = await temporaryDirectory("open-chords-library-damaged-gc-");
    const library = await openProjectLibrary({ stateRoot });
    await library.createProject({ envelope: goldenEnvelope(), records: ownedRecords() });
    const secondEnvelope = structuredClone(goldenEnvelope());
    secondEnvelope.payload.id = "project_second";
    for (const revision of secondEnvelope.payload.analysisRevisions)
      revision.projectId = "project_second";
    await library.createProject({ envelope: secondEnvelope, records: ownedRecords() });
    corruptActivePayload(library.activeRoot, "project_golden");

    const reopened = await openProjectLibrary({ stateRoot });
    const objectsDirectory = join(reopened.activeRoot, "objects", "sha256");
    const objectsBeforeDeletion = readdirSync(objectsDirectory).toSorted();
    await reopened.trashProject("project_second");
    await reopened.permanentlyDeleteProject("project_second", "project_second");
    expect(readdirSync(objectsDirectory).toSorted()).toEqual(objectsBeforeDeletion);
  });

  it("relocates only to a local path, atomically switches, and retains the old copy", async () => {
    const stateRoot = await temporaryDirectory("open-chords-library-relocate-state-");
    const destinationParent = await temporaryDirectory("open-chords-library-relocate-target-");
    const destination = join(destinationParent, "Moved Library");
    const library = await openProjectLibrary({ stateRoot });
    await library.createProject({ envelope: goldenEnvelope(), records: ownedRecords() });
    const oldRoot = library.activeRoot;

    await library.relocate(destination);
    expect(library.activeRoot).toBe(destination);
    expect(readFileSync(join(oldRoot, "projects", "project_golden", "HEAD.json"), "utf8")).toBe(
      readFileSync(join(destination, "projects", "project_golden", "HEAD.json"), "utf8"),
    );
    const reopened = await openProjectLibrary({ stateRoot });
    expect(reopened.activeRoot).toBe(destination);
    expect((await reopened.getSnapshot("project_golden"))?.project.id).toBe("project_golden");

    const cloudTarget = join(destinationParent, "Dropbox", "Open Chords");
    await expect(reopened.relocate(cloudTarget)).rejects.toThrow(/local disk/i);
  });

  it("refuses relocation when a trashed Project is corrupt", async () => {
    const stateRoot = await temporaryDirectory("open-chords-library-relocate-trash-state-");
    const destinationParent = await temporaryDirectory(
      "open-chords-library-relocate-trash-target-",
    );
    const library = await openProjectLibrary({ stateRoot });
    await library.createProject({ envelope: goldenEnvelope(), records: ownedRecords() });
    await library.trashProject("project_golden");
    corruptPayload(library.activeRoot, "project_golden", "trash");

    const reopened = await openProjectLibrary({ stateRoot });
    expect(reopened.listProjects()).toEqual([
      expect.objectContaining({ projectId: "project_golden", status: "damaged" }),
    ]);
    await expect(reopened.relocate(join(destinationParent, "Moved Library"))).rejects.toThrow(
      /complete validation/i,
    );
  });

  it("rejects a cloud-synchronized active Library path before initializing Project data", async () => {
    const parent = await temporaryDirectory("open-chords-library-cloud-parent-");
    await expect(
      openProjectLibrary({ stateRoot: join(parent, "Library", "CloudStorage", "Open Chords") }),
    ).rejects.toThrow(/local disk/i);
  });

  it.runIf(process.platform !== "win32")(
    "rejects a local-looking symlink into a cloud-synchronized path",
    async () => {
      const parent = await temporaryDirectory("open-chords-library-cloud-link-");
      const cloudTarget = join(parent, "CloudStorage", "Dropbox", "Open Chords");
      mkdirSync(cloudTarget, { recursive: true });
      const localLookingLink = join(parent, "library-link");
      symlinkSync(cloudTarget, localLookingLink, "dir");

      await expect(
        openProjectLibrary({ stateRoot: join(localLookingLink, "state") }),
      ).rejects.toThrow(/local disk/i);
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects a symlinked managed directory without traversing its target",
    async () => {
      const stateRoot = await temporaryDirectory("open-chords-library-managed-link-");
      const victim = await temporaryDirectory("open-chords-library-managed-link-victim-");
      const marker = join(victim, "must-survive.txt");
      writeFileSync(marker, "survives");
      const library = await openProjectLibrary({ stateRoot });
      const staging = join(library.activeRoot, "staging");
      rmSync(staging, { recursive: true });
      symlinkSync(victim, staging, "dir");

      await expect(openProjectLibrary({ stateRoot })).rejects.toThrow(/real directory/i);
      expect(readFileSync(marker, "utf8")).toBe("survives");
    },
  );

  it("rebuilds a corrupt index instead of treating it as authority", async () => {
    const stateRoot = await temporaryDirectory("open-chords-library-index-");
    const library = await openProjectLibrary({ stateRoot });
    await library.createProject({ envelope: goldenEnvelope(), records: ownedRecords() });
    writeFileSync(join(library.activeRoot, "project-index.json"), "not json");

    const reopened = await openProjectLibrary({ stateRoot });
    expect(reopened.listProjects()).toEqual([
      expect.objectContaining({ projectId: "project_golden", status: "active" }),
    ]);
    expect(() =>
      JSON.parse(readFileSync(join(reopened.activeRoot, "project-index.json"), "utf8")),
    ).not.toThrow();
  });
});

function corruptActivePayload(activeRoot: string, projectId: string): void {
  corruptPayload(activeRoot, projectId, "projects");
}

function corruptPayload(
  activeRoot: string,
  projectId: string,
  container: "projects" | "trash",
): void {
  const head = z
    .object({ revisionObjectHash: z.string() })
    .parse(JSON.parse(readFileSync(join(activeRoot, container, projectId, "HEAD.json"), "utf8")));
  const revisionPath = objectPath(activeRoot, head.revisionObjectHash);
  const revision = z
    .object({ payloadObjectHash: z.string() })
    .parse(JSON.parse(readFileSync(revisionPath, "utf8")));
  const payloadPath = objectPath(activeRoot, revision.payloadObjectHash);
  writeFileSync(payloadPath, "corrupt payload");
}

function objectPath(activeRoot: string, hash: string): string {
  const digest = hash.replace(/^sha256:/, "");
  return join(activeRoot, "objects", "sha256", `${digest}.json`);
}

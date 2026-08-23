import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { ProjectEnvelopeSchema } from "@open-chords/contracts";
import { canonicalSerialize, parseProjectContract } from "@open-chords/domain";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import type { ProjectOwnedRecords } from "../apps/desktop/src/main/project-library-records.ts";
import {
  openProjectLibrary,
  ProjectLibraryDamagedError,
  ProjectLibraryIncompatibleSchemaError,
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
            byteSize: 192_044,
            canonicalAudioFingerprint:
              "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
            durationSamples: 96_000,
            id: "snapshot_fixture",
            metadataObservationIds: [],
            observedAt: "2026-08-21T08:00:00Z",
            provenance: {
              components: [
                {
                  hash: "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
                  id: "media-probe",
                  version: "1.0.0",
                },
              ],
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

function relocationJournalSafety(targetParent: string, id: string) {
  const metadata = lstatSync(targetParent, { bigint: true });
  return {
    stagingCleanupTarget: join(targetParent, `.open-chords-library-relocation-cleanup-${id}`),
    targetCleanupTarget: join(targetParent, `.open-chords-library-target-cleanup-${id}`),
    targetParent,
    targetParentIdentity: {
      device: metadata.dev.toString(),
      inode: metadata.ino.toString(),
    },
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

function envelopeForProject(projectId: string) {
  const envelope = structuredClone(goldenEnvelope());
  envelope.payload.id = projectId;
  for (const revision of envelope.payload.analysisRevisions) revision.projectId = projectId;
  return envelope;
}

function analysisPublication(
  expectedProjectRevisionId: string,
  revision: ReturnType<typeof goldenEnvelope>["payload"]["analysisRevisions"][number],
  attemptId: string,
) {
  const recipe = {
    capabilities: ["rhythm" as const],
    components: [
      {
        hash: `sha256:${"1".repeat(64)}`,
        id: "rhythm-model",
        version: "1.0.0",
      },
    ],
    numericalBackend: {
      hash: `sha256:${"2".repeat(64)}`,
      id: "numpy",
      version: "2.4.2",
    },
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
  const recipeHash = hashCanonical(recipe);
  const identity = {
    attemptId,
    canonicalAudioFingerprint:
      "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    jobKey: `sha256:${"a".repeat(64)}`,
    projectId: "project_golden",
    recipeHash,
    sourceIdentityKind: "source_snapshot" as const,
    sourceSnapshotId: "snapshot_fixture",
  };
  const manifest = {
    acceptedOutputHashes: {
      supportClaimIds: hashCanonical(revision.supportClaimIds),
      timeline: hashCanonical(revision.timeline),
    },
    candidateIdentity: identity,
    format: "open-chords/analysis-manifest" as const,
    recipe,
    reproducibilityConditions: {
      componentHashes: recipe.components.map(({ hash }) => hash),
      numericalBackendHash: recipe.numericalBackend.hash,
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
  return {
    ...identity,
    expectedProjectRevisionId,
    manifest,
    revision: {
      ...revision,
      id: `revision_${manifestHash.slice("sha256:".length)}`,
      manifestHash,
    },
  };
}

function hashCanonical(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalSerialize(value)).digest("hex")}`;
}

const DURABILITY_TEST_TIMEOUT_MS = 15_000;

describe("ProjectLibrary", () => {
  it("keeps Source verification separate from Model Store recipe resolution", async () => {
    const stateRoot = await temporaryDirectory("open-chords-library-analysis-dependencies-");
    const library = await openProjectLibrary({ stateRoot });
    await library.createProject({ envelope: goldenEnvelope(), records: ownedRecords() });
    let modelStoreCalls = 0;
    const modelStore = {
      resolveBlockedRecipeArtifacts: async () => {
        modelStoreCalls += 1;
        return [{ id: "rhythm-model", kind: "model" as const }];
      },
    };
    const validSource = await library.resolveBlockedDependencies({
      canonicalAudioFingerprint:
        "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      modelStore,
      projectId: "project_golden",
      recipe: analysisPublication(
        "projectrevision_fixture",
        goldenEnvelope().payload.analysisRevisions[0]!,
        "attempt_dependencies",
      ).manifest.recipe,
      sourceSnapshotId: "snapshot_fixture",
    });
    expect(validSource).toEqual([{ id: "rhythm-model", kind: "model" }]);
    expect(modelStoreCalls).toBe(1);

    const invalidSource = await library.resolveBlockedDependencies({
      canonicalAudioFingerprint: `sha256:${"f".repeat(64)}`,
      modelStore,
      projectId: "project_golden",
      recipe: analysisPublication(
        "projectrevision_fixture",
        goldenEnvelope().payload.analysisRevisions[0]!,
        "attempt_dependencies",
      ).manifest.recipe,
      sourceSnapshotId: "snapshot_fixture",
    });
    expect(invalidSource).toEqual([{ id: "snapshot_fixture", kind: "media" }]);
    expect(modelStoreCalls).toBe(1);
  });

  it("atomically publishes the first Analysis Revision and keeps later results reviewable", async () => {
    const stateRoot = await temporaryDirectory("open-chords-library-analysis-publication-");
    const library = await openProjectLibrary({ stateRoot });
    const emptyEnvelope = goldenEnvelope();
    const firstCandidate = structuredClone(emptyEnvelope.payload.analysisRevisions[0]!);
    firstCandidate.id = "revision_first_analysis";
    firstCandidate.supportClaimIds = [];
    emptyEnvelope.payload.activeView = null;
    emptyEnvelope.payload.analysisRevisions = [];
    emptyEnvelope.payload.editLayers = [];
    emptyEnvelope.payload.lyricsAlignments = [];
    emptyEnvelope.payload.lyricsDocuments = [];
    emptyEnvelope.payload.supportClaims = [];
    const created = await library.createProject({
      envelope: emptyEnvelope,
      records: ownedRecords(),
    });

    const firstPublication = analysisPublication(
      created.projectRevisionId,
      firstCandidate,
      "attempt_first",
    );
    const first = await library.publishAnalysisRevision(firstPublication);
    expect(first).toHaveProperty("projectRevisionId");
    if (!("projectRevisionId" in first)) throw new Error("First analysis was not published");
    const afterFirst = await library.getSnapshot("project_golden");
    expect(afterFirst?.project.activeView).toMatchObject({
      analysisRevisionId: firstPublication.revision.id,
      editHistoryPosition: 0,
    });
    expect(afterFirst?.project.editLayers).toMatchObject([
      { analysisRevisionId: firstPublication.revision.id, transactions: [] },
    ]);

    const secondCandidate = structuredClone(firstCandidate);
    secondCandidate.id = "revision_reviewable_analysis";
    const secondPublication = analysisPublication(
      first.projectRevisionId,
      secondCandidate,
      "attempt_second",
    );
    const second = await library.publishAnalysisRevision(secondPublication);
    expect(second).toHaveProperty("projectRevisionId");
    const afterSecond = await library.getSnapshot("project_golden");
    expect(afterSecond?.project.analysisRevisions.map(({ id }) => id)).toEqual([
      firstPublication.revision.id,
      secondPublication.revision.id,
    ]);
    expect(afterSecond?.project.activeView?.analysisRevisionId).toBe(firstPublication.revision.id);
    expect((await library.readProject("project_golden")).revisions.at(-1)?.reason).toBe(
      "analysis_publication",
    );
  });

  it("preserves Project Head when an Analysis candidate is stale or invalid", async () => {
    const stateRoot = await temporaryDirectory("open-chords-library-analysis-rejection-");
    const library = await openProjectLibrary({ stateRoot });
    const created = await library.createProject({
      envelope: goldenEnvelope(),
      records: ownedRecords(),
    });
    const candidate = structuredClone(goldenEnvelope().payload.analysisRevisions[0]!);
    candidate.id = "revision_rejected";

    await expect(
      library.publishAnalysisRevision(
        analysisPublication("projectrevision_stale", candidate, "attempt_stale"),
      ),
    ).resolves.toEqual({ stale: true });
    const invalid = structuredClone(candidate);
    invalid.timeline.chordEvents[0]!.endSample += 1;
    await expect(
      library.publishAnalysisRevision(
        analysisPublication(created.projectRevisionId, invalid, "attempt_invalid"),
      ),
    ).rejects.toThrow(/invariants|timeline|contiguous/iu);
    expect((await library.getSnapshot("project_golden"))?.projectRevisionId).toBe(
      created.projectRevisionId,
    );
  });

  it(
    "publishes immutable revisions, commits through the ProjectAuthority seam, and reopens",
    async () => {
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
      if (project.activeView === null) throw new Error("Golden fixture Active View is missing");
      expect(project.editLayers[0]?.transactions.at(-1)?.id).toBe("transaction_library");
      expect(project.activeView.editHistoryPosition).toBe(
        project.editLayers[0]?.transactions.length,
      );

      const stored = await reopened.readProject("project_golden");
      expect(stored.records).toEqual(ownedRecords());
      expect(stored.compatibility).toBe("writable");
      expect(stored.revisions).toHaveLength(2);
    },
    DURABILITY_TEST_TIMEOUT_MS,
  );

  it.each([
    "after_payload_durable",
    "after_object_rename",
    "after_revision_durable",
    "before_head_replace",
    "after_head_rename",
    "after_head_file_sync",
    "after_head_replace",
  ] as const satisfies readonly ProjectLibraryFaultPoint[])(
    "never exposes a partial Head when a crash interrupts publication at %s",
    async (faultPoint) => {
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
      const changes: Array<{ projectRevisionId: string; sequence: number }> = [];
      crashing.subscribe(({ projectRevisionId, sequence }) =>
        changes.push({ projectRevisionId, sequence }),
      );

      const outcome = await crashing
        .commitEditTransaction({
          expectedProjectRevisionId: created.projectRevisionId,
          projectId: "project_golden",
          transaction: replacementTransaction(`transaction_${faultPoint}`),
        })
        .then(
          () => "resolved",
          () => "rejected",
        );
      const committedDespiteFault = [
        "after_head_rename",
        "after_head_file_sync",
        "after_head_replace",
      ].includes(faultPoint);
      expect(outcome).toBe(committedDespiteFault ? "resolved" : "rejected");

      const recovered = await openProjectLibrary({ stateRoot });
      const snapshot = await recovered.getSnapshot("project_golden");
      expect(() => parseProjectContract(snapshot?.project)).not.toThrow();
      expect(snapshot?.eventSequence).toBe(committedDespiteFault ? 2 : 1);
      expect(changes).toHaveLength(committedDespiteFault ? 1 : 0);
      expect(readdirSync(join(recovered.activeRoot, "staging"))).toHaveLength(0);
    },
    DURABILITY_TEST_TIMEOUT_MS,
  );

  it("does not publish or retain a first revision whose Head was never installed", async () => {
    const stateRoot = await temporaryDirectory("open-chords-library-unpublished-first-");
    const library = await openProjectLibrary({ stateRoot });
    await library.createProject({ envelope: goldenEnvelope(), records: ownedRecords() });
    const projectDirectory = join(library.activeRoot, "projects", "project_golden");
    const stagedPublication = join(library.activeRoot, "staging", "interrupted-publication");
    mkdirSync(stagedPublication);
    renameSync(join(projectDirectory, "HEAD.json"), join(stagedPublication, "HEAD.json"));

    const reopened = await openProjectLibrary({ stateRoot });
    expect(reopened.listProjects()).toEqual([]);
    expect(readdirSync(join(reopened.activeRoot, "objects", "sha256"))).toEqual([]);
    expect(readdirSync(join(reopened.activeRoot, "quarantine"))).toEqual([
      expect.stringMatching(/^project_golden-UNPUBLISHED-/),
    ]);
  });

  it("reconciles an unpublished durable pointer before another live mutation", async () => {
    const stateRoot = await temporaryDirectory("open-chords-library-live-retry-");
    const baseline = await openProjectLibrary({ stateRoot });
    const created = await baseline.createProject({
      envelope: goldenEnvelope(),
      records: ownedRecords(),
    });
    let injected = false;
    const library = await openProjectLibrary({
      faultInjector: (point) => {
        if (!injected && point === "after_revision_durable") {
          injected = true;
          throw new Error("simulated publication failure");
        }
      },
      stateRoot,
    });
    await expect(
      library.commitEditTransaction({
        expectedProjectRevisionId: created.projectRevisionId,
        projectId: "project_golden",
        transaction: replacementTransaction("transaction_failed_publication"),
      }),
    ).rejects.toThrow(/publication failure/);

    const retried = await library.commitEditTransaction({
      expectedProjectRevisionId: created.projectRevisionId,
      projectId: "project_golden",
      transaction: replacementTransaction("transaction_retried"),
    });
    if (!("projectRevisionId" in retried)) throw new Error("Retry did not publish");
    const reopened = await openProjectLibrary({ stateRoot });
    const stored = await reopened.readProject("project_golden");
    expect(stored.revisions).toHaveLength(2);
    expect(stored.envelope.payload.editLayers[0]?.transactions.map(({ id }) => id)).toContain(
      "transaction_retried",
    );
    expect(stored.envelope.payload.editLayers[0]?.transactions.map(({ id }) => id)).not.toContain(
      "transaction_failed_publication",
    );
    expect(readdirSync(join(reopened.activeRoot, "staging"))).toEqual([]);
    expect(readdirSync(join(reopened.activeRoot, "objects", "sha256"))).toHaveLength(4);
  });

  it("collects a pre-existing unpublished pointer tail during startup", async () => {
    const stateRoot = await temporaryDirectory("open-chords-library-startup-tail-");
    const library = await openProjectLibrary({ stateRoot });
    const created = await library.createProject({
      envelope: goldenEnvelope(),
      records: ownedRecords(),
    });
    const committed = await library.commitEditTransaction({
      expectedProjectRevisionId: created.projectRevisionId,
      projectId: "project_golden",
      transaction: replacementTransaction("transaction_unpublished_tail"),
    });
    if (!("projectRevisionId" in committed)) throw new Error("Fixture mutation did not commit");
    const projectDirectory = join(library.activeRoot, "projects", "project_golden");
    const pointerFiles = readdirSync(join(projectDirectory, "revisions")).toSorted();
    const firstPointerFile = pointerFiles[0];
    if (firstPointerFile === undefined) throw new Error("Initial revision pointer is missing");
    const firstPointer = z
      .object({
        projectRevisionId: z.string(),
        revisionObjectHash: z.string(),
        sequence: z.number(),
      })
      .parse(
        JSON.parse(readFileSync(join(projectDirectory, "revisions", firstPointerFile), "utf8")),
      );
    const currentHead = z
      .object({ format: z.string(), projectId: z.string(), schemaVersion: z.string() })
      .loose()
      .parse(JSON.parse(readFileSync(join(projectDirectory, "HEAD.json"), "utf8")));
    writeFileSync(
      join(projectDirectory, "HEAD.json"),
      canonicalSerialize({ ...currentHead, ...firstPointer }),
    );

    const reopened = await openProjectLibrary({ stateRoot });
    expect((await reopened.readProject("project_golden")).revisions).toHaveLength(1);
    expect(readdirSync(join(projectDirectory, "revisions"))).toHaveLength(1);
    expect(readdirSync(join(reopened.activeRoot, "objects", "sha256"))).toHaveLength(2);
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

  it("keeps a Project damaged when both Head and its durable publication boundary are missing", async () => {
    const stateRoot = await temporaryDirectory("open-chords-library-missing-head-");
    const library = await openProjectLibrary({ stateRoot });
    await library.createProject({
      envelope: goldenEnvelope(),
      records: ownedRecords(),
    });
    rmSync(join(library.activeRoot, "projects", "project_golden", "HEAD.json"));

    const recovered = await openProjectLibrary({ stateRoot });
    expect(recovered.listProjects()).toEqual([
      expect.objectContaining({ projectId: "project_golden", status: "damaged" }),
    ]);
    await expect(recovered.getSnapshot("project_golden")).rejects.toThrow(
      ProjectLibraryDamagedError,
    );
  });

  it("excludes a staged unpublished tail while recovering a corrupt or missing old Head", async () => {
    for (const oldHeadState of ["corrupt", "missing"] as const) {
      const stateRoot = await temporaryDirectory(`open-chords-library-staged-${oldHeadState}-`);
      const library = await openProjectLibrary({ stateRoot });
      const created = await library.createProject({
        envelope: goldenEnvelope(),
        records: ownedRecords(),
      });
      const committed = await library.commitEditTransaction({
        expectedProjectRevisionId: created.projectRevisionId,
        projectId: "project_golden",
        transaction: replacementTransaction(`transaction_staged_${oldHeadState}`),
      });
      if (!("projectRevisionId" in committed)) throw new Error("Fixture mutation did not commit");
      const projectDirectory = join(library.activeRoot, "projects", "project_golden");
      const stagedPublication = join(library.activeRoot, "staging", `interrupted-${oldHeadState}`);
      mkdirSync(stagedPublication);
      renameSync(join(projectDirectory, "HEAD.json"), join(stagedPublication, "HEAD.json"));
      if (oldHeadState === "corrupt") writeFileSync(join(projectDirectory, "HEAD.json"), "broken");

      const recovered = await openProjectLibrary({ stateRoot });
      expect((await recovered.getSnapshot("project_golden"))?.projectRevisionId).toBe(
        created.projectRevisionId,
      );
      expect((await recovered.readProject("project_golden")).revisions).toHaveLength(1);
      expect(readdirSync(join(recovered.activeRoot, "objects", "sha256"))).toHaveLength(2);
    }
  });

  it("does not trust a staged Head that does not match its exact installed pointer", async () => {
    const stateRoot = await temporaryDirectory("open-chords-library-staged-mismatch-");
    const library = await openProjectLibrary({ stateRoot });
    const created = await library.createProject({
      envelope: goldenEnvelope(),
      records: ownedRecords(),
    });
    const committed = await library.commitEditTransaction({
      expectedProjectRevisionId: created.projectRevisionId,
      projectId: "project_golden",
      transaction: replacementTransaction("transaction_staged_mismatch"),
    });
    if (!("projectRevisionId" in committed)) throw new Error("Fixture mutation did not commit");
    const projectDirectory = join(library.activeRoot, "projects", "project_golden");
    const stagedDirectory = join(library.activeRoot, "staging", "altered-publication");
    mkdirSync(stagedDirectory);
    const stagedHeadPath = join(stagedDirectory, "HEAD.json");
    renameSync(join(projectDirectory, "HEAD.json"), stagedHeadPath);
    const stagedHead = z
      .object({ sequence: z.number() })
      .loose()
      .parse(JSON.parse(readFileSync(stagedHeadPath, "utf8")));
    writeFileSync(stagedHeadPath, canonicalSerialize({ ...stagedHead, sequence: 3 }));
    writeFileSync(join(projectDirectory, "HEAD.json"), "broken");

    const reopened = await openProjectLibrary({ stateRoot });
    expect(reopened.listProjects()).toEqual([
      expect.objectContaining({ projectId: "project_golden", status: "damaged" }),
    ]);
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
    const restored = await futureLibrary.restoreProjectRevision({
      envelope: legacy,
      records: ownedRecords(),
    });
    expect(restored.migrationFailure).toMatch(/migration fixture failed/);
    const unchanged = await futureLibrary.readProject("project_golden");
    expect(unchanged.envelope.schemaVersion).toBe("1.0");
    expect(unchanged.compatibility).toBe("read_only");
    expect(unchanged.revisions).toHaveLength(1);
    expect(unchanged.migrationFailure).toMatch(/migration fixture failed/);
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

  it("rejects an unknown major without quarantining or mutating its durable Head", async () => {
    const stateRoot = await temporaryDirectory("open-chords-library-newer-major-");
    const library = await openProjectLibrary({ stateRoot });
    await library.createProject({ envelope: goldenEnvelope(), records: ownedRecords() });
    rewriteStoredProjectEnvelope(library.activeRoot, "project_golden", { version: "2.0" });
    const headPath = join(library.activeRoot, "projects", "project_golden", "HEAD.json");
    const headBeforeOpen = readFileSync(headPath, "utf8");

    await expect(openProjectLibrary({ stateRoot })).rejects.toBeInstanceOf(
      ProjectLibraryIncompatibleSchemaError,
    );
    expect(readFileSync(headPath, "utf8")).toBe(headBeforeOpen);
    expect(readdirSync(join(library.activeRoot, "quarantine"))).toEqual([]);
  });

  it("rejects unknown newer-minor core semantics without Head recovery", async () => {
    const stateRoot = await temporaryDirectory("open-chords-library-newer-minor-core-");
    const library = await openProjectLibrary({ stateRoot });
    await library.createProject({ envelope: goldenEnvelope(), records: ownedRecords() });
    rewriteStoredProjectEnvelope(library.activeRoot, "project_golden", {
      addFutureCoreField: true,
      version: "1.1",
    });
    const headPath = join(library.activeRoot, "projects", "project_golden", "HEAD.json");
    const headBeforeOpen = readFileSync(headPath, "utf8");

    await expect(openProjectLibrary({ stateRoot })).rejects.toBeInstanceOf(
      ProjectLibraryIncompatibleSchemaError,
    );
    expect(readFileSync(headPath, "utf8")).toBe(headBeforeOpen);
    expect(readdirSync(join(library.activeRoot, "quarantine"))).toEqual([]);
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
    expect(unchanged.migrationFailure).toMatch(/migration fixture failed/);
  });

  it("opens the original read-only after migration publication runs out of space", async () => {
    const stateRoot = await temporaryDirectory("open-chords-library-migration-io-failure-");
    const olderApplication = await openProjectLibrary({ stateRoot });
    const created = await olderApplication.createProject({
      envelope: goldenEnvelope(),
      records: ownedRecords(),
    });
    let injected = false;
    const currentApplication = await openProjectLibrary({
      currentSchemaVersion: "1.1",
      faultInjector: (point) => {
        if (!injected && point === "after_revision_durable") {
          injected = true;
          throw Object.assign(new Error("disk full during migration"), { code: "ENOSPC" });
        }
      },
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
    const unchanged = await currentApplication.readProject("project_golden");
    expect(unchanged.compatibility).toBe("read_only");
    expect(unchanged.projectRevisionId).toBe(created.projectRevisionId);
    expect(unchanged.revisions).toHaveLength(1);
    expect(unchanged.migrationFailure).toMatch(/disk full during migration/);
  });

  it("keeps errno-shaped migration callback failures readable and read-only", async () => {
    const stateRoot = await temporaryDirectory("open-chords-library-migration-errno-");
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
            throw Object.assign(new Error("migration input was not found"), { code: "ENOENT" });
          },
          toVersion: "1.1",
        },
      ],
      stateRoot,
    });

    const unchanged = await currentApplication.readProject("project_golden");
    expect(unchanged.projectRevisionId).toBe(created.projectRevisionId);
    expect(unchanged.migrationFailure).toMatch(/migration input was not found/);
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

  it("enforces stable and deduplicated Source identity across Projects", async () => {
    const stateRoot = await temporaryDirectory("open-chords-library-source-authority-");
    const library = await openProjectLibrary({ stateRoot });
    await library.createProject({ envelope: goldenEnvelope(), records: ownedRecords() });
    const secondEnvelope = envelopeForProject("project_second");

    const conflictingIdentity = ownedRecords();
    const conflictingSource = conflictingIdentity.sources[0];
    const conflictingLocator = conflictingSource?.locators[0];
    const conflictingSnapshot = conflictingSource?.snapshots[0];
    const differentFingerprint =
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab";
    if (
      conflictingSource?.identity.kind !== "local_file" ||
      conflictingLocator?.kind !== "local_file" ||
      conflictingSnapshot === undefined
    )
      throw new Error("Local Source fixture is missing");
    conflictingSource.identity.fingerprint = differentFingerprint;
    conflictingLocator.fingerprint = differentFingerprint;
    conflictingSnapshot.byteFingerprint = differentFingerprint;
    await expect(
      library.createProject({ envelope: secondEnvelope, records: conflictingIdentity }),
    ).rejects.toThrow(/conflicts with Library Source identity/i);

    const duplicateIdentity = ownedRecords();
    const duplicateSource = duplicateIdentity.sources[0];
    if (duplicateSource === undefined) throw new Error("Source fixture is missing");
    duplicateSource.id = "source_duplicate";
    duplicateIdentity.projectRange.sourceId = "source_duplicate";
    await expect(
      library.createProject({ envelope: secondEnvelope, records: duplicateIdentity }),
    ).rejects.toThrow(/already owned/i);
  });

  it("enforces immutable Snapshot and Metadata Observation records across Projects", async () => {
    const stateRoot = await temporaryDirectory("open-chords-library-source-record-authority-");
    const library = await openProjectLibrary({ stateRoot });
    const original = ownedRecords();
    const source = original.sources[0];
    const snapshot = source?.snapshots[0];
    if (source === undefined || snapshot === undefined)
      throw new Error("Source fixture is missing");
    source.metadataObservations = [
      {
        id: "metadata_fixture",
        observedAt: snapshot.observedAt,
        provider: "filesystem",
        title: "Original title",
      },
    ];
    snapshot.metadataObservationIds = ["metadata_fixture"];
    await library.createProject({ envelope: goldenEnvelope(), records: original });
    const secondEnvelope = envelopeForProject("project_second");

    const changedSnapshot = structuredClone(original);
    const secondSnapshot = changedSnapshot.sources[0]?.snapshots[0];
    if (secondSnapshot === undefined) throw new Error("Source Snapshot fixture is missing");
    secondSnapshot.canonicalAudioFingerprint =
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab";
    await expect(
      library.createProject({ envelope: secondEnvelope, records: changedSnapshot }),
    ).rejects.toThrow(/Snapshot.*immutable/i);

    const changedObservation = structuredClone(original);
    const observation = changedObservation.sources[0]?.metadataObservations[0];
    if (observation === undefined) throw new Error("Metadata Observation fixture is missing");
    observation.title = "Changed title";
    await expect(
      library.createProject({ envelope: secondEnvelope, records: changedObservation }),
    ).rejects.toThrow(/Metadata Observation.*immutable/i);
  });

  it("materializes one current additive Locator state for a shared Source", async () => {
    const stateRoot = await temporaryDirectory("open-chords-library-locator-authority-");
    const library = await openProjectLibrary({ stateRoot });
    await library.createProject({ envelope: goldenEnvelope(), records: ownedRecords() });
    const changed = ownedRecords();
    const locator = changed.sources[0]?.locators[0];
    if (locator?.kind !== "local_file") throw new Error("Local Locator fixture is missing");
    locator.status = "unavailable";
    locator.verifiedAt = "2026-08-21T09:00:00Z";

    await library.createProject({
      envelope: envelopeForProject("project_second"),
      records: changed,
    });
    const firstLocator = (await library.readProject("project_golden")).records.sources[0]
      ?.locators[0];
    expect(firstLocator).toMatchObject({
      status: "unavailable",
      verifiedAt: "2026-08-21T09:00:00Z",
    });
  });

  it("publishes Project entries and Locator authority as one in-memory snapshot", async () => {
    const stateRoot = await temporaryDirectory("open-chords-library-locator-atomic-");
    let pauseCatalog = false;
    let releaseCatalog!: () => void;
    let catalogReached!: () => void;
    const blocked = new Promise<void>((resolve) => {
      releaseCatalog = resolve;
    });
    const reached = new Promise<void>((resolve) => {
      catalogReached = resolve;
    });
    const library = await openProjectLibrary({
      faultInjector: async (point) => {
        if (pauseCatalog && point === "after_catalog_durable") {
          catalogReached();
          await blocked;
        }
      },
      stateRoot,
    });
    await library.createProject({ envelope: goldenEnvelope(), records: ownedRecords() });
    const changed = ownedRecords();
    const locator = changed.sources[0]?.locators[0];
    if (locator?.kind !== "local_file") throw new Error("Local Locator fixture is missing");
    locator.status = "unavailable";
    locator.verifiedAt = "2026-08-21T09:00:00Z";

    pauseCatalog = true;
    const creating = library.createProject({
      envelope: envelopeForProject("project_second"),
      records: changed,
    });
    await reached;
    expect(library.listProjects()).toHaveLength(1);
    expect(
      (await library.readProject("project_golden")).records.sources[0]?.locators[0],
    ).toMatchObject({ status: "available", verifiedAt: "2026-08-21T08:00:00Z" });

    releaseCatalog();
    await creating;
    expect(library.listProjects()).toHaveLength(2);
    expect(
      (await library.readProject("project_golden")).records.sources[0]?.locators[0],
    ).toMatchObject({ status: "unavailable", verifiedAt: "2026-08-21T09:00:00Z" });
  });

  it("rejects conflicting equal-time Locator observations before publication", async () => {
    const stateRoot = await temporaryDirectory("open-chords-library-locator-conflict-");
    const library = await openProjectLibrary({ stateRoot });
    await library.createProject({ envelope: goldenEnvelope(), records: ownedRecords() });
    const conflicting = ownedRecords();
    const locator = conflicting.sources[0]?.locators[0];
    if (locator?.kind !== "local_file") throw new Error("Local Locator fixture is missing");
    locator.status = "unavailable";

    await expect(
      library.createProject({
        envelope: envelopeForProject("project_second"),
        records: conflicting,
      }),
    ).rejects.toThrow(/conflicting equal-time observations/i);
    expect(library.listProjects()).toHaveLength(1);
  });

  it("retains current Locator authority after its publishing Project is deleted", async () => {
    const stateRoot = await temporaryDirectory("open-chords-library-locator-retention-");
    const library = await openProjectLibrary({ stateRoot });
    await library.createProject({ envelope: goldenEnvelope(), records: ownedRecords() });
    const changed = ownedRecords();
    const locator = changed.sources[0]?.locators[0];
    if (locator?.kind !== "local_file") throw new Error("Local Locator fixture is missing");
    locator.status = "unavailable";
    locator.verifiedAt = "2026-08-21T09:00:00Z";
    await library.createProject({
      envelope: envelopeForProject("project_second"),
      records: changed,
    });

    await library.trashProject("project_second");
    await library.permanentlyDeleteProject("project_second", "project_second");
    expect(
      (await library.readProject("project_golden")).records.sources[0]?.locators[0],
    ).toMatchObject({ status: "unavailable", verifiedAt: "2026-08-21T09:00:00Z" });

    const reopened = await openProjectLibrary({ stateRoot });
    expect(
      (await reopened.readProject("project_golden")).records.sources[0]?.locators[0],
    ).toMatchObject({ status: "unavailable", verifiedAt: "2026-08-21T09:00:00Z" });
  });

  it("recovers from a catalog Locator that does not match its Source identity", async () => {
    const stateRoot = await temporaryDirectory("open-chords-library-catalog-identity-");
    const library = await openProjectLibrary({ stateRoot });
    await library.createProject({ envelope: goldenEnvelope(), records: ownedRecords() });
    const catalogPath = join(library.activeRoot, "source-catalog.json");
    const catalog = z
      .looseObject({
        locatorsBySourceId: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))),
      })
      .parse(JSON.parse(readFileSync(catalogPath, "utf8")));
    const locator = catalog.locatorsBySourceId.source_fixture?.[0];
    if (locator === undefined) throw new Error("Catalog Locator fixture is missing");
    locator.fingerprint = "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
    locator.verifiedAt = "2026-08-21T09:00:00Z";
    writeFileSync(catalogPath, canonicalSerialize(catalog));

    await expect(
      openProjectLibrary({
        faultInjector: (point) => {
          if (point === "after_catalog_recovery_report")
            throw new Error("simulated catalog recovery interruption");
        },
        stateRoot,
      }),
    ).rejects.toThrow(/catalog recovery interruption/i);
    expect(existsSync(catalogPath)).toBe(true);
    expect(
      readdirSync(join(library.activeRoot, "reports")).some((name) =>
        name.startsWith("source-catalog-recovery-"),
      ),
    ).toBe(true);

    const reopened = await openProjectLibrary({ stateRoot });
    expect(
      (await reopened.readProject("project_golden")).records.sources[0]?.locators[0],
    ).toMatchObject({
      fingerprint: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    });
    expect(
      readdirSync(join(reopened.activeRoot, "quarantine")).some((name) =>
        name.startsWith("source-catalog-source-catalog.json-"),
      ),
    ).toBe(true);
    expect(
      readdirSync(join(reopened.activeRoot, "reports")).some((name) =>
        name.startsWith("source-catalog-recovery-"),
      ),
    ).toBe(true);
  });

  it("defers catalog pruning while a non-deleted Project is opaquely damaged", async () => {
    const stateRoot = await temporaryDirectory("open-chords-library-catalog-damaged-");
    const library = await openProjectLibrary({ stateRoot });
    await library.createProject({ envelope: goldenEnvelope(), records: ownedRecords() });
    const projectDirectory = join(library.activeRoot, "projects", "project_golden");
    rmSync(join(projectDirectory, "HEAD.json"));
    const revisionsDirectory = join(projectDirectory, "revisions");
    for (const name of readdirSync(revisionsDirectory)) rmSync(join(revisionsDirectory, name));

    const reopened = await openProjectLibrary({ stateRoot });
    expect(reopened.listProjects()).toEqual([
      expect.objectContaining({ projectId: "project_golden", status: "damaged" }),
    ]);
    const catalogSchema = z.looseObject({
      locatorsBySourceId: z.record(z.string(), z.array(z.unknown())),
    });
    const catalog = catalogSchema.parse(
      JSON.parse(readFileSync(join(reopened.activeRoot, "source-catalog.json"), "utf8")),
    );
    expect(catalog.locatorsBySourceId.source_fixture).toHaveLength(1);

    await openProjectLibrary({ stateRoot });
    const reopenedCatalog = catalogSchema.parse(
      JSON.parse(readFileSync(join(reopened.activeRoot, "source-catalog.json"), "utf8")),
    );
    expect(reopenedCatalog).toEqual(catalog);
  });

  it("recovers from duplicate Locator IDs in the primary catalog", async () => {
    const stateRoot = await temporaryDirectory("open-chords-library-catalog-duplicates-");
    const library = await openProjectLibrary({ stateRoot });
    await library.createProject({ envelope: goldenEnvelope(), records: ownedRecords() });
    const catalogPath = join(library.activeRoot, "source-catalog.json");
    const catalog = z
      .looseObject({
        locatorsBySourceId: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))),
      })
      .parse(JSON.parse(readFileSync(catalogPath, "utf8")));
    const locator = catalog.locatorsBySourceId.source_fixture?.[0];
    if (locator === undefined) throw new Error("Catalog Locator fixture is missing");
    catalog.locatorsBySourceId.source_fixture?.push({ ...locator, status: "unavailable" });
    writeFileSync(catalogPath, canonicalSerialize(catalog));

    const reopened = await openProjectLibrary({ stateRoot });
    expect(
      (await reopened.readProject("project_golden")).records.sources[0]?.locators,
    ).toHaveLength(1);
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
    source.metadataObservations = [
      {
        id: "metadata_fixture",
        observedAt: "2026-08-21T08:00:00Z",
        provider: "youtube",
        title: "Fixture title",
      },
    ];
    source.locators = [
      {
        canonicalUrl: "https://www.youtube.com/watch?v=AAAAAAAAAAA&list=playlist",
        id: "locator_youtube",
        kind: "youtube",
        observedAt: "2026-08-21T08:00:00Z",
        videoId: "BBBBBBBBBBB",
      },
    ];
    snapshot.selectedFormat.providerFormatId = "251";
    snapshot.metadataObservationIds = ["metadata_fixture"];
    snapshot.provenance = {
      acquisitionAttemptId: "attempt_fixture",
      brokerSummary: {
        downloadedBytes: snapshot.byteSize,
        redirectCount: 1,
        requestCount: 3,
        wallTimeMs: 1_500,
      },
      canonicalUrl: "https://www.youtube.com/watch?v=BBBBBBBBBBB",
      components: [
        {
          hash: "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
          id: "extractor-worker",
          version: "1.0.0",
        },
      ],
      kind: "youtube_acquisition",
      policy: {
        hash: "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        id: "youtube-acquisition-policy",
        version: "1.0",
      },
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

    snapshot.provenance.videoId = "BBBBBBBBBBB";
    snapshot.metadataObservationIds = ["metadata_missing"];
    await expect(library.createProject({ envelope: goldenEnvelope(), records })).rejects.toThrow(
      /metadata reference/i,
    );

    snapshot.metadataObservationIds = ["metadata_fixture"];
    const observation = source.metadataObservations[0];
    if (observation === undefined) throw new Error("Metadata Observation fixture is missing");
    observation.observedAt = "2026-08-21T09:00:00Z";
    await expect(library.createProject({ envelope: goldenEnvelope(), records })).rejects.toThrow(
      /late/i,
    );

    source.metadataObservations = [];
    snapshot.metadataObservationIds = [];
    await expect(
      library.createProject({ envelope: goldenEnvelope(), records }),
    ).resolves.toBeDefined();
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

  it("reconciles committed Trash lifecycle changes after post-move failures", async () => {
    const stateRoot = await temporaryDirectory("open-chords-library-trash-reconciliation-");
    let faultPoint: ProjectLibraryFaultPoint | undefined = "after_trash_move";
    let injected = false;
    const library = await openProjectLibrary({
      faultInjector: (point) => {
        if (!injected && point === faultPoint) {
          injected = true;
          throw new Error(`simulated lifecycle failure at ${point}`);
        }
      },
      stateRoot,
    });
    await library.createProject({ envelope: goldenEnvelope(), records: ownedRecords() });
    await expect(library.trashProject("project_golden")).rejects.toThrow(/lifecycle failure/);
    expect(library.listProjects()[0]?.status).toBe("trashed");

    faultPoint = "after_trash_restore_move";
    injected = false;
    await expect(library.restoreTrashedProject("project_golden")).rejects.toThrow(
      /lifecycle failure/,
    );
    expect(library.listProjects()[0]?.status).toBe("active");
    expect((await library.getSnapshot("project_golden"))?.project.id).toBe("project_golden");

    faultPoint = undefined;
    await library.trashProject("project_golden");
    faultPoint = "after_permanent_delete";
    injected = false;
    await expect(
      library.permanentlyDeleteProject("project_golden", "project_golden"),
    ).rejects.toThrow(/lifecycle failure/);
    expect(library.listProjects()).toEqual([]);
  });

  it("blocks mutations and defers object collection after an uncertain delete sync", async () => {
    const stateRoot = await temporaryDirectory("open-chords-library-delete-sync-failure-");
    let injected = false;
    const library = await openProjectLibrary({
      faultInjector: (point) => {
        if (!injected && point === "before_permanent_delete_parent_sync") {
          injected = true;
          throw new Error("simulated delete parent sync failure");
        }
      },
      stateRoot,
    });
    await library.createProject({ envelope: goldenEnvelope(), records: ownedRecords() });
    await library.trashProject("project_golden");
    const objectsDirectory = join(library.activeRoot, "objects", "sha256");
    const objectsBefore = readdirSync(objectsDirectory).toSorted();

    await expect(
      library.permanentlyDeleteProject("project_golden", "project_golden"),
    ).rejects.toThrow(/durably committed/i);
    expect(readdirSync(objectsDirectory).toSorted()).toEqual(objectsBefore);
    await expect(
      library.createProject({ envelope: goldenEnvelope(), records: ownedRecords() }),
    ).rejects.toThrow(/reopened/i);
  });

  it("blocks mutations after an uncertain Trash rename sync", async () => {
    const stateRoot = await temporaryDirectory("open-chords-library-trash-sync-failure-");
    let injected = false;
    const library = await openProjectLibrary({
      faultInjector: (point) => {
        if (!injected && point === "before_trash_parent_sync") {
          injected = true;
          throw new Error("simulated Trash parent sync failure");
        }
      },
      stateRoot,
    });
    await library.createProject({ envelope: goldenEnvelope(), records: ownedRecords() });

    await expect(library.trashProject("project_golden")).rejects.toThrow(/durably committed/i);
    await expect(library.restoreTrashedProject("project_golden")).rejects.toThrow(/reopened/i);
  });

  it("durably commits each Empty Trash removal before attempting the next", async () => {
    const stateRoot = await temporaryDirectory("open-chords-library-empty-trash-batch-");
    let removals = 0;
    let failSecond = true;
    const library = await openProjectLibrary({
      faultInjector: (point) => {
        if (point === "before_empty_trash_remove" && ++removals === 2 && failSecond)
          throw new Error("simulated second Trash removal failure");
      },
      stateRoot,
    });
    await library.createProject({ envelope: goldenEnvelope(), records: ownedRecords() });
    await library.createProject({
      envelope: envelopeForProject("project_second"),
      records: ownedRecords(),
    });
    await library.trashProject("project_golden");
    await library.trashProject("project_second");

    await expect(
      library.emptyTrash({ olderThan: new Date("2100-01-01T00:00:00Z") }),
    ).rejects.toThrow(/second Trash removal failure/);
    expect(library.listProjects()).toHaveLength(1);
    failSecond = false;
    removals = 0;
    await expect(
      library.emptyTrash({ olderThan: new Date("2100-01-01T00:00:00Z") }),
    ).resolves.toHaveLength(1);
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
    expect(library.activeRoot).toBe(await realpath(destination));
    expect(readFileSync(join(oldRoot, "projects", "project_golden", "HEAD.json"), "utf8")).toBe(
      readFileSync(join(destination, "projects", "project_golden", "HEAD.json"), "utf8"),
    );
    const reopened = await openProjectLibrary({ stateRoot });
    expect(reopened.activeRoot).toBe(await realpath(destination));
    expect((await reopened.getSnapshot("project_golden"))?.project.id).toBe("project_golden");

    const cloudTarget = join(destinationParent, "Dropbox", "Open Chords");
    await expect(reopened.relocate(cloudTarget)).rejects.toThrow(/local disk/i);
  });

  it.runIf(process.platform !== "win32")(
    "aborts if the relocation target parent identity changes before copy",
    async () => {
      const stateRoot = await temporaryDirectory("open-chords-library-parent-swap-state-");
      const destinationParent = await temporaryDirectory("open-chords-library-parent-swap-target-");
      const replacementParent = await temporaryDirectory(
        "open-chords-library-parent-swap-replacement-",
      );
      const displacedParent = `${destinationParent}-displaced`;
      temporaryRoots.push(displacedParent);
      let swapped = false;
      const library = await openProjectLibrary({
        faultInjector: (point) => {
          if (!swapped && point === "before_relocation_copy") {
            swapped = true;
            renameSync(destinationParent, displacedParent);
            symlinkSync(replacementParent, destinationParent, "dir");
          }
        },
        stateRoot,
      });
      await library.createProject({ envelope: goldenEnvelope(), records: ownedRecords() });
      const previousRoot = library.activeRoot;

      await expect(library.relocate(join(destinationParent, "Moved Library"))).rejects.toThrow(
        /parent.*real directory|parent changed/i,
      );
      expect(library.activeRoot).toBe(previousRoot);
      expect(existsSync(join(replacementParent, "Moved Library"))).toBe(false);
    },
  );

  it.each([
    "after_relocation_target_rename",
    "after_relocation_location_rename",
    "after_relocation_location_replace",
  ] as const satisfies readonly ProjectLibraryFaultPoint[])(
    "reconciles a relocation failure at %s",
    async (faultPoint) => {
      const stateRoot = await temporaryDirectory(`open-chords-library-${faultPoint}-state-`);
      const destinationParent = await temporaryDirectory(
        `open-chords-library-${faultPoint}-target-`,
      );
      const destination = join(destinationParent, "Moved Library");
      let injected = false;
      const library = await openProjectLibrary({
        faultInjector: (point) => {
          if (!injected && point === faultPoint) {
            injected = true;
            throw new Error(`simulated relocation failure at ${point}`);
          }
          if (injected && point === "before_relocation_staging_cleanup")
            throw new Error("simulated relocation staging cleanup failure");
        },
        stateRoot,
      });
      await library.createProject({ envelope: goldenEnvelope(), records: ownedRecords() });
      const canonicalDestination = join(await realpath(destinationParent), "Moved Library");

      await expect(library.relocate(destination)).rejects.toThrow(
        /relocation and staging cleanup both failed/i,
      );
      expect({
        activeRoot: library.activeRoot,
        destinationExists: existsSync(destination),
      }).toEqual({ activeRoot: canonicalDestination, destinationExists: true });
      const reopened = await openProjectLibrary({ stateRoot });
      expect(reopened.activeRoot).toBe(library.activeRoot);
      expect((await reopened.getSnapshot("project_golden"))?.project.id).toBe("project_golden");
    },
  );

  it("uses the durable relocation journal to clear an interrupted copy on explicit retry", async () => {
    const stateRoot = await temporaryDirectory("open-chords-library-relocation-journal-state-");
    const destinationParent = await temporaryDirectory(
      "open-chords-library-relocation-journal-target-",
    );
    const library = await openProjectLibrary({ stateRoot });
    await library.createProject({ envelope: goldenEnvelope(), records: ownedRecords() });
    const target = join(await realpath(destinationParent), "Moved Library");
    const stagingTarget = join(
      await realpath(destinationParent),
      ".open-chords-library-relocation-interrupted",
    );
    const relocationId = "11111111-1111-4111-8111-111111111111";
    mkdirSync(stagingTarget);
    writeFileSync(
      join(stagingTarget, ".open-chords-relocation.json"),
      canonicalSerialize({
        format: "open-chords/project-library-relocation-marker",
        id: relocationId,
        schemaVersion: "1.0",
      }),
    );
    writeFileSync(
      join(stateRoot, "project-library-relocation.json"),
      canonicalSerialize({
        format: "open-chords/project-library-relocation",
        id: relocationId,
        previousRoot: library.activeRoot,
        schemaVersion: "1.0",
        stagingTarget,
        target,
        ...relocationJournalSafety(dirname(target), relocationId),
      }),
    );

    await library.relocate(target);
    expect(library.activeRoot).toBe(target);
    expect(existsSync(stagingTarget)).toBe(false);
    expect(existsSync(join(stateRoot, "project-library-relocation.json"))).toBe(false);
  });

  it("recovers an empty relocation wrapper created before its ownership marker", async () => {
    const stateRoot = await temporaryDirectory("open-chords-library-empty-wrapper-state-");
    const destinationParent = await temporaryDirectory("open-chords-library-empty-wrapper-target-");
    const library = await openProjectLibrary({ stateRoot });
    await library.createProject({ envelope: goldenEnvelope(), records: ownedRecords() });
    const target = join(await realpath(destinationParent), "Moved Library");
    const stagingTarget = join(
      await realpath(destinationParent),
      ".open-chords-library-relocation-empty",
    );
    mkdirSync(stagingTarget);
    writeFileSync(
      join(stateRoot, "project-library-relocation.json"),
      canonicalSerialize({
        format: "open-chords/project-library-relocation",
        id: "44444444-4444-4444-8444-444444444444",
        previousRoot: library.activeRoot,
        schemaVersion: "1.0",
        stagingTarget,
        target,
        ...relocationJournalSafety(dirname(target), "44444444-4444-4444-8444-444444444444"),
      }),
    );

    await library.relocate(target);
    expect(library.activeRoot).toBe(target);
    expect(existsSync(stagingTarget)).toBe(false);
    expect(existsSync(join(stateRoot, "project-library-relocation.json"))).toBe(false);
  });

  it.runIf(process.platform !== "win32")(
    "never follows a replaced relocation wrapper symlink during cleanup",
    async () => {
      for (const marked of [false, true]) {
        const stateRoot = await temporaryDirectory(
          `open-chords-library-relocation-symlink-${marked ? "marked" : "empty"}-state-`,
        );
        const destinationParent = await temporaryDirectory(
          `open-chords-library-relocation-symlink-${marked ? "marked" : "empty"}-target-`,
        );
        const library = await openProjectLibrary({ stateRoot });
        await library.createProject({ envelope: goldenEnvelope(), records: ownedRecords() });
        const parent = await realpath(destinationParent);
        const target = join(parent, "Moved Library");
        const stagingTarget = join(parent, ".open-chords-library-relocation-journaled");
        const unrelated = join(parent, ".open-chords-library-relocation-unrelated");
        const relocationId = marked
          ? "55555555-5555-4555-8555-555555555555"
          : "66666666-6666-4666-8666-666666666666";
        mkdirSync(unrelated);
        if (marked)
          writeFileSync(
            join(unrelated, ".open-chords-relocation.json"),
            canonicalSerialize({
              format: "open-chords/project-library-relocation-marker",
              id: relocationId,
              schemaVersion: "1.0",
            }),
          );
        symlinkSync(unrelated, stagingTarget, "dir");
        writeFileSync(
          join(stateRoot, "project-library-relocation.json"),
          canonicalSerialize({
            format: "open-chords/project-library-relocation",
            id: relocationId,
            previousRoot: library.activeRoot,
            schemaVersion: "1.0",
            stagingTarget,
            target,
            ...relocationJournalSafety(parent, relocationId),
          }),
        );

        await expect(library.relocate(target)).rejects.toThrow(
          /ownership is ambiguous|not a real canonical directory/i,
        );
        expect(existsSync(unrelated)).toBe(true);
        expect(existsSync(stagingTarget)).toBe(true);
        expect(existsSync(join(stateRoot, "project-library-relocation.json"))).toBe(true);
      }
    },
  );

  it("revalidates a relocation wrapper after atomically claiming it for cleanup", async () => {
    const stateRoot = await temporaryDirectory("open-chords-library-cleanup-claim-state-");
    const destinationParent = await temporaryDirectory("open-chords-library-cleanup-claim-target-");
    const parent = await realpath(destinationParent);
    const target = join(parent, "Moved Library");
    const stagingTarget = join(parent, ".open-chords-library-relocation-journaled");
    const preserved = join(parent, ".open-chords-library-relocation-preserved");
    const replacement = join(parent, ".open-chords-library-relocation-replacement");
    const relocationId = "77777777-7777-4777-8777-777777777777";
    let swapped = false;
    const library = await openProjectLibrary({
      faultInjector: (point) => {
        if (!swapped && point === "before_relocation_cleanup_claim") {
          swapped = true;
          renameSync(stagingTarget, preserved);
          renameSync(replacement, stagingTarget);
        }
      },
      stateRoot,
    });
    await library.createProject({ envelope: goldenEnvelope(), records: ownedRecords() });
    mkdirSync(stagingTarget);
    writeFileSync(
      join(stagingTarget, ".open-chords-relocation.json"),
      canonicalSerialize({
        format: "open-chords/project-library-relocation-marker",
        id: relocationId,
        schemaVersion: "1.0",
      }),
    );
    mkdirSync(replacement);
    writeFileSync(
      join(replacement, ".open-chords-relocation.json"),
      canonicalSerialize({
        format: "open-chords/project-library-relocation-marker",
        id: "88888888-8888-4888-8888-888888888888",
        schemaVersion: "1.0",
      }),
    );
    const safety = relocationJournalSafety(parent, relocationId);
    writeFileSync(
      join(stateRoot, "project-library-relocation.json"),
      canonicalSerialize({
        format: "open-chords/project-library-relocation",
        id: relocationId,
        previousRoot: library.activeRoot,
        schemaVersion: "1.0",
        stagingTarget,
        target,
        ...safety,
      }),
    );

    await expect(library.relocate(target)).rejects.toThrow(/ownership is ambiguous/i);
    expect(existsSync(preserved)).toBe(true);
    expect(existsSync(safety.stagingCleanupTarget)).toBe(true);
    expect(existsSync(join(stateRoot, "project-library-relocation.json"))).toBe(true);
  });

  it("re-syncs an already removed relocation cleanup before clearing its journal", async () => {
    const stateRoot = await temporaryDirectory("open-chords-library-cleanup-resync-state-");
    const destinationParent = await temporaryDirectory(
      "open-chords-library-cleanup-resync-target-",
    );
    const parent = await realpath(destinationParent);
    const target = join(parent, "Moved Library");
    const stagingTarget = join(parent, ".open-chords-library-relocation-journaled");
    const relocationId = "99999999-9999-4999-8999-999999999999";
    let injectFailure = true;
    const library = await openProjectLibrary({
      faultInjector: (point) => {
        if (injectFailure && point === "after_relocation_cleanup_remove") {
          injectFailure = false;
          throw new Error("simulated cleanup parent sync interruption");
        }
      },
      stateRoot,
    });
    await library.createProject({ envelope: goldenEnvelope(), records: ownedRecords() });
    mkdirSync(stagingTarget);
    writeFileSync(
      join(stagingTarget, ".open-chords-relocation.json"),
      canonicalSerialize({
        format: "open-chords/project-library-relocation-marker",
        id: relocationId,
        schemaVersion: "1.0",
      }),
    );
    const safety = relocationJournalSafety(parent, relocationId);
    writeFileSync(
      join(stateRoot, "project-library-relocation.json"),
      canonicalSerialize({
        format: "open-chords/project-library-relocation",
        id: relocationId,
        previousRoot: library.activeRoot,
        schemaVersion: "1.0",
        stagingTarget,
        target,
        ...safety,
      }),
    );

    await expect(library.relocate(target)).rejects.toThrow(/parent sync interruption/i);
    expect(existsSync(stagingTarget)).toBe(false);
    expect(existsSync(safety.stagingCleanupTarget)).toBe(false);
    expect(existsSync(join(stateRoot, "project-library-relocation.json"))).toBe(true);

    await library.relocate(target);
    expect(library.activeRoot).toBe(target);
    expect(existsSync(join(stateRoot, "project-library-relocation.json"))).toBe(false);
  });

  it("scavenges a completed relocation wrapper on reopen and permits another relocation", async () => {
    const stateRoot = await temporaryDirectory("open-chords-library-completed-journal-state-");
    const firstParent = await temporaryDirectory("open-chords-library-completed-journal-first-");
    const secondParent = await temporaryDirectory("open-chords-library-completed-journal-second-");
    const library = await openProjectLibrary({ stateRoot });
    await library.createProject({ envelope: goldenEnvelope(), records: ownedRecords() });
    const previousRoot = library.activeRoot;
    const firstTarget = join(firstParent, "Moved Library");
    await library.relocate(firstTarget);
    const canonicalFirstTarget = library.activeRoot;
    const relocationId = "22222222-2222-4222-8222-222222222222";
    const stagingTarget = join(
      dirname(canonicalFirstTarget),
      ".open-chords-library-relocation-completed",
    );
    mkdirSync(stagingTarget);
    for (const root of [stagingTarget, canonicalFirstTarget])
      writeFileSync(
        join(root, ".open-chords-relocation.json"),
        canonicalSerialize({
          format: "open-chords/project-library-relocation-marker",
          id: relocationId,
          schemaVersion: "1.0",
        }),
      );
    writeFileSync(
      join(stateRoot, "project-library-relocation.json"),
      canonicalSerialize({
        format: "open-chords/project-library-relocation",
        id: relocationId,
        previousRoot,
        schemaVersion: "1.0",
        stagingTarget,
        target: canonicalFirstTarget,
        ...relocationJournalSafety(dirname(canonicalFirstTarget), relocationId),
      }),
    );

    const reopened = await openProjectLibrary({ stateRoot });
    expect(existsSync(stagingTarget)).toBe(false);
    expect(existsSync(join(stateRoot, "project-library-relocation.json"))).toBe(false);
    await reopened.relocate(join(secondParent, "Moved Again"));
    expect(reopened.activeRoot).toBe(join(await realpath(secondParent), "Moved Again"));
  });

  it("revalidates an interrupted installed target before making it authoritative", async () => {
    const stateRoot = await temporaryDirectory("open-chords-library-resume-validation-state-");
    const destinationParent = await temporaryDirectory(
      "open-chords-library-resume-validation-target-",
    );
    const library = await openProjectLibrary({ stateRoot });
    await library.createProject({ envelope: goldenEnvelope(), records: ownedRecords() });
    const target = join(await realpath(destinationParent), "Moved Library");
    cpSync(library.activeRoot, target, { recursive: true });
    const relocationId = "33333333-3333-4333-8333-333333333333";
    writeFileSync(
      join(target, ".open-chords-relocation.json"),
      canonicalSerialize({
        format: "open-chords/project-library-relocation-marker",
        id: relocationId,
        schemaVersion: "1.0",
      }),
    );
    writeFileSync(
      join(stateRoot, "project-library-relocation.json"),
      canonicalSerialize({
        format: "open-chords/project-library-relocation",
        id: relocationId,
        previousRoot: library.activeRoot,
        schemaVersion: "1.0",
        stagingTarget: join(dirname(target), ".open-chords-library-relocation-missing"),
        target,
        ...relocationJournalSafety(dirname(target), relocationId),
      }),
    );
    corruptActivePayload(target, "project_golden");

    await library.relocate(target);
    expect(library.activeRoot).toBe(target);
    expect((await library.getSnapshot("project_golden"))?.project.id).toBe("project_golden");
  });

  it.runIf(process.platform !== "win32")(
    "stores the canonical relocation target instead of a mutable symlink alias",
    async () => {
      const stateRoot = await temporaryDirectory("open-chords-library-relocate-alias-state-");
      const destinationParent = await temporaryDirectory(
        "open-chords-library-relocate-alias-target-",
      );
      const aliasParent = join(dirname(destinationParent), `alias-${Date.now()}`);
      temporaryRoots.push(aliasParent);
      symlinkSync(destinationParent, aliasParent, "dir");
      const library = await openProjectLibrary({ stateRoot });
      await library.createProject({ envelope: goldenEnvelope(), records: ownedRecords() });

      await library.relocate(join(aliasParent, "Moved Library"));
      expect(library.activeRoot).toBe(join(await realpath(destinationParent), "Moved Library"));
      expect(readFileSync(join(stateRoot, "project-library-location.json"), "utf8")).not.toContain(
        aliasParent,
      );
    },
  );

  it.runIf(process.platform !== "win32")(
    "compares relocation containment in the canonical active-root namespace",
    async () => {
      const realParent = await temporaryDirectory("open-chords-library-active-real-");
      const aliasParent = join(dirname(realParent), `active-alias-${Date.now()}`);
      temporaryRoots.push(aliasParent);
      symlinkSync(realParent, aliasParent, "dir");
      const library = await openProjectLibrary({ stateRoot: join(aliasParent, "State") });
      await library.createProject({ envelope: goldenEnvelope(), records: ownedRecords() });
      const nestedTarget = join(await realpath(library.activeRoot), "Nested Library");

      await expect(library.relocate(nestedTarget)).rejects.toThrow(/inside its current directory/i);
      expect(existsSync(nestedTarget)).toBe(false);
    },
  );

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

  it.runIf(process.platform !== "win32")(
    "rejects a per-Project symlink swap for live mutations and subsequent startup",
    async () => {
      const stateRoot = await temporaryDirectory("open-chords-library-project-link-");
      const victim = await temporaryDirectory("open-chords-library-project-link-victim-");
      const externalTrashMarker = join(victim, "TRASH.json");
      writeFileSync(externalTrashMarker, "external file");
      const library = await openProjectLibrary({ stateRoot });
      await library.createProject({ envelope: goldenEnvelope(), records: ownedRecords() });
      const projectDirectory = join(library.activeRoot, "projects", "project_golden");
      rmSync(projectDirectory, { recursive: true });
      symlinkSync(victim, projectDirectory, "dir");

      await expect(library.trashProject("project_golden")).rejects.toThrow(/reconciliation/i);
      expect(readFileSync(externalTrashMarker, "utf8")).toBe("external file");
      await expect(openProjectLibrary({ stateRoot })).rejects.toThrow(/unsupported entry/i);
      expect(readFileSync(externalTrashMarker, "utf8")).toBe("external file");
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects a target-container symlink swap before moving Project data",
    async () => {
      const stateRoot = await temporaryDirectory("open-chords-library-target-link-");
      const victim = await temporaryDirectory("open-chords-library-target-link-victim-");
      const marker = join(victim, "must-survive.txt");
      writeFileSync(marker, "survives");
      const library = await openProjectLibrary({ stateRoot });
      await library.createProject({ envelope: goldenEnvelope(), records: ownedRecords() });
      const trashContainer = join(library.activeRoot, "trash");
      rmSync(trashContainer, { recursive: true });
      symlinkSync(victim, trashContainer, "dir");

      await expect(library.trashProject("project_golden")).rejects.toThrow(/reconciliation/i);
      expect(readFileSync(marker, "utf8")).toBe("survives");
      expect(
        readFileSync(join(library.activeRoot, "projects", "project_golden", "HEAD.json"), "utf8"),
      ).toContain("project_golden");
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

function rewriteStoredProjectEnvelope(
  activeRoot: string,
  projectId: string,
  options: { addFutureCoreField?: boolean; version: string },
): void {
  const projectDirectory = join(activeRoot, "projects", projectId);
  const headPath = join(projectDirectory, "HEAD.json");
  const head = z
    .object({ revisionObjectHash: z.string() })
    .loose()
    .parse(JSON.parse(readFileSync(headPath, "utf8")));
  const revision = z
    .object({ payloadObjectHash: z.string() })
    .loose()
    .parse(JSON.parse(readFileSync(objectPath(activeRoot, head.revisionObjectHash), "utf8")));
  const payload = z
    .object({
      envelope: z
        .object({
          payload: z.object({ schemaVersion: z.string() }).loose(),
          schemaVersion: z.string(),
        })
        .loose(),
    })
    .loose()
    .parse(JSON.parse(readFileSync(objectPath(activeRoot, revision.payloadObjectHash), "utf8")));
  payload.envelope.schemaVersion = options.version;
  payload.envelope.payload.schemaVersion = options.version;
  if (options.addFutureCoreField === true) payload.envelope.futureCoreField = "unsupported";
  const payloadContent = canonicalSerialize(payload);
  const payloadHash = hashFixtureContent(payloadContent);
  writeFileSync(objectPath(activeRoot, payloadHash), payloadContent);

  const revisionContent = canonicalSerialize({ ...revision, payloadObjectHash: payloadHash });
  const revisionHash = hashFixtureContent(revisionContent);
  writeFileSync(objectPath(activeRoot, revisionHash), revisionContent);
  const pointerFile = readdirSync(join(projectDirectory, "revisions"))[0];
  if (pointerFile === undefined) throw new Error("Revision pointer fixture is missing");
  const pointerPath = join(projectDirectory, "revisions", pointerFile);
  const pointer = z
    .object({ revisionObjectHash: z.string() })
    .loose()
    .parse(JSON.parse(readFileSync(pointerPath, "utf8")));
  writeFileSync(pointerPath, canonicalSerialize({ ...pointer, revisionObjectHash: revisionHash }));
  writeFileSync(headPath, canonicalSerialize({ ...head, revisionObjectHash: revisionHash }));
}

function hashFixtureContent(content: string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

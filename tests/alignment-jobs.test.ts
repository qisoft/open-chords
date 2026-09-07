import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, readFile, writeFile, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { addLyricsDocument, parseProjectContract } from "@open-chords/domain";
import { afterEach, expect, it } from "vitest";

import { openAlignmentJobs } from "../apps/desktop/src/main/alignment-jobs.ts";
import { ALIGNMENT_PACKS } from "../apps/desktop/src/main/alignment-packs.ts";
import { createContainedAlignmentWorker } from "../apps/desktop/src/main/alignment-worker.ts";
import { LocalMediaService } from "../apps/desktop/src/main/local-media.ts";
import { openModelStore } from "../apps/desktop/src/main/model-store.ts";
import { openProjectLibrary } from "../apps/desktop/src/main/project-library.ts";
import { goldenRecords } from "./support/editor-fixture.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it("publishes one immutable alignment atomically and reopens distinct repeated occurrences with exact provenance", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "open-chords-alignment-"));
  roots.push(stateRoot);
  const data = Buffer.from("bounded external worker model fixture");
  const pack = {
    ...ALIGNMENT_PACKS[0]!,
    artifacts: [
      {
        ...ALIGNMENT_PACKS[0]!.artifacts[1]!,
        format: "file" as const,
        files: undefined,
        bytes: data.length,
        installedBytes: data.length,
        sha256: createHash("sha256").update(data).digest("hex"),
      },
    ],
  };
  const modelStore = await openModelStore({
    stateRoot,
    packs: [pack],
    runtime: pack.runtime,
    fetch: async () => new Response(data),
  });
  await modelStore.install(pack.id);
  const library = await openProjectLibrary({ stateRoot });
  const original = project();
  const envelope = JSON.parse(
    readFileSync(
      new URL("../packages/testkit/contracts/v1/valid/project-envelope.json", import.meta.url),
      "utf8",
    ),
  );
  await library.createProject({
    envelope: { ...envelope, payload: original },
    records: goldenRecords(),
  });
  const jobs = await openAlignmentJobs({
    stateRoot,
    modelStore,
    packs: [pack],
    runtimeManifestHash: "a".repeat(64),
  });
  const job = await jobs.request({
    project: original,
    lyricsDocumentId: "lyrics_alignment_test",
    analysisRevisionId: original.activeView!.analysisRevisionId,
    canonicalAudioFingerprint: `sha256:${"d".repeat(64)}`,
  });
  const tokens = original.lyricsDocuments.at(-1)!.tokens;
  const completed = await jobs.run(job.id, {
    library,
    worker: async () => ({
      recipeHash: job.key,
      likelihood: -31.5,
      words: [
        { tokenId: tokens[0]!.id, startSample: 0, endSample: 4800 },
        { tokenId: tokens[1]!.id, startSample: 4800, endSample: 9600 },
        { tokenId: tokens[2]!.id, reason: "absent_line" },
        { tokenId: tokens[3]!.id, reason: "oov" },
      ],
    }),
  });
  expect(completed.state).toBe("succeeded");
  const reopened = await openProjectLibrary({ stateRoot });
  const saved = (await reopened.getSnapshot(original.id))!.project;
  expect(saved.lyricsDocuments).toEqual(original.lyricsDocuments);
  expect(saved.analysisRevisions).toEqual(original.analysisRevisions);
  expect(saved.lyricsAlignments).toHaveLength(original.lyricsAlignments.length + 1);
  const result = saved.lyricsAlignments.at(-1)!;
  expect(result.provenance).toMatchObject({ recipeHash: job.key, recipe: job.recipe });
  expect(
    modelStore.previewRemoval(pack.id, reopened.listModelReferences()).affectedProjectIds,
  ).toEqual([original.id]);
  expect(result.occurrences.map(({ timing }) => timing.state)).toEqual([
    "matched",
    "matched",
    "unmatched",
    "unmatched",
  ]);
  expect(result.occurrences[2]!.timing).toEqual({ state: "unmatched", reasonCode: "absent_line" });
  expect(result.lineOccurrences.map(({ timing }) => timing.state)).toEqual([
    "matched",
    "unmatched",
  ]);
  expect(result.occurrences[0]!.timing).toMatchObject({
    assertion: { state: "low_confidence", reasonCodes: ["uncalibrated_alignment"] },
  });
  const beforeSelection = (await reopened.getSnapshot(original.id))!;
  await expect(
    reopened.selectLyricsAlignment({
      projectId: original.id,
      expectedProjectRevisionId: "stale",
      alignmentId: result.id,
    }),
  ).resolves.toEqual({ stale: true });
  await reopened.selectLyricsAlignment({
    projectId: original.id,
    expectedProjectRevisionId: beforeSelection.projectRevisionId,
    alignmentId: result.id,
  });
  const selected = (await (await openProjectLibrary({ stateRoot })).getSnapshot(original.id))!
    .project;
  expect(selected.activeView?.lyricsAlignmentId).toBe(result.id);
  expect(selected.lyricsDocuments).toEqual(original.lyricsDocuments);
  expect(selected.lyricsAlignments).toEqual(saved.lyricsAlignments);
  await expect(
    (
      await openAlignmentJobs({
        stateRoot,
        modelStore,
        packs: [pack],
        runtimeManifestHash: "a".repeat(64),
      })
    ).get(job.id),
  ).resolves.toMatchObject({ state: "succeeded" });
});

function project() {
  return addLyricsDocument(
    parseProjectContract(
      JSON.parse(
        readFileSync(
          new URL("../packages/testkit/contracts/v1/valid/project-envelope.json", import.meta.url),
          "utf8",
        ),
      ).payload,
    ),
    { text: "Hello hello\nHello again", language: "en", format: "text" },
    "lyrics_alignment_test",
  );
}

async function runnableJob() {
  const stateRoot = await mkdtemp(join(tmpdir(), "open-chords-alignment-"));
  roots.push(stateRoot);
  const data = Buffer.from("bounded alignment dependency");
  const pack = {
    ...ALIGNMENT_PACKS[0]!,
    artifacts: [
      {
        ...ALIGNMENT_PACKS[0]!.artifacts[1]!,
        format: "file" as const,
        files: undefined,
        bytes: data.length,
        installedBytes: data.length,
        sha256: createHash("sha256").update(data).digest("hex"),
      },
    ],
  };
  const modelStore = await openModelStore({
    stateRoot,
    packs: [pack],
    runtime: pack.runtime,
    fetch: async () => new Response(data),
  });
  await modelStore.install(pack.id);
  const library = await openProjectLibrary({ stateRoot });
  const original = project();
  const envelope = JSON.parse(
    readFileSync(
      new URL("../packages/testkit/contracts/v1/valid/project-envelope.json", import.meta.url),
      "utf8",
    ),
  );
  await library.createProject({
    envelope: { ...envelope, payload: original },
    records: goldenRecords(),
  });
  const options = { stateRoot, modelStore, packs: [pack], runtimeManifestHash: "a".repeat(64) };
  const jobs = await openAlignmentJobs(options);
  const request = {
    project: original,
    lyricsDocumentId: "lyrics_alignment_test",
    analysisRevisionId: original.activeView!.analysisRevisionId,
    canonicalAudioFingerprint: `sha256:${"d".repeat(64)}`,
  };
  const job = await jobs.request(request);
  const output = {
    recipeHash: job.key,
    likelihood: -12,
    words: original.lyricsDocuments
      .at(-1)!
      .tokens.map((token) => ({ tokenId: token.id, reason: "alignment_mismatch" })),
  };
  return { options, jobs, job, request, output, library, original };
}

it("persists cancellation before aborting the worker and never publishes its late result", async () => {
  const context = await runnableJob();
  let release!: (value: unknown) => void;
  let signal!: AbortSignal;
  const started = Promise.withResolvers<void>();
  const running = context.jobs.run(context.job.id, {
    library: context.library,
    worker: (input) => {
      signal = input.signal;
      started.resolve();
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  });
  const terminal = running.then(
    () => null,
    (error: unknown) => error,
  );
  await started.promise;
  await context.jobs.cancel(context.job.id);
  expect(signal.aborted).toBe(true);
  expect(await (await openAlignmentJobs(context.options)).get(context.job.id)).toMatchObject({
    state: "cancelled",
  });
  release(context.output);
  expect(await terminal).toMatchObject({ message: "Alignment Job cancelled" });
  expect(
    (await context.library.getSnapshot(context.original.id))!.project.lyricsAlignments,
  ).toEqual(context.original.lyricsAlignments);
});

it("stops execution without publishing even when cancel intent cannot be written", async () => {
  const context = await runnableJob();
  const entered = Promise.withResolvers<AbortSignal>();
  const release = Promise.withResolvers<unknown>();
  const execution = context.jobs
    .run(context.job.id, {
      library: context.library,
      worker: async ({ signal }) => {
        entered.resolve(signal);
        return release.promise;
      },
    })
    .catch((error: unknown) => error);
  const signal = await entered.promise;
  const root = join(context.options.stateRoot, "alignment-jobs");
  const saved = `${root}-storage-fault`;
  await rename(root, saved);
  try {
    await writeFile(root, "unavailable storage");
    await expect(context.jobs.cancel(context.job.id)).rejects.toBeInstanceOf(Error);
    expect(signal.aborted).toBe(true);
  } finally {
    await rm(root, { force: true });
    await rename(saved, root);
    release.resolve(context.output);
  }
  expect(await execution).toBeInstanceOf(Error);
  expect(
    (await context.library.getSnapshot(context.original.id))!.project.lyricsAlignments,
  ).toEqual(context.original.lyricsAlignments);
});

it("rejects an invalid worker result without a partial Alignment and permits only explicit retry", async () => {
  const context = await runnableJob();
  await expect(
    context.jobs.run(context.job.id, {
      library: context.library,
      worker: async () => ({ ...context.output, words: context.output.words.slice(1) }),
    }),
  ).rejects.toThrow("identity");
  expect(
    (await context.library.getSnapshot(context.original.id))!.project.lyricsAlignments,
  ).toEqual(context.original.lyricsAlignments);
  expect(await context.jobs.get(context.job.id)).toMatchObject({
    state: "blocked",
    failure: "integrity",
    circuitOpen: true,
  });
  expect(await context.jobs.confirm(context.job.id)).toMatchObject({
    state: "blocked",
    blockedReasons: ["runtime_failure"],
  });
  const reopened = await openAlignmentJobs(context.options);
  expect(await reopened.get(context.job.id)).toMatchObject({
    state: "awaiting_confirmation",
    circuitOpen: false,
  });
  await reopened.confirm(context.job.id);
  expect(
    await reopened.run(context.job.id, {
      library: context.library,
      worker: async () => context.output,
    }),
  ).toMatchObject({ state: "succeeded" });
});

it("keeps publication failures retryable without blaming the runtime", async () => {
  const context = await runnableJob();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await expect(
      context.jobs.run(context.job.id, {
        library: context.library,
        worker: async () => {
          await context.library.trashProject(context.original.id);
          return context.output;
        },
      }),
    ).rejects.toThrow("Project unavailable");
    expect(await context.jobs.get(context.job.id)).toMatchObject({
      state: "retryable",
      failure: "storage",
      circuitOpen: false,
    });
    await context.library.restoreTrashedProject(context.original.id);
    await context.jobs.confirm(context.job.id);
  }
  expect(
    await context.jobs.run(context.job.id, {
      library: context.library,
      worker: async () => context.output,
    }),
  ).toMatchObject({ state: "succeeded" });
});

it("requires confirmation for queued work after reopening and keeps different audio requests independent", async () => {
  const context = await runnableJob();
  const second = await context.jobs.request({
    ...context.request,
    canonicalAudioFingerprint: `sha256:${"e".repeat(64)}`,
  });
  expect(second.id).not.toBe(context.job.id);
  const reopened = await openAlignmentJobs(context.options);
  expect(await reopened.get(context.job.id)).toMatchObject({ state: "awaiting_confirmation" });
  await expect(
    reopened.run(context.job.id, { library: context.library, worker: async () => context.output }),
  ).rejects.toThrow("not runnable");
  expect(await reopened.confirm(context.job.id)).toMatchObject({
    state: "queued",
    key: context.job.key,
  });
});

it("fails closed before reading media when the native Alignment runtime cannot be verified", async () => {
  const context = await runnableJob();
  const worker = createContainedAlignmentWorker({
    stateRoot: context.options.stateRoot,
    runtimeRoot: join(context.options.stateRoot, "missing-runtime"),
    runtimeManifestHash: "a".repeat(64),
    containmentRoot: join(context.options.stateRoot, "missing-containment"),
    containmentManifestHash: "b".repeat(64),
    modelStore: context.options.modelStore,
    media: new LocalMediaService({ library: context.library, pickFile: async () => null }),
  });
  await expect(
    context.jobs.run(context.job.id, { library: context.library, worker }),
  ).rejects.toThrow("integrity");
  expect(
    (await context.library.getSnapshot(context.original.id))!.project.lyricsAlignments,
  ).toEqual(context.original.lyricsAlignments);
});

it("keeps user anchors in edit history and changes the immutable Recipe without changing lyrics or raw timing", async () => {
  const context = await runnableJob();
  const before = (await context.library.getSnapshot(context.original.id))!;
  const document = before.project.lyricsDocuments.at(-1)!;
  const anchor = {
    id: "anchor_first_line",
    lyricsDocumentId: document.id,
    analysisRevisionId: before.project.activeView!.analysisRevisionId,
    firstTokenId: document.tokens[0]!.id,
    lastTokenId: document.tokens[1]!.id,
    startSample: 12000,
    endSample: 24000,
  };
  await expect(
    context.library.commitEditTransaction({
      projectId: context.original.id,
      expectedProjectRevisionId: before.projectRevisionId,
      transaction: {
        id: "transaction_invalid_anchor",
        parentTransactionId: null,
        operations: [{ type: "set_lyrics_anchor", anchor: { ...anchor, id: "invalid" } }],
      },
    }),
  ).rejects.toMatchObject({ name: "ZodError" });
  await context.library.commitEditTransaction({
    projectId: context.original.id,
    expectedProjectRevisionId: before.projectRevisionId,
    transaction: {
      id: "transaction_anchor",
      parentTransactionId: null,
      operations: [{ type: "set_lyrics_anchor", anchor }],
    },
  });
  const saved = (await context.library.getSnapshot(context.original.id))!;
  const anchored = await context.jobs.request({ ...context.request, project: saved.project });
  expect(anchored.recipe.anchors).toEqual([anchor]);
  expect(anchored.key).not.toBe(context.job.key);
  expect(saved.project.lyricsDocuments).toEqual(before.project.lyricsDocuments);
  expect(saved.project.lyricsAlignments).toEqual(before.project.lyricsAlignments);
  await expect(
    context.jobs.run(anchored.id, {
      library: context.library,
      worker: async () => ({
        ...context.output,
        recipeHash: anchored.key,
        words: [
          { tokenId: document.tokens[0]!.id, startSample: 0, endSample: 6000 },
          ...context.output.words.slice(1),
        ],
      }),
    }),
  ).rejects.toThrow("Anchor");
  await context.library.changeEditHistory({
    projectId: context.original.id,
    expectedProjectRevisionId: saved.projectRevisionId,
    action: { type: "undo" },
  });
  const undone = (await context.library.getSnapshot(context.original.id))!;
  expect((await context.jobs.request({ ...context.request, project: undone.project })).key).toBe(
    context.job.key,
  );
});

it("rejects conflicting scoped anchors without committing a Project mutation", async () => {
  const context = await runnableJob();
  const before = (await context.library.getSnapshot(context.original.id))!;
  const document = before.project.lyricsDocuments.at(-1)!;
  const anchor = {
    id: "anchor_one",
    lyricsDocumentId: document.id,
    analysisRevisionId: before.project.activeView!.analysisRevisionId,
    firstTokenId: document.tokens[0]!.id,
    lastTokenId: document.tokens[1]!.id,
    startSample: 0,
    endSample: 30000,
  };
  await expect(
    context.library.commitEditTransaction({
      projectId: context.original.id,
      expectedProjectRevisionId: before.projectRevisionId,
      transaction: {
        id: "transaction_conflict",
        parentTransactionId: null,
        operations: [
          { type: "set_lyrics_anchor", anchor },
          {
            type: "set_lyrics_anchor",
            anchor: {
              ...anchor,
              id: "anchor_two",
              firstTokenId: document.tokens[2]!.id,
              lastTokenId: document.tokens[3]!.id,
              startSample: 20000,
              endSample: 40000,
            },
          },
        ],
      },
    }),
  ).rejects.toThrow("Anchor");
  expect(await context.library.getSnapshot(context.original.id)).toEqual(before);
});

it("migrates existing 1.2 Projects before storing Alignment provenance and anchor edits", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "open-chords-alignment-migration-"));
  roots.push(stateRoot);
  const envelope = JSON.parse(
    readFileSync(
      new URL("../packages/testkit/contracts/v1/valid/project-envelope.json", import.meta.url),
      "utf8",
    ),
  );
  envelope.schemaVersion = "1.2";
  envelope.payload.schemaVersion = "1.2";
  const older = await openProjectLibrary({ stateRoot, currentSchemaVersion: "1.2" });
  await older.createProject({ envelope, records: goldenRecords() });
  const current = await openProjectLibrary({ stateRoot });
  const saved = await current.readProject(envelope.payload.id);
  expect(saved.envelope.schemaVersion).toBe("1.3");
  expect(saved.envelope.payload.lyricsDocuments).toEqual(envelope.payload.lyricsDocuments);
  expect(saved.envelope.payload.lyricsAlignments).toEqual(envelope.payload.lyricsAlignments);
  expect(saved.revisions.map((item) => item.reason)).toEqual(["created", "migration"]);
  expect(
    (
      await (
        await openProjectLibrary({ stateRoot, currentSchemaVersion: "1.2" })
      ).readProject(envelope.payload.id)
    ).compatibility,
  ).toBe("read_only");
});

it("starts and cancels through named desktop capabilities without accepting paths or changing Reference Lyrics", async () => {
  const { openAlignmentService } = await import("../apps/desktop/src/main/alignment-service.ts");
  const { DesktopCommandGateway } =
    await import("../apps/desktop/src/main/desktop-command-gateway.ts");
  const context = await runnableJob();
  const started = Promise.withResolvers<void>();
  const service = await openAlignmentService({
    ...context.options,
    library: context.library,
    media: new LocalMediaService({ library: context.library, pickFile: async () => null }),
    worker: (input) =>
      new Promise((resolve) => {
        started.resolve();
        input.signal.addEventListener(
          "abort",
          () => resolve({ ...context.output, recipeHash: input.recipeHash }),
          { once: true },
        );
      }),
  });
  const gateway = new DesktopCommandGateway(
    context.library,
    undefined,
    undefined,
    undefined,
    service,
  );
  const sender = {
    frameUrl: "open-chords://app/index.html",
    generationId: "generation_alignment",
    isMainFrame: true,
    senderId: 1,
    security: {
      contextIsolation: true,
      nodeIntegration: false,
      persistentSession: false,
      sandbox: true,
      webSecurity: true,
    },
  } as const;
  const command = {
    protocol: "open-chords/desktop-ipc",
    protocolVersion: "1.0",
    generationId: sender.generationId,
    requestId: "request_alignment",
    type: "alignment.perform",
  };
  const snapshot = (await context.library.getSnapshot(context.original.id))!;
  try {
    const poll = gateway.execute(
      { ...command, action: { type: "status", projectId: context.original.id } },
      sender,
    );
    const result = await gateway.execute(
      {
        ...command,
        action: {
          type: "start",
          projectId: context.original.id,
          expectedProjectRevisionId: snapshot.projectRevisionId,
        },
      },
      sender,
    );
    expect(result.response).toMatchObject({ type: "alignment.result" });
    expect((await poll).response).toMatchObject({ type: "alignment.result" });
    expect(
      (
        await gateway.execute(
          { ...command, action: { type: "status", projectId: "invalid" } },
          sender,
        )
      ).response,
    ).toMatchObject({ code: "invalid_command" });
    await started.promise;
    expect(
      (
        await gateway.execute(
          { ...command, action: { type: "status", projectId: context.original.id } },
          sender,
        )
      ).response,
    ).toMatchObject({ jobs: [{ state: "running" }] });
    expect(
      (
        await gateway.execute(
          {
            ...command,
            action: {
              type: "start",
              projectId: context.original.id,
              expectedProjectRevisionId: snapshot.projectRevisionId,
              executablePath: "/arbitrary/tool",
            },
          },
          sender,
        )
      ).response,
    ).toMatchObject({ code: "invalid_command" });
    const concurrentPoll = gateway.execute(
      { ...command, action: { type: "status", projectId: context.original.id } },
      sender,
    );
    expect(
      (
        await gateway.execute(
          {
            ...command,
            action: { type: "cancel", projectId: context.original.id, jobId: context.job.id },
          },
          sender,
        )
      ).response,
    ).toMatchObject({ jobs: [{ state: "cancelled" }] });
    expect((await concurrentPoll).response).toMatchObject({ type: "alignment.result" });
  } finally {
    await service.dispose();
  }
  expect((await context.library.getSnapshot(context.original.id))!.project.lyricsDocuments).toEqual(
    context.original.lyricsDocuments,
  );
});

it("waits for worker teardown on shutdown even when interruption state cannot be persisted", async () => {
  const { openAlignmentService } = await import("../apps/desktop/src/main/alignment-service.ts");
  const context = await runnableJob();
  const entered = Promise.withResolvers<void>();
  const aborted = Promise.withResolvers<void>();
  const cleanup = Promise.withResolvers<void>();
  const service = await openAlignmentService({
    ...context.options,
    library: context.library,
    media: new LocalMediaService({ library: context.library, pickFile: async () => null }),
    worker: async (input) => {
      entered.resolve();
      input.signal.addEventListener("abort", () => aborted.resolve(), { once: true });
      await cleanup.promise;
      return { ...context.output, recipeHash: input.recipeHash };
    },
  });
  const snapshot = (await context.library.getSnapshot(context.original.id))!;
  await service.perform({
    type: "start",
    projectId: context.original.id,
    expectedProjectRevisionId: snapshot.projectRevisionId,
  });
  await entered.promise;
  const root = join(context.options.stateRoot, "alignment-jobs");
  const saved = `${root}-shutdown-fault`;
  await rename(root, saved);
  await writeFile(root, "unavailable storage");
  let settled = false;
  const disposal = service.dispose().then(
    () => {
      settled = true;
      return null;
    },
    (error: unknown) => {
      settled = true;
      return error;
    },
  );
  try {
    await aborted.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
  } finally {
    await rm(root);
    await rename(saved, root);
    cleanup.resolve();
    expect(await disposal).toBeInstanceOf(Error);
  }
  expect(
    (await context.library.getSnapshot(context.original.id))!.project.lyricsAlignments,
  ).toEqual(context.original.lyricsAlignments);
});

it("serializes CPU-heavy Alignment execution across Projects and cancels queued work without starting a worker", async () => {
  const first = await runnableJob();
  const second = await runnableJob();
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<unknown>();
  let secondEntered = false;
  const active = first.jobs.run(first.job.id, {
    library: first.library,
    worker: async () => {
      started.resolve();
      return release.promise;
    },
  });
  await started.promise;
  const waiting = second.jobs
    .run(second.job.id, {
      library: second.library,
      worker: async () => {
        secondEntered = true;
        return second.output;
      },
    })
    .then(
      () => null,
      (error: unknown) => error,
    );
  try {
    await expect
      .poll(async () => (await second.jobs.get(second.job.id))?.stage)
      .toBe("waiting_for_cpu");
    expect(secondEntered).toBe(false);
    await second.jobs.cancel(second.job.id);
    expect(await waiting).toBeInstanceOf(Error);
    expect(secondEntered).toBe(false);
  } finally {
    release.resolve(first.output);
    await active;
  }
});

it("reconciles an already published result after a crash without executing the worker again", async () => {
  const context = await runnableJob();
  const completed = await context.jobs.run(context.job.id, {
    library: context.library,
    worker: async () => context.output,
  });
  const path = join(context.options.stateRoot, "alignment-jobs/state.json");
  const saved = JSON.parse(await readFile(path, "utf8"));
  saved[0].state = "running";
  delete saved[0].alignmentId;
  await writeFile(path, JSON.stringify(saved));
  const recovered = await openAlignmentJobs(context.options);
  await recovered.confirm(context.job.id);
  let executed = false;
  expect(
    await recovered.run(context.job.id, {
      library: context.library,
      worker: async () => {
        executed = true;
        throw new Error("Must not run again");
      },
    }),
  ).toMatchObject({ state: "succeeded", alignmentId: completed.alignmentId });
  expect(executed).toBe(false);
});

it("invalidates an active session on system interruption and rejects its late output", async () => {
  const context = await runnableJob();
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<unknown>();
  let workerAborted = false;
  const execution = context.jobs
    .run(context.job.id, {
      library: context.library,
      worker: async ({ signal }) => {
        entered.resolve();
        await finish.promise;
        workerAborted = signal.aborted;
        return context.output;
      },
    })
    .catch((error: unknown) => error);
  await entered.promise;
  await context.jobs.interrupt();
  finish.resolve(undefined);
  expect(await execution).toBeInstanceOf(Error);
  expect(workerAborted).toBe(true);
  expect(await context.jobs.get(context.job.id)).toMatchObject({
    state: "retryable",
    failure: "interrupted",
  });
  expect(
    (await context.library.getSnapshot(context.original.id))!.project.lyricsAlignments,
  ).toEqual(context.original.lyricsAlignments);
});

it("opens a runtime circuit for malformed sessions and repeated worker failures", async () => {
  const { SidecarSessionError } = await import("../apps/desktop/src/main/sidecar-session.ts");
  const context = await runnableJob();
  for (let attempt = 0; attempt < 3; attempt++) {
    await expect(
      context.jobs.run(context.job.id, {
        library: context.library,
        worker: async () => {
          throw new SidecarSessionError("heartbeat_timeout", "No heartbeat");
        },
      }),
    ).rejects.toBeInstanceOf(SidecarSessionError);
    if (attempt < 2) await context.jobs.confirm(context.job.id);
  }
  expect(await context.jobs.confirm(context.job.id)).toMatchObject({
    state: "blocked",
    circuitOpen: true,
    failureCount: 3,
  });
  const restarted = await openAlignmentJobs(context.options);
  await restarted.confirm(context.job.id);
  await expect(
    restarted.run(context.job.id, {
      library: context.library,
      worker: async () => {
        throw new SidecarSessionError("protocol_violation", "Invalid session identity");
      },
    }),
  ).rejects.toBeInstanceOf(SidecarSessionError);
  expect(await restarted.get(context.job.id)).toMatchObject({
    state: "blocked",
    failure: "protocol",
    circuitOpen: true,
  });
});

it("retains cancellation and blocks other runtimes after unconfirmed teardown", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const context = await runnableJob();
  const script = `
    import assert from "node:assert/strict";
    import { openAlignmentJobs } from "./apps/desktop/src/main/alignment-jobs.ts";
    import { openModelStore } from "./apps/desktop/src/main/model-store.ts";
    import { openProjectLibrary } from "./apps/desktop/src/main/project-library.ts";
    import { CpuWorkCleanupFailure } from "./apps/desktop/src/main/cpu-work.ts";
    const input = JSON.parse(process.argv[1]);
    const modelStore = await openModelStore({ stateRoot: input.stateRoot, packs: input.packs, runtime: input.packs[0].runtime });
    const library = await openProjectLibrary({ stateRoot: input.stateRoot });
    const options = { stateRoot: input.stateRoot, packs: input.packs, modelStore, runtimeManifestHash: "a".repeat(64) };
    const jobs = await openAlignmentJobs(options);
    await jobs.confirm(input.jobId);
    const entered = Promise.withResolvers();
    const finish = Promise.withResolvers();
    const execution = jobs.run(input.jobId, { library, worker: async () => { entered.resolve(); await finish.promise; throw new CpuWorkCleanupFailure(); } }).catch(error => error);
    await entered.promise;
    await jobs.cancel(input.jobId);
    finish.resolve();
    assert(await execution instanceof CpuWorkCleanupFailure);
    const cancelled = await jobs.get(input.jobId);
    assert.equal(cancelled.state, "cancelled");
    assert.equal(cancelled.failure, "cleanup");
    assert.equal(cancelled.circuitOpen, true);
    const other = await openAlignmentJobs({ ...options, runtimeManifestHash: "b".repeat(64) });
    const next = await other.request(input.request);
    let executed = false;
    await assert.rejects(other.run(next.id, { library, worker: async () => { executed = true; return {}; } }), CpuWorkCleanupFailure);
    assert.equal(executed, false);
    process.stdout.write("cancelled;other-runtime-blocked");
  `;
  const result = await promisify(execFile)(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      script,
      JSON.stringify({
        stateRoot: context.options.stateRoot,
        packs: context.options.packs,
        jobId: context.job.id,
        request: context.request,
      }),
    ],
    { cwd: new URL("..", import.meta.url), timeout: 15000 },
  );
  expect(result.stdout).toBe("cancelled;other-runtime-blocked");
});

it("keeps exact requests blocked and lyrics untimed when the required pack is absent, including after reopen", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "open-chords-alignment-"));
  roots.push(stateRoot);
  const store = await openModelStore({ stateRoot, packs: ALIGNMENT_PACKS, runtime: "mfa-3.4.1" });
  const options = {
    stateRoot,
    modelStore: store,
    packs: ALIGNMENT_PACKS,
    runtimeManifestHash: "a".repeat(64),
  };
  const jobs = await openAlignmentJobs(options);
  const original = project();
  const request = {
    project: original,
    lyricsDocumentId: "lyrics_alignment_test",
    analysisRevisionId: original.activeView!.analysisRevisionId,
    canonicalAudioFingerprint: `sha256:${"d".repeat(64)}`,
  };
  const job = await jobs.request(request);
  expect(job).toMatchObject({ state: "blocked", blockedReasons: ["missing_pack"] });
  expect(job.recipe).toMatchObject({
    lyricsDocumentId: "lyrics_alignment_test",
    canonicalAudioFingerprint: request.canonicalAudioFingerprint,
    packId: "english_mfa-3.1.0",
    runtimeId: "mfa-3.4.1",
  });
  expect(await jobs.request(request)).toEqual(job);
  const reopened = await openAlignmentJobs(options);
  expect(await reopened.get(job.id)).toEqual(job);
  expect(original).toEqual(project());
  expect(
    original.lyricsAlignments
      .at(-1)!
      .occurrences.every(({ timing }) => timing.state === "unmatched"),
  ).toBe(true);
});

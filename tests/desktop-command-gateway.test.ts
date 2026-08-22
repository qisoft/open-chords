import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parseProjectContract } from "@open-chords/domain";
import { describe, expect, it } from "vitest";

import {
  DesktopCommandGateway,
  type LocalMediaAuthority,
  type ProjectAuthority,
} from "../apps/desktop/src/main/desktop-command-gateway.ts";

const sender = {
  frameUrl: "open-chords://app/index.html",
  generationId: "generation_fixture",
  isMainFrame: true,
  senderId: 7,
  security: {
    contextIsolation: true,
    nodeIntegration: false,
    persistentSession: false,
    sandbox: true,
    webSecurity: true,
  },
} as const;

const fixturePath = join(
  import.meta.dirname,
  "../packages/testkit/contracts/v1/valid/project-envelope.json",
);

function readGoldenProject() {
  const envelope: unknown = JSON.parse(readFileSync(fixturePath, "utf8"));
  if (typeof envelope !== "object" || envelope === null || !("payload" in envelope)) {
    throw new Error("Golden Project envelope is missing its payload");
  }
  return parseProjectContract(envelope.payload);
}

function commandEnvelope(requestId: string) {
  return {
    generationId: sender.generationId,
    protocol: "open-chords/desktop-ipc",
    protocolVersion: "1.0",
    requestId,
  } as const;
}

function shellCommand(requestId = "request_security") {
  return {
    ...commandEnvelope(requestId),
    runtimeSecurity: {
      contextIsolation: true,
      sandbox: true,
    },
    type: "shell.get_security_snapshot",
  } as const;
}

function mutationCommand({
  expectedProjectRevisionId = "projectrevision_current",
  projectId = "project_fixture",
  requestId,
  transactionId,
}: {
  expectedProjectRevisionId?: string;
  projectId?: string;
  requestId: string;
  transactionId: string;
}) {
  return {
    ...commandEnvelope(requestId),
    expectedProjectRevisionId,
    projectId,
    transaction: {
      id: transactionId,
      operations: [
        { eventId: "chord_fixture", type: "replace_chord_value", value: { kind: "no_chord" } },
      ],
      parentTransactionId: null,
    },
    type: "project.commit_edit_transaction",
  } as const;
}

function createAuthority(overrides: Partial<ProjectAuthority> = {}): ProjectAuthority {
  return {
    commitEditTransaction: async () => ({ projectRevisionId: "projectrevision_next" }),
    getSnapshot: async () => null,
    listProjects: () => [],
    ...overrides,
  };
}

function createMediaAuthority(overrides: Partial<LocalMediaAuthority> = {}): LocalMediaAuthority {
  return {
    createProject: async () => ({
      projectId: "project_media",
      projectRevisionId: "projectrevision_11111111111111111111111111111111",
      sourceId: "source_media",
    }),
    openPlayback: async ({ projectId }) => ({
      byteSize: 1_024,
      capabilityId: "playbackcapability_11111111111141118111111111111111",
      endSourceSample: 48_000,
      kind: "ready",
      mimeType: "audio/wav",
      playbackUrl: "open-chords://app/media/playbackcapability_11111111111141118111111111111111",
      projectId,
      sampleRate: 48_000,
      startSourceSample: 0,
    }),
    pickLocalFile: async () => ({
      byteSize: 1_024,
      capabilityId: "mediacapability_11111111111141118111111111111111",
      durationSamples: 48_000,
      kind: "selected",
      mimeType: "audio/wav",
      sampleRate: 48_000,
    }),
    relinkSource: async ({ sourceId }) => ({ kind: "relinked", sourceId }),
    ...overrides,
  };
}

describe("DesktopCommandGateway", () => {
  it("lists only active readable Projects through a bounded renderer capability", async () => {
    const gateway = new DesktopCommandGateway(
      createAuthority({
        listProjects: () => [
          {
            compatibility: "writable",
            projectId: "project_alpha",
            projectRevisionId: "projectrevision_alpha",
            status: "active",
          },
          { projectId: "project_damaged", status: "damaged" },
          {
            compatibility: "writable",
            projectId: "project_trashed",
            projectRevisionId: "projectrevision_trashed",
            status: "trashed",
          },
        ],
      }),
    );

    const result = await gateway.execute(
      { ...commandEnvelope("request_project_list"), type: "project.list" },
      sender,
      "project.list",
    );

    expect(result.response).toMatchObject({
      projects: [
        {
          compatibility: "writable",
          projectId: "project_alpha",
          projectRevisionId: "projectrevision_alpha",
        },
      ],
      type: "project.list",
    });
  });

  it("deterministically bounds a Project listing at the response contract limit", async () => {
    const gateway = new DesktopCommandGateway(
      createAuthority({
        listProjects: () =>
          Array.from({ length: 10_001 }, (_, index) => {
            const suffix = String(10_000 - index).padStart(5, "0");
            return {
              compatibility: "writable" as const,
              projectId: `project_${suffix}`,
              projectRevisionId: `projectrevision_${suffix}`,
              status: "active" as const,
            };
          }),
      }),
    );

    const result = await gateway.execute(
      { ...commandEnvelope("request_bounded_project_list"), type: "project.list" },
      sender,
      "project.list",
    );

    expect(result.response).toMatchObject({ type: "project.list" });
    if (result.response.type !== "project.list") throw new Error("Project listing failed");
    expect(result.response.projects).toHaveLength(10_000);
    expect(result.response.projects[0]?.projectId).toBe("project_00000");
    expect(result.response.projects.at(-1)?.projectId).toBe("project_09999");
  });

  it("returns only an opaque media capability and rejects renderer-supplied paths", async () => {
    let pickerCalls = 0;
    const gateway = new DesktopCommandGateway(
      createAuthority(),
      createMediaAuthority({
        pickLocalFile: async () => {
          pickerCalls += 1;
          return {
            byteSize: 1_024,
            capabilityId: "mediacapability_11111111111141118111111111111111",
            durationSamples: 48_000,
            kind: "selected",
            mimeType: "audio/wav",
            sampleRate: 48_000,
          };
        },
      }),
    );
    const command = {
      ...commandEnvelope("request_media"),
      type: "media.pick_local_file",
    } as const;

    const result = await gateway.execute(command, sender, "media.pick_local_file");
    expect(result.response).toMatchObject({
      capabilityId: expect.stringMatching(/^mediacapability_/),
      type: "media.selected",
    });
    expect(JSON.stringify(result.response)).not.toMatch(/path|directory/i);
    expect(pickerCalls).toBe(1);

    const hostile = await gateway.execute(
      { ...command, path: "/private/recording.wav" },
      sender,
      "media.pick_local_file",
    );
    expect(hostile.response).toMatchObject({ code: "invalid_command", type: "desktop.error" });
    expect(pickerCalls).toBe(1);
  });

  it("allows only one active local media operation and releases the slot", async () => {
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let pickerCalls = 0;
    const gateway = new DesktopCommandGateway(
      createAuthority(),
      createMediaAuthority({
        pickLocalFile: async () => {
          pickerCalls += 1;
          if (pickerCalls === 1) await firstBlocked;
          return {
            byteSize: 1_024,
            capabilityId: "mediacapability_11111111111141118111111111111111",
            durationSamples: 48_000,
            kind: "selected",
            mimeType: "audio/wav",
            sampleRate: 48_000,
          };
        },
      }),
    );
    const mediaCommand = (requestId: string) => ({
      ...commandEnvelope(requestId),
      type: "media.pick_local_file" as const,
    });

    const first = gateway.execute(mediaCommand("request_media_first"), sender);
    await Promise.resolve();
    const overflow = await gateway.execute(mediaCommand("request_media_overflow"), sender);
    expect(overflow.response).toMatchObject({ code: "busy", retryable: true });
    expect(pickerCalls).toBe(1);

    releaseFirst();
    expect((await first).response).toMatchObject({ type: "media.selected" });
    expect(
      (await gateway.execute(mediaCommand("request_media_after_release"), sender)).response,
    ).toMatchObject({ type: "media.selected" });
    expect(pickerCalls).toBe(2);
  });

  it("destroys hostile frames before parsing their command", async () => {
    const gateway = new DesktopCommandGateway(createAuthority());
    const result = await gateway.execute(shellCommand(), {
      ...sender,
      frameUrl: "open-chords://app/hostile.html",
      isMainFrame: false,
    });

    expect(result.action).toBe("destroy_sender");
    expect(result.response).toMatchObject({
      code: "unauthorized_sender",
      generationId: null,
      requestId: null,
      type: "desktop.error",
    });
  });

  it("bounds messages and reloads a generation after repeated invalid commands", async () => {
    const gateway = new DesktopCommandGateway(createAuthority());
    const oversized = { ...shellCommand(), padding: "x".repeat(256 * 1024) };

    expect((await gateway.execute(oversized, sender)).response).toMatchObject({
      code: "invalid_command",
      generationId: sender.generationId,
      requestId: "request_security",
    });
    expect((await gateway.execute({ ...shellCommand(), unknown: true }, sender)).action).toBe(
      "none",
    );
    expect(
      (await gateway.execute(shellCommand("request_valid_between_attacks"), sender)).action,
    ).toBe("none");
    expect((await gateway.execute({ ...shellCommand(), unknown: true }, sender)).action).toBe(
      "reload_generation",
    );
    expect((await gateway.execute({ ...shellCommand(), unknown: true }, sender)).action).toBe(
      "none",
    );
  });

  it("rejects commands sent over a different capability channel without losing correlation", async () => {
    const gateway = new DesktopCommandGateway(createAuthority());
    const result = await gateway.execute(
      shellCommand("request_wrong_channel"),
      sender,
      "project.get_snapshot",
    );

    expect(result.response).toMatchObject({
      code: "invalid_command",
      generationId: sender.generationId,
      requestId: "request_wrong_channel",
    });
  });

  it("rejects a stale renderer generation", async () => {
    const gateway = new DesktopCommandGateway(createAuthority());
    const result = await gateway.execute(
      { ...shellCommand(), generationId: "generation_stale" },
      sender,
    );

    expect(result.action).toBe("reload_generation");
    expect(result.response).toMatchObject({ code: "invalid_generation" });
  });

  it("destroys a renderer whose effective security configuration is weaker", async () => {
    const gateway = new DesktopCommandGateway(createAuthority());
    const sandboxedResult = await gateway.execute(shellCommand(), {
      ...sender,
      security: { ...sender.security, sandbox: false },
    });

    expect(sandboxedResult.action).toBe("destroy_sender");
    expect(sandboxedResult.response).toMatchObject({ code: "unauthorized_sender" });

    const persistentResult = await gateway.execute(shellCommand(), {
      ...sender,
      security: { ...sender.security, persistentSession: true },
    });

    expect(persistentResult.action).toBe("destroy_sender");
    expect(persistentResult.response).toMatchObject({ code: "unauthorized_sender" });
  });

  it("rejects snapshots for a different Project before crossing IPC", async () => {
    const project = { ...readGoldenProject(), id: "project_other" };
    const authority = createAuthority({
      getSnapshot: async () => ({
        eventSequence: 1,
        project,
        projectRevisionId: "projectrevision_fixture",
      }),
    });
    const gateway = new DesktopCommandGateway(authority);

    const result = await gateway.execute(
      {
        ...commandEnvelope("request_wrong_project"),
        projectId: "project_fixture",
        type: "project.get_snapshot",
      },
      sender,
    );

    expect(result.response).toMatchObject({ code: "internal_error", type: "desktop.error" });
  });

  it("reports a newer Project schema as read-only instead of a generic failure", async () => {
    const gateway = new DesktopCommandGateway(
      createAuthority({ commitEditTransaction: async () => ({ readOnly: true }) }),
    );
    const result = await gateway.execute(
      mutationCommand({ requestId: "request_read_only", transactionId: "transaction_read_only" }),
      sender,
    );

    expect(result.response).toMatchObject({ code: "project_read_only", retryable: false });
  });

  it("revalidates full Project invariants before returning a snapshot", async () => {
    const project = structuredClone(readGoldenProject());
    project.analysisRevisions[0]!.timeline.chordEvents[0]!.endSample += 1;
    const authority = createAuthority({
      getSnapshot: async () => ({
        eventSequence: 1,
        project,
        projectRevisionId: "projectrevision_fixture",
      }),
    });
    const gateway = new DesktopCommandGateway(authority);

    const result = await gateway.execute(
      {
        ...commandEnvelope("request_invalid_project"),
        projectId: project.id,
        type: "project.get_snapshot",
      },
      sender,
    );

    expect(result.response).toMatchObject({ code: "internal_error", type: "desktop.error" });
  });

  it("rejects an oversized snapshot before returning it over IPC", async () => {
    const project = structuredClone(readGoldenProject());
    project.extensions["org.openchords.oversized"] = "x".repeat(17 * 1024 * 1024);
    const authority = createAuthority({
      getSnapshot: async () => ({
        eventSequence: 1,
        project,
        projectRevisionId: "projectrevision_fixture",
      }),
    });
    const gateway = new DesktopCommandGateway(authority);

    const result = await gateway.execute(
      {
        ...commandEnvelope("request_oversized_project"),
        projectId: project.id,
        type: "project.get_snapshot",
      },
      sender,
    );

    expect(result.response).toMatchObject({ code: "internal_error", type: "desktop.error" });
  });

  it("caps concurrent reads at 32", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gateway = new DesktopCommandGateway(
      createAuthority({
        getSnapshot: async () => {
          await blocked;
          return null;
        },
      }),
    );
    const reads = Array.from({ length: 32 }, (_, index) =>
      gateway.execute(
        {
          ...commandEnvelope(`request_read_${String(index)}`),
          projectId: "project_fixture",
          type: "project.get_snapshot",
        },
        sender,
      ),
    );
    await Promise.resolve();

    const overflow = await gateway.execute(
      {
        ...commandEnvelope("request_read_overflow"),
        projectId: "project_fixture",
        type: "project.get_snapshot",
      },
      sender,
    );
    expect(overflow.response).toMatchObject({ code: "busy", retryable: true });

    release();
    await Promise.all(reads);
  });

  it("serializes mutations per project and delegates the atomic revision check", async () => {
    const starts: string[] = [];
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const gateway = new DesktopCommandGateway(
      createAuthority({
        commitEditTransaction: async ({ expectedProjectRevisionId, transaction }) => {
          starts.push(expectedProjectRevisionId);
          if (transaction.id === "transaction_first") await firstBlocked;
          return transaction.id === "transaction_stale"
            ? { stale: true as const }
            : { projectRevisionId: "projectrevision_next" };
        },
      }),
    );
    const mutation = (transactionId: string, expectedProjectRevisionId: string) =>
      mutationCommand({
        expectedProjectRevisionId,
        requestId: `request_${transactionId}`,
        transactionId,
      });

    const first = gateway.execute(mutation("transaction_first", "projectrevision_a"), sender);
    const second = gateway.execute(mutation("transaction_stale", "projectrevision_b"), sender);
    await Promise.resolve();
    await Promise.resolve();
    expect(starts).toEqual(["projectrevision_a"]);
    releaseFirst();

    expect((await first).response).toMatchObject({ type: "project.committed" });
    expect((await second).response).toMatchObject({ code: "stale_revision" });
    expect(starts).toEqual(["projectrevision_a", "projectrevision_b"]);
  });

  it("bounds each project mutation queue", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gateway = new DesktopCommandGateway(
      createAuthority({
        commitEditTransaction: async () => {
          await blocked;
          return { projectRevisionId: "projectrevision_next" };
        },
      }),
    );
    const mutation = (index: number) =>
      mutationCommand({
        requestId: `request_mutation_${String(index)}`,
        transactionId: `transaction_${String(index)}`,
      });
    const accepted = Array.from({ length: 32 }, (_, index) =>
      gateway.execute(mutation(index), sender),
    );

    const overflow = await gateway.execute(mutation(32), sender);
    expect(overflow.response).toMatchObject({ code: "busy", retryable: true });

    release();
    await Promise.all(accepted);
  });

  it("bounds pending mutations across distinct Project IDs", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gateway = new DesktopCommandGateway(
      createAuthority({
        commitEditTransaction: async ({ transaction }) => {
          if (transaction.id !== "transaction_overflow") await blocked;
          return { projectRevisionId: "projectrevision_next" };
        },
      }),
    );
    const mutation = (index: number | "overflow") =>
      mutationCommand({
        projectId: `project_${String(index)}`,
        requestId: `request_mutation_global_${String(index)}`,
        transactionId: `transaction_${String(index)}`,
      });
    const accepted = Array.from({ length: 32 }, (_, index) =>
      gateway.execute(mutation(index), sender),
    );

    const overflow = await gateway.execute(mutation("overflow"), sender);
    expect(overflow.response).toMatchObject({ code: "busy", retryable: true });

    release();
    await Promise.all(accepted);
  });
});

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parseProjectContract } from "@open-chords/domain";
import { describe, expect, it } from "vitest";

import {
  DesktopCommandGateway,
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

function shellCommand(requestId = "request_security") {
  return {
    generationId: sender.generationId,
    protocol: "open-chords/desktop-ipc",
    protocolVersion: "1.0",
    requestId,
    type: "shell.get_security_snapshot",
  } as const;
}

function createAuthority(overrides: Partial<ProjectAuthority> = {}): ProjectAuthority {
  return {
    commitEditTransaction: async () => ({ projectRevisionId: "projectrevision_next" }),
    getSnapshot: async () => null,
    ...overrides,
  };
}

describe("DesktopCommandGateway", () => {
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
    const result = await gateway.execute(shellCommand(), {
      ...sender,
      security: { ...sender.security, sandbox: false },
    });

    expect(result.action).toBe("destroy_sender");
    expect(result.response).toMatchObject({ code: "unauthorized_sender" });
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
        ...shellCommand("request_wrong_project"),
        projectId: "project_fixture",
        type: "project.get_snapshot",
      },
      sender,
    );

    expect(result.response).toMatchObject({ code: "internal_error", type: "desktop.error" });
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
        ...shellCommand("request_invalid_project"),
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
        ...shellCommand("request_oversized_project"),
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
          ...shellCommand(`request_read_${String(index)}`),
          projectId: "project_fixture",
          type: "project.get_snapshot",
        },
        sender,
      ),
    );
    await Promise.resolve();

    const overflow = await gateway.execute(
      {
        ...shellCommand("request_read_overflow"),
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
    const mutation = (id: string, revision: string) => ({
      ...shellCommand(`request_${id}`),
      expectedProjectRevisionId: revision,
      projectId: "project_fixture",
      transaction: {
        id,
        operations: [
          { eventId: "chord_fixture", type: "replace_chord_value", value: { kind: "no_chord" } },
        ],
        parentTransactionId: null,
      },
      type: "project.commit_edit_transaction",
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
    const mutation = (index: number) => ({
      ...shellCommand(`request_mutation_${String(index)}`),
      expectedProjectRevisionId: "projectrevision_current",
      projectId: "project_fixture",
      transaction: {
        id: `transaction_${String(index)}`,
        operations: [
          { eventId: "chord_fixture", type: "replace_chord_value", value: { kind: "no_chord" } },
        ],
        parentTransactionId: null,
      },
      type: "project.commit_edit_transaction",
    });
    const accepted = Array.from({ length: 32 }, (_, index) =>
      gateway.execute(mutation(index), sender),
    );

    const overflow = await gateway.execute(mutation(32), sender);
    expect(overflow.response).toMatchObject({ code: "busy", retryable: true });

    release();
    await Promise.all(accepted);
  });
});

import {
  DesktopResponseSchema,
  ProjectEventSchema,
  type OpenChordsDesktopApi,
  type ProjectSnapshotResponse,
} from "@open-chords/contracts";
import { describe, expect, it } from "vitest";

import {
  createCommittedProjectStore,
  openFirstCommittedProject,
} from "../apps/desktop/src/renderer/committed-project-store.ts";

const envelope = {
  generationId: "generation_fixture",
  protocol: "open-chords/desktop-ipc",
  protocolVersion: "1.0",
  requestId: "request_fixture",
} as const;

function snapshot(projectRevisionId: string): ProjectSnapshotResponse {
  const response = DesktopResponseSchema.parse({
    ...envelope,
    eventSequence: 1,
    project: {
      activeView: null,
      analysisRevisions: [],
      durationSamples: 48_000,
      editLayers: [],
      extensions: {},
      format: "open-chords/project",
      id: "project_fixture",
      lyricsAlignments: [],
      lyricsDocuments: [],
      sampleRate: 48_000,
      schemaVersion: "1.0",
      supportClaims: [],
    },
    projectRevisionId,
    type: "project.snapshot",
  });
  if (response.type !== "project.snapshot") throw new Error("Fixture snapshot was rejected");
  return response;
}

describe("committed Project store", () => {
  it("turns rejected startup and snapshot reads into visible error states", async () => {
    const store = createCommittedProjectStore({
      getSnapshot: async () => Promise.reject(new Error("transport unavailable")),
      subscribe: () => () => undefined,
    });

    await store.open("project_fixture");
    expect(store.getSnapshot()).toEqual({
      kind: "error",
      message: "Project read failed",
      projectId: "project_fixture",
    });
    await expect(
      openFirstCommittedProject(
        { list: async () => Promise.reject(new Error("transport unavailable")) },
        store,
      ),
    ).resolves.toBe("Project listing failed");
  });

  it("publishes an error when an event-triggered snapshot refresh rejects", async () => {
    let listener: Parameters<OpenChordsDesktopApi["project"]["subscribe"]>[0] | undefined;
    let rejectRefresh = false;
    const first = snapshot("projectrevision_first");
    const store = createCommittedProjectStore({
      getSnapshot: async () => {
        if (rejectRefresh) throw new Error("refresh unavailable");
        return first;
      },
      subscribe: (next) => {
        listener = next;
        return () => undefined;
      },
    });
    await store.open("project_fixture");
    rejectRefresh = true;

    listener?.({
      event: ProjectEventSchema.parse({
        generationId: "generation_fixture",
        projectId: "project_fixture",
        projectRevisionId: "projectrevision_next",
        protocol: "open-chords/desktop-ipc",
        protocolVersion: "1.0",
        sequence: 2,
        type: "project.changed",
      }),
      kind: "event",
    });

    await expect
      .poll(() => store.getSnapshot())
      .toEqual({
        kind: "error",
        message: "Project read failed",
        projectId: "project_fixture",
      });
  });

  it("publishes cached committed snapshots and ignores unrelated Project events", async () => {
    let listener: Parameters<OpenChordsDesktopApi["project"]["subscribe"]>[0] | undefined;
    const first = snapshot("projectrevision_first");
    const api = {
      getSnapshot: async () => first,
      subscribe: (next: typeof listener) => {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
    };
    const store = createCommittedProjectStore(api);
    let notifications = 0;
    store.subscribe(() => {
      notifications += 1;
    });

    expect(store.getSnapshot()).toEqual({ kind: "idle" });
    expect(store.getSnapshot()).toBe(store.getSnapshot());
    await store.open("project_fixture");
    expect(store.getSnapshot()).toEqual({ kind: "ready", snapshot: first });
    expect(store.getSnapshot()).toBe(store.getSnapshot());

    listener?.({
      event: ProjectEventSchema.parse({
        generationId: "generation_fixture",
        projectId: "project_other",
        projectRevisionId: "projectrevision_other",
        protocol: "open-chords/desktop-ipc",
        protocolVersion: "1.0",
        sequence: 2,
        type: "project.changed",
      }),
      kind: "event",
    });
    expect(notifications).toBe(2);
    expect(store.getSnapshot()).toEqual({ kind: "ready", snapshot: first });
  });
});

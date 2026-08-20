import { describe, expect, it, vi } from "vitest";

import { ProjectEventStream } from "../apps/desktop/src/preload/project-event-stream.ts";

const event = (sequence: number) => ({
  generationId: "generation_fixture",
  projectId: "project_fixture",
  projectRevisionId: `projectrevision_${String(sequence)}`,
  protocol: "open-chords/desktop-ipc",
  protocolVersion: "1.0",
  sequence,
  type: "project.changed",
});

describe("ProjectEventStream", () => {
  it("delivers contiguous events and ignores duplicates", async () => {
    const refresh = vi.fn<(projectId: string) => Promise<{ eventSequence: number }>>(async () => ({
      eventSequence: 0,
    }));
    const stream = new ProjectEventStream(refresh);
    stream.synchronize("project_fixture", 4);

    expect(await stream.accept(event(5))).toMatchObject({ kind: "event" });
    expect(await stream.accept(event(5))).toEqual({ kind: "ignored" });
    expect(refresh).not.toHaveBeenCalled();
  });

  it("recovers an event gap through the snapshot seam", async () => {
    const snapshot = { eventSequence: 8, type: "project.snapshot" } as const;
    const refresh = vi.fn<(projectId: string) => Promise<typeof snapshot>>(async () => snapshot);
    const stream = new ProjectEventStream(refresh);
    stream.synchronize("project_fixture", 4);

    expect(await stream.accept(event(7))).toEqual({ kind: "snapshot", snapshot });
    expect(refresh).toHaveBeenCalledWith("project_fixture");
    expect(await stream.accept(event(8))).toEqual({ kind: "ignored" });
    expect(await stream.accept(event(9))).toMatchObject({ kind: "event" });
  });

  it("serializes concurrent gap recovery and never moves the sequence backwards", async () => {
    let resolveRefresh!: (snapshot: { eventSequence: number }) => void;
    const refresh = vi.fn<() => Promise<{ eventSequence: number }>>(
      () =>
        new Promise<{ eventSequence: number }>((resolve) => {
          resolveRefresh = resolve;
        }),
    );
    const stream = new ProjectEventStream(refresh);
    stream.synchronize("project_fixture", 4);

    const first = stream.accept(event(7));
    const second = stream.accept(event(9));
    expect(refresh).toHaveBeenCalledTimes(1);
    resolveRefresh({ eventSequence: 8 });

    expect(await first).toEqual({ kind: "snapshot", snapshot: { eventSequence: 8 } });
    expect(await second).toMatchObject({ event: { sequence: 9 }, kind: "event" });
    expect(await stream.accept(event(8))).toEqual({ kind: "ignored" });
  });
});

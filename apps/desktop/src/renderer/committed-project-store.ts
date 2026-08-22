import type { OpenChordsDesktopApi, ProjectSnapshotResponse } from "@open-chords/contracts";

export type CommittedProjectState =
  | { kind: "error"; message: string; projectId: string }
  | { kind: "idle" }
  | { kind: "loading"; projectId: string }
  | { kind: "ready"; snapshot: ProjectSnapshotResponse };

type ProjectReadApi = Pick<OpenChordsDesktopApi["project"], "getSnapshot" | "subscribe">;

const idleState: CommittedProjectState = { kind: "idle" };

export function createCommittedProjectStore(api: ProjectReadApi) {
  let state = idleState;
  let activeProjectId: string | null = null;
  let requestSequence = 0;
  const listeners = new Set<() => void>();

  const publish = (next: CommittedProjectState) => {
    if (Object.is(state, next)) return;
    state = next;
    for (const listener of listeners) listener();
  };

  const read = async (projectId: string, showLoading: boolean) => {
    const request = ++requestSequence;
    activeProjectId = projectId;
    if (showLoading) publish({ kind: "loading", projectId });
    const response = await api.getSnapshot(projectId);
    if (request !== requestSequence || activeProjectId !== projectId) return;
    publish(
      response.type === "project.snapshot"
        ? { kind: "ready", snapshot: response }
        : { kind: "error", message: response.message, projectId },
    );
  };

  const unsubscribeApi = api.subscribe((update) => {
    const projectId =
      update.kind === "snapshot" ? update.snapshot.project.id : update.event.projectId;
    if (projectId !== activeProjectId) return;
    if (update.kind === "snapshot") {
      requestSequence += 1;
      publish({ kind: "ready", snapshot: update.snapshot });
      return;
    }
    void read(projectId, false);
  });

  return {
    dispose() {
      requestSequence += 1;
      activeProjectId = null;
      unsubscribeApi();
      listeners.clear();
    },
    getSnapshot: () => state,
    open: (projectId: string) => read(projectId, true),
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export type CommittedProjectStore = ReturnType<typeof createCommittedProjectStore>;

import { StrictMode, useEffect, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";

import { createCommittedProjectStore } from "./committed-project-store.ts";

import "./styles.css";
import { EmptyWorkspace, ProjectWorkspace } from "./workspace.tsx";

const root = document.querySelector<HTMLElement>("#root");

if (root === null) {
  throw new Error("Renderer root is missing");
}

const api = window.openChords;
const projectStore = api === undefined ? null : createCommittedProjectStore(api.project);
const subscribeCommitted = (listener: () => void) =>
  projectStore?.subscribe(listener) ?? emptySubscribe();
const getCommittedSnapshot = () => projectStore?.getSnapshot() ?? unavailable;

function App() {
  const committed = useSyncExternalStore(subscribeCommitted, getCommittedSnapshot);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (api === undefined || projectStore === null) return undefined;
    let current = true;
    void api.project.list().then((response) => {
      if (!current) return undefined;
      if (response.type === "desktop.error") {
        setError(response.message);
        return undefined;
      }
      const first = response.projects[0];
      if (first !== undefined) void projectStore.open(first.projectId);
      return undefined;
    });
    return () => {
      current = false;
    };
  }, []);

  const chooseLocalRecording = async () => {
    if (api === undefined || projectStore === null) return;
    setBusy(true);
    setError(null);
    try {
      const selected = await api.media.pickLocalFile();
      if (selected.type === "desktop.error") throw new Error(selected.message);
      if (selected.type === "media.selection_cancelled") return;
      const created = await api.media.createProject({
        capabilityId: selected.capabilityId,
        endSourceSample: selected.durationSamples,
        startSourceSample: 0,
      });
      if (created.type === "desktop.error") throw new Error(created.message);
      await projectStore.open(created.projectId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create the Project");
    } finally {
      setBusy(false);
    }
  };

  if (api === undefined || projectStore === null) {
    return (
      <EmptyWorkspace
        busy={false}
        error="Desktop capabilities are unavailable"
        onChoose={() => undefined}
      />
    );
  }
  if (committed.kind === "ready")
    return <ProjectWorkspace api={api} snapshot={committed.snapshot} />;
  return (
    <EmptyWorkspace
      busy={busy || committed.kind === "loading"}
      error={committed.kind === "error" ? committed.message : error}
      onChoose={() => void chooseLocalRecording()}
    />
  );
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

const emptySubscribe = () => () => undefined;
const unavailable = { kind: "idle" as const };

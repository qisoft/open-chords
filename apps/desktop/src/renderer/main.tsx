import { StrictMode, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";

import {
  createCommittedProjectStore,
  openFirstCommittedProject,
} from "./committed-project-store.ts";

import "./styles.css";
import { ModelPacks } from "./model-packs.tsx";
import { EmptyWorkspace, ProjectWorkspace } from "./workspace.tsx";
import { YouTubeSource } from "./youtube-source.tsx";

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
  const choosingLocal = useRef(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (api === undefined || projectStore === null) return undefined;
    const controller = new AbortController();
    let current = true;
    void openFirstCommittedProject(api.project, projectStore, controller.signal).then((message) => {
      if (!current) return undefined;
      if (message !== null) setError(message);
      return undefined;
    });
    return () => {
      controller.abort();
      current = false;
    };
  }, []);

  const chooseLocalRecording = async () => {
    if (
      choosingLocal.current ||
      committed.kind === "loading" ||
      api === undefined ||
      projectStore === null
    )
      return;
    choosingLocal.current = true;
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
      choosingLocal.current = false;
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
    return (
      <>
        {error && <p role="alert">{error}</p>}
        <ProjectWorkspace
          api={api}
          key={committed.snapshot.project.id}
          {...(!busy ? { onChooseLocal: () => void chooseLocalRecording() } : {})}
          snapshot={committed.snapshot}
        />
      </>
    );
  return (
    <>
      <div className="empty-model-tools">
        <ModelPacks api={api} />
        <YouTubeSource
          api={api}
          {...(!busy && committed.kind !== "loading"
            ? { onChooseLocal: () => void chooseLocalRecording() }
            : {})}
        />
      </div>
      <EmptyWorkspace
        busy={busy || committed.kind === "loading"}
        error={committed.kind === "error" ? committed.message : error}
        onChoose={() => void chooseLocalRecording()}
      />
    </>
  );
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

const emptySubscribe = () => () => undefined;
const unavailable = { kind: "idle" as const };

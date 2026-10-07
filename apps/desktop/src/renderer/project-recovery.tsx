import { Dialog } from "@base-ui/react/dialog";
import type { OpenChordsDesktopApi, RecoveryResult } from "@open-chords/contracts";
import { useRef, useState } from "react";

export function ProjectRecovery({
  api,
  onOpen,
}: {
  api: OpenChordsDesktopApi;
  onOpen: (projectId: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<RecoveryResult | null>(null);
  const [selected, setSelected] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const generation = useRef(0);
  const perform = async (action: Parameters<typeof api.recovery.perform>[0]) => {
    const id = ++generation.current;
    setPending(true);
    setSelected("");
    setConfirmed(false);
    setMessage("");
    try {
      const response = await api.recovery.perform(action);
      if (id !== generation.current) return;
      if (response.type === "desktop.error") {
        setMessage(response.message);
        setResult(null);
      } else {
        setResult(response);
        if (response.restoredProjectRevisionId)
          setMessage(
            "Backup restored as a new Project Revision. Previous revisions remain available.",
          );
      }
    } catch {
      if (id === generation.current) {
        setResult(null);
        setMessage(
          "Could not inspect the Project Library. Reopen the application before retrying.",
        );
      }
    } finally {
      if (id === generation.current) setPending(false);
    }
  };
  const detail = result?.detail;
  const canRollback =
    detail?.project.status === "active" && detail.project.compatibility === "writable";
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(value) => {
        setOpen(value);
        if (value) void perform({ type: "list" });
        else {
          ++generation.current;
          setPending(false);
        }
      }}
    >
      <Dialog.Trigger>Project recovery</Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop className="model-packs-backdrop" />
        <Dialog.Popup className="model-packs">
          <header>
            <Dialog.Title>Project recovery</Dialog.Title>
            <Dialog.Close disabled={pending}>Close</Dialog.Close>
          </header>
          <p>
            Inspect preserved revisions and recovery reports. Restoring a backup publishes a new
            compatible revision; it never downgrades or overwrites history.
          </p>
          <button type="button" disabled={pending} onClick={() => void perform({ type: "list" })}>
            Refresh Projects
          </button>
          <output aria-live="polite">{message}</output>
          {result?.truncated && (
            <p>The first 10,000 Projects are shown. Additional Projects remain in the Library.</p>
          )}
          {result?.projects.length === 0 && <p>No active or damaged Projects.</p>}
          <ul>
            {result?.projects.map((project) => (
              <li key={project.projectId}>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => void perform({ type: "inspect", projectId: project.projectId })}
                >
                  Inspect {project.projectId}
                </button>{" "}
                {project.status === "damaged"
                  ? "Damaged"
                  : project.compatibility === "read_only"
                    ? "Read-only"
                    : "Writable"}
                {project.recoveredHead && " · Recovered Head"}
              </li>
            ))}
          </ul>
          {detail && (
            <section style={{ overflowWrap: "anywhere" }}>
              <h3>{detail.project.projectId}</h3>
              <p>
                Current Revision:{" "}
                {detail.project.projectRevisionId ?? "No verified active Revision"}
              </p>
              {detail.schemaVersion && <p>Stored schema: {detail.schemaVersion}</p>}
              {detail.project.readOnlyReason && (
                <p>
                  {detail.project.readOnlyReason === "migration_failed"
                    ? "Migration failed. The prior revision is preserved for reading; writes and rollback are blocked. Use a compatible application or import a compatible backup archive."
                    : "This application cannot write the stored schema. Use a compatible application; no in-place downgrade is allowed."}
                </p>
              )}
              {detail.project.status === "damaged" && (
                <p>
                  No verified active Revision can be opened. Preserve the Library and use Import
                  Project Archive to recover a compatible backup as a separate Project.
                </p>
              )}
              {detail.recovery && (
                <p>
                  Head recovery at {detail.recovery.createdAt}: lost Revision{" "}
                  {detail.recovery.lostProjectRevisionId ?? "unknown"}; recovered Revision{" "}
                  {detail.recovery.recoveredProjectRevisionId ?? "unavailable"}.
                </p>
              )}
              {detail.project.status === "active" && (
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => {
                    const id = ++generation.current;
                    setPending(true);
                    void onOpen(detail.project.projectId)
                      .then(() => {
                        if (id === generation.current) setOpen(false);
                        return undefined;
                      })
                      .catch(() => {
                        if (id === generation.current)
                          setMessage("Could not open the preserved Project.");
                      })
                      .finally(() => {
                        if (id === generation.current) setPending(false);
                      });
                  }}
                >
                  Open preserved Project
                </button>
              )}
              {detail.earlierRevisionCount > 0 && (
                <p>
                  {detail.earlierRevisionCount} earlier revisions are retained but not shown. The
                  most recent 100 are listed.
                </p>
              )}
              <label>
                Backup Revision
                <select
                  aria-label="Backup Revision"
                  style={{ maxWidth: "100%" }}
                  value={selected}
                  disabled={pending || !canRollback}
                  onChange={(event) => {
                    setSelected(event.target.value);
                    setConfirmed(false);
                  }}
                >
                  <option value="">Select a preserved revision</option>
                  {detail.revisions
                    .filter(
                      (revision) => revision.projectRevisionId !== detail.project.projectRevisionId,
                    )
                    .map((revision) => (
                      <option key={revision.projectRevisionId} value={revision.projectRevisionId}>
                        {revision.createdAt} · {revision.reason} · {revision.projectRevisionId}
                      </option>
                    ))}
                </select>
              </label>
              {selected && (
                <label>
                  <input
                    type="checkbox"
                    checked={confirmed}
                    disabled={pending}
                    onChange={(event) => setConfirmed(event.target.checked)}
                  />
                  Restore selected backup {selected} as a new Revision. Current edits and practice
                  will follow that backup; existing history is retained.
                </label>
              )}
              <button
                type="button"
                disabled={pending || !canRollback || !selected || !confirmed}
                onClick={() => {
                  const expected = detail.project.projectRevisionId;
                  if (expected)
                    void perform({
                      type: "rollback",
                      projectId: detail.project.projectId,
                      expectedProjectRevisionId: expected,
                      targetProjectRevisionId: selected,
                      confirmedTargetProjectRevisionId: selected,
                    });
                }}
              >
                Restore selected backup
              </button>
            </section>
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

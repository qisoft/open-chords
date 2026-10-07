import { Dialog } from "@base-ui/react/dialog";
import type {
  DesktopResponse,
  OpenChordsDesktopApi,
  ProjectSnapshotResponse,
} from "@open-chords/contracts";
import { useRef, useState } from "react";

const omissionLabels: Record<string, string> = {
  unrecognized_lyrics_reference_omitted:
    "An unrecognized lyrics source reference was omitted to protect private data.",
  unrecognized_lyrics_provider_omitted:
    "The lyrics provider could not be represented by this export profile.",
  support_claim_descriptions_omitted:
    "Free-form benchmark descriptions were omitted to protect private data.",
  alignment_recipe_omitted:
    "Alignment runtime details were omitted; verification hashes are included.",
  local_source_locators_omitted:
    "Local file locations were omitted; the Source stays identified by its fingerprint.",
  receipt_locations_reduced_to_names:
    "Earlier export destinations were reduced to file names to protect private paths.",
};

function omissionLabel(omission: string): string {
  const [code, ...details] = omission.split(":");
  const label = omissionLabels[code!] ?? code!.replaceAll("_", " ");
  return details.length === 0 ? label : `${label}: ${details.join(":")}`;
}

type Result = Extract<DesktopResponse, { type: "exports.result" }>;

export function ExportProject({
  api,
  snapshot,
}: {
  api: OpenChordsDesktopApi;
  snapshot: ProjectSnapshotResponse;
}) {
  const [result, setResult] = useState<Result | null>(null);
  const [pending, setPending] = useState(false);
  const [saving, setSaving] = useState(false);
  const [presentation, setPresentation] = useState<"current" | "original">("current");
  const [includeMedia, setIncludeMedia] = useState(false);
  const [message, setMessage] = useState("");
  const version = useRef(0);
  const perform = async (action: Parameters<typeof api.exports.perform>[0]) => {
    const current = ++version.current;
    setPending(true);
    const isSave = action.type.startsWith("save_");
    setSaving(isSave);
    setMessage(isSave ? "Choose a destination…" : "Checking exports…");
    try {
      const response = await api.exports.perform(action);
      if (current !== version.current) return;
      if (response.type === "desktop.error") setMessage(response.message);
      else {
        setResult(response);
        setMessage(
          response.state === "saved"
            ? "Export saved"
            : response.state === "cancelled"
              ? "Export cancelled"
              : response.state === "too_large"
                ? "This export is larger than its profile allows. Nothing was saved."
                : response.state === "media_unavailable"
                  ? "The verified Project Range is unavailable. Relink the Source or export without media."
                  : response.state === "unavailable"
                    ? "LRC needs validated lyric-line timing. Select or align lyrics before exporting."
                    : response.state === "receipt_pending"
                      ? "File saved; the export record needs recovery."
                      : response.pendingRecovery > 0
                        ? "An export needs recovery. Keep its destination available and retry recovery."
                        : "",
        );
      }
    } catch {
      if (current === version.current) setMessage("Export unavailable. Try again.");
    } finally {
      if (current === version.current) {
        setPending(false);
        setSaving(false);
      }
    }
  };
  const cancel = async () => {
    try {
      await api.exports.perform({ type: "cancel", projectId: snapshot.project.id });
    } catch {
      /* The original request reports its final outcome. */
    }
  };
  return (
    <Dialog.Root
      onOpenChange={(open) => {
        if (open && !pending) void perform({ type: "list", projectId: snapshot.project.id });
      }}
    >
      <Dialog.Trigger>Export Project</Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop className="model-packs-backdrop" />
        <Dialog.Popup className="model-packs export-project">
          <header>
            <Dialog.Title>Export Project</Dialog.Title>
            <Dialog.Close>Close</Dialog.Close>
          </header>
          <p>
            Open Chords JSON v1.0 captures the saved Active View, including selected lyrics and
            timing. Save any draft edits before exporting.
          </p>
          <label>
            Export Profile{" "}
            <select
              value={presentation}
              disabled={pending}
              onChange={(event) =>
                setPresentation(event.target.value === "original" ? "original" : "current")
              }
            >
              <option value="current">Current presentation</option>
              <option value="original">Original presentation</option>
            </select>
          </label>
          <p>
            The snapshot includes the original analysis and effective timeline. Original
            presentation removes transpose and beginner display transforms.
          </p>
          <button
            type="button"
            disabled={pending || snapshot.project.activeView === null}
            onClick={() =>
              void perform({
                type: "save_json",
                projectId: snapshot.project.id,
                expectedProjectRevisionId: snapshot.projectRevisionId,
                presentation,
              })
            }
          >
            Save JSON
          </button>
          <h3>Lead sheet and lyrics</h3>
          <p>
            ChordPro and PDF keep exact chord symbols and selected lyrics. PDF uses an embedded-font
            A4 layout that you can print from your PDF viewer. LRC includes only validated
            lyric-line onsets. Each Receipt reports the details its format cannot preserve.
          </p>
          {(
            [
              ["save_chordpro", "Save ChordPro"],
              ["save_pdf", "Save PDF"],
              ["save_lrc", "Save LRC"],
            ] as const
          ).map(([type, label]) => (
            <button
              key={type}
              type="button"
              disabled={pending || snapshot.project.activeView === null}
              onClick={() => {
                const request = {
                  projectId: snapshot.project.id,
                  expectedProjectRevisionId: snapshot.projectRevisionId,
                };
                void perform(
                  type === "save_lrc" ? { ...request, type } : { ...request, type, presentation },
                );
              }}
            >
              {label}
            </button>
          ))}
          <h3>Portable Project Archive</h3>
          <p>
            The archive keeps every retained Analysis Revision, edit, Lyrics Document, practice
            setting and Export Receipt. Source media stays outside it unless you include the
            verified Project Range.
          </p>
          <label className={"export-option"}>
            <input
              type={"checkbox"}
              checked={includeMedia}
              disabled={pending}
              onChange={(event) => setIncludeMedia(event.target.checked)}
              data-testid={"exports.archive.include-media"}
            />
            Include verified Project Range media
          </label>
          <button
            type={"button"}
            disabled={pending}
            onClick={() =>
              void perform({
                type: "save_archive",
                projectId: snapshot.project.id,
                expectedProjectRevisionId: snapshot.projectRevisionId,
                includeMedia,
              })
            }
            data-testid={"exports.archive.save"}
          >
            Save Project Archive
          </button>
          {saving && (
            <button type="button" onClick={() => void cancel()}>
              Cancel export
            </button>
          )}
          <output aria-live="polite">{message}</output>
          {(result?.pendingRecovery ?? 0) > 0 && (
            <button
              type="button"
              disabled={pending}
              onClick={() => void perform({ type: "recover", projectId: snapshot.project.id })}
            >
              Retry Receipt recovery
            </button>
          )}
          <h3>Export Receipts</h3>
          {result?.receipts.length === 0 && <p>No exports recorded.</p>}
          {result?.receipts.map((receipt) => (
            <section key={receipt.id} aria-label={`Export ${receipt.displayName}`}>
              <h4 className="model-reference">{receipt.displayName}</h4>
              <p>
                {receipt.createdAt} · {receipt.profileVersion}
              </p>
              <details>
                <summary>Snapshot hashes and omissions</summary>
                {receipt.detailsTruncated && (
                  <p>
                    Details were shortened for display. The complete Receipt remains in the Project
                    Library.
                  </p>
                )}
                <p className="model-reference">Output SHA-256: {receipt.outputHash}</p>
                <p className="model-reference">Active View SHA-256: {receipt.activeViewHash}</p>
                {receipt.omissions.map((omission, index) => (
                  <p key={`${index}:${omission}`}>{omissionLabel(omission)}</p>
                ))}
              </details>
            </section>
          ))}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

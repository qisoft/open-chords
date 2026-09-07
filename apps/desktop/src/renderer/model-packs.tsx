import { Dialog } from "@base-ui/react/dialog";
import type { DesktopResponse, OpenChordsDesktopApi } from "@open-chords/contracts";
import { useRef, useState } from "react";

type Result = Extract<DesktopResponse, { type: "models.result" }>;
const size = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(2)} MiB`;

export function ModelPacks({ api }: { api: OpenChordsDesktopApi }) {
  const [result, setResult] = useState<Result | null>(null);
  const [pending, setPending] = useState(false);
  const [pendingAction, setPendingAction] = useState<
    Parameters<typeof api.models.perform>[0]["type"] | null
  >(null);
  const [message, setMessage] = useState("");
  const version = useRef(0);
  const perform = async (action: Parameters<typeof api.models.perform>[0]) => {
    const current = ++version.current;
    setPending(true);
    setPendingAction(action.type);
    setMessage(
      action.type === "install" ? "Downloading and verifying the exact pack…" : "Checking…",
    );
    try {
      const response = await api.models.perform(action);
      if (current !== version.current) return;
      if (response.type === "desktop.error") {
        setMessage(response.message);
        if (action.type === "set_offline") {
          const status = await api.models.perform({ type: "status" });
          if (current === version.current && status.type === "models.result") setResult(status);
        }
      } else {
        setResult(response);
        setMessage(
          action.type === "install"
            ? "Pack installed and verified"
            : action.type === "remove"
              ? "Pack removed. Existing results are unchanged."
              : action.type === "cancel"
                ? "Installation cancelled"
                : "",
        );
      }
    } catch {
      if (current === version.current) setMessage("Alignment packs are unavailable. Try again.");
    } finally {
      if (current === version.current) setPending(false);
    }
  };
  return (
    <Dialog.Root
      onOpenChange={(open) => {
        if (open && !pending) void perform({ type: "status" });
      }}
    >
      <Dialog.Trigger>Alignment packs</Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop className="model-packs-backdrop" />
        <Dialog.Popup className="model-packs">
          <header>
            <Dialog.Title>Alignment language packs</Dialog.Title>
            <Dialog.Close>Close</Dialog.Close>
          </header>
          <p>
            Optional English and Russian reference-lyrics alignment. Best effort for singing;
            installing a pack does not start alignment.
          </p>
          <label>
            <input
              type="checkbox"
              checked={result?.offline ?? false}
              disabled={!result || (pending && pendingAction !== "install")}
              onChange={(event) => {
                const offline = event.target.checked;
                void perform({ type: "set_offline", offline });
              }}
            />{" "}
            Offline Mode for all network operations
          </label>
          <output aria-live="polite">{message}</output>
          {pending && pendingAction === "install" && (
            <button type="button" onClick={() => void perform({ type: "cancel" })}>
              Cancel installation
            </button>
          )}
          {result && (
            <>
              <p>
                {result.runtime.available
                  ? `MFA 3.4.1 runtime is included in this application: ${size(result.runtime.installedBytes)} installed · ${size(result.runtime.transferBytes)} compressed component. No additional runtime download.`
                  : "The self-contained MFA runtime is unavailable in this build. Packs cannot be installed."}
              </p>
              {result.packs.map((pack) => {
                const name = pack.language === "en" ? "English" : "Russian";
                return (
                  <section key={pack.id} aria-label={`${name} alignment pack`}>
                    <h3>
                      {name} MFA {pack.version}
                    </h3>
                    <p>
                      {size(pack.transferBytes)} download · {size(pack.installedBytes)} installed
                    </p>
                    <p>{pack.installed ? "Installed and verified" : "Not installed"}</p>
                    <details>
                      <summary>Source, license and exact artifacts</summary>
                      {pack.artifacts.map((artifact) => (
                        <div key={artifact.id}>
                          <p>
                            {artifact.id} {artifact.version} · {artifact.license}
                          </p>
                          <p>{artifact.attribution}</p>
                          <p className="model-reference">{artifact.source}</p>
                          <p className="model-reference">{artifact.modelCard}</p>
                          <code className="model-reference">SHA-256: {artifact.sha256}</code>
                        </div>
                      ))}
                    </details>
                    {pack.installed ? (
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() => void perform({ type: "preview_removal", packId: pack.id })}
                      >
                        Review {name} removal
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={pending || result.offline || !result.runtime.available}
                        onClick={() => void perform({ type: "install", packId: pack.id })}
                      >
                        Install {name}
                      </button>
                    )}
                  </section>
                );
              })}
              {result.removal && (
                <section aria-label="Removal impact">
                  <h3>Review removal</h3>
                  <p>
                    Existing lyrics and analysis results remain valid. Exact reanalysis will require
                    reinstalling this same pack.
                  </p>
                  <p>
                    {result.removal.affectedProjectIds.length === 0
                      ? "No retained Projects reference this exact pack."
                      : `Affected Projects: ${result.removal.affectedProjectIds.join(", ")}`}
                  </p>
                  <button
                    type="button"
                    disabled={pending || result.removal.unknownProjectIds.length > 0}
                    onClick={() =>
                      void perform({
                        type: "remove",
                        packId: result.removal!.packId,
                        impactId: result.removal!.impactId,
                      })
                    }
                  >
                    Confirm pack removal
                  </button>
                  {result.removal.unknownProjectIds.length > 0 && (
                    <p>
                      Dependency impact is unknown for damaged Projects:{" "}
                      {result.removal.unknownProjectIds.join(", ")}. Repair these Projects before
                      removing this pack.
                    </p>
                  )}
                </section>
              )}
            </>
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

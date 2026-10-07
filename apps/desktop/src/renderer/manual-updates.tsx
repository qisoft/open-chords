import { Dialog } from "@base-ui/react/dialog";
import type { OpenChordsDesktopApi, UpdateStatus } from "@open-chords/contracts";
import { useRef, useState } from "react";

const messages: Record<UpdateStatus["state"], string> = {
  idle: "No update check has been made.",
  checking: "Checking GitHub Release metadata…",
  available: "Latest published release metadata. Verify any download before installation.",
  not_published: "No published release is available yet.",
  offline: "Offline Mode is enabled. No update request is made.",
  cancelled: "Update check cancelled.",
  failed: "Could not read release metadata. Try again when online.",
};

export function ManualUpdates({ api }: { api: OpenChordsDesktopApi }) {
  const [result, setResult] = useState<UpdateStatus | null>(null);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const generation = useRef(0);
  const perform = async (action: Parameters<typeof api.updates.perform>[0]) => {
    const id = ++generation.current;
    setPending(action.type === "check");
    if (action.type === "check") {
      setResult(null);
      setMessage(messages.checking);
    }
    try {
      const response = await api.updates.perform(action);
      if (id !== generation.current) return;
      if (response.type === "desktop.error") setMessage(response.message);
      else {
        setResult(response);
        setMessage(messages[response.state]);
      }
    } catch {
      if (id === generation.current) setMessage(messages.failed);
    } finally {
      if (id === generation.current) setPending(false);
    }
  };
  return (
    <Dialog.Root
      onOpenChange={(open) => {
        if (open) void perform({ type: "status" });
        else {
          ++generation.current;
          setPending(false);
          void api.updates.perform({ type: "cancel" }).catch(() => {});
        }
      }}
    >
      <Dialog.Trigger>Updates</Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop className="model-packs-backdrop" />
        <Dialog.Popup className="model-packs">
          <header>
            <Dialog.Title>Manual updates</Dialog.Title>
            <Dialog.Close>Close</Dialog.Close>
          </header>
          <p>
            Checks contact api.github.com only when you request them. Installation is manual; app
            removal preserves your Projects, settings, caches and language packs.
          </p>
          <button
            type="button"
            disabled={pending || result?.offline}
            onClick={() => void perform({ type: "check" })}
          >
            Check for updates
          </button>
          {pending && (
            <button type="button" onClick={() => void perform({ type: "cancel" })}>
              Cancel update check
            </button>
          )}
          <output aria-live="polite">{message}</output>
          {result && (
            <p>
              Installed version: {result.currentVersion} · Target: {result.target}
            </p>
          )}
          {result?.checkedAt && <p>Checked: {result.checkedAt}</p>}
          {result?.release && (
            <>
              <h3>
                {result.release.name} ({result.release.tag})
              </h3>
              <p>Published: {result.release.publishedAt}</p>
              <pre style={{ whiteSpace: "pre-wrap" }}>{result.release.notes}</pre>
              {result.release.artifacts.length === 0 && (
                <p>No application archive for this platform is published in this release.</p>
              )}
              {result.release.artifacts.map((asset) => (
                <section key={asset.name}>
                  <h4>{asset.name}</h4>
                  <p>{(asset.size / 1024 / 1024).toFixed(2)} MiB</p>
                  <p>Metadata SHA-256: {asset.sha256 ?? "Not supplied. Use SHA256SUMS."}</p>
                </section>
              ))}
              <p>
                {result.release.checksumsUrl
                  ? "SHA256SUMS is available on the release page."
                  : "SHA256SUMS is missing. Do not install until verification evidence is available."}
              </p>
              <p>
                Compute the downloaded ZIP's SHA-256 and compare with SHA256SUMS. Verify the build
                attestation with GitHub CLI before overriding an OS warning. Release metadata is not
                proof of a verified download.
              </p>
              <button
                type="button"
                disabled={result.offline}
                onClick={() => void perform({ type: "open_release" })}
              >
                Open release on GitHub
              </button>
            </>
          )}
          <button
            type="button"
            disabled={!result || result.offline}
            onClick={() => void perform({ type: "open_verification" })}
          >
            Open verification instructions
          </button>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

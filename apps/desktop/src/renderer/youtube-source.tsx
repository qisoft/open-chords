import { Dialog } from "@base-ui/react/dialog";
import type { DesktopResponse, OpenChordsDesktopApi, YouTubeAction } from "@open-chords/contracts";
import { useEffect, useRef, useState } from "react";

type Result = Extract<DesktopResponse, { type: "youtube.result" }>;
export function YouTubeSource({ api }: { api: OpenChordsDesktopApi }) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [seconds, setSeconds] = useState("0");
  const [result, setResult] = useState<Result | null>(null);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const version = useRef(0);
  const perform = async (action: YouTubeAction) => {
    const current = ++version.current;
    setPending(true);
    setMessage("");
    try {
      const response = await api.youtube.perform(action);
      if (version.current !== current) return;
      if (response.type === "desktop.error") setMessage(response.message);
      else {
        setResult(response);
        const videoId = response.player?.videoId;
        if (videoId) setUrl((draft) => draft || `https://www.youtube.com/watch?v=${videoId}`);
      }
    } catch {
      if (version.current === current) setMessage("YouTube is unavailable. Try again.");
    } finally {
      if (version.current === current) setPending(false);
    }
  };
  useEffect(() => {
    if (!open || pending) return undefined;
    let disposed = false;
    let running = false;
    const current = version.current;
    const timer = setInterval(() => {
      if (running) return;
      running = true;
      void api.youtube
        .perform({ type: "status" })
        .then((response) => {
          if (!disposed && current === version.current && response.type === "youtube.result")
            setResult(response);
          return undefined;
        })
        .catch(() => undefined)
        .finally(() => {
          running = false;
        });
    }, 1000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [api, open, pending]);
  const offline = result?.offline ?? false;
  const player = result?.player;
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(value) => {
        setOpen(value);
        if (value) void perform({ type: "status" });
      }}
    >
      <Dialog.Trigger>YouTube source</Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop className="model-packs-backdrop" />
        <Dialog.Popup className="model-packs youtube-source">
          <header>
            <Dialog.Title>YouTube source</Dialog.Title>
            <Dialog.Close>Close controls</Dialog.Close>
          </header>
          <p>
            Preview a public video or explicitly refresh its title and uploader. To create a Project
            for analysis, open an authorized local recording.
          </p>
          <p>
            The separate player window stays open when you close these controls. Use Close player to
            stop playback.
          </p>
          <label>
            YouTube video URL
            <input
              value={url}
              maxLength={4096}
              onChange={(event) => setUrl(event.target.value)}
              type="url"
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={offline}
              onChange={(event) =>
                void perform({ type: "set_offline", offline: event.target.checked })
              }
            />
            Offline Mode
          </label>
          <div className="youtube-actions">
            <button
              disabled={pending || offline || !url}
              onClick={() => void perform({ type: "refresh", url })}
            >
              Refresh Source Metadata
            </button>
            <button
              disabled={pending || offline || !url}
              onClick={() => void perform({ type: "open_player", url })}
            >
              Open player
            </button>
            <button
              disabled={pending || offline || !url}
              onClick={() => void perform({ type: "open_external", url })}
            >
              Open on YouTube
            </button>
            {pending && (
              <button onClick={() => void perform({ type: "cancel" })}>
                Cancel YouTube operation
              </button>
            )}
          </div>
          <p role="alert">{message}</p>
          {player && (
            <section aria-label="YouTube playback">
              <output>
                {player.error
                  ? `Playback unavailable: ${player.error.replaceAll("_", " ")}. Use the video controls or Open on YouTube.`
                  : `Player ${player.state}`}
              </output>
              <p>
                {player.seconds.toFixed(1)} / {player.durationSeconds.toFixed(1)} seconds
              </p>
              <button
                disabled={pending || offline}
                onClick={() => void perform({ type: "play", sessionId: player.sessionId })}
              >
                Play YouTube
              </button>
              <button
                disabled={pending || offline}
                onClick={() => void perform({ type: "pause", sessionId: player.sessionId })}
              >
                Pause YouTube
              </button>
              <label>
                Source time in seconds
                <input
                  type="number"
                  min="0"
                  max="86400"
                  step="0.1"
                  value={seconds}
                  onChange={(event) => setSeconds(event.target.value)}
                />
              </label>
              <button
                disabled={
                  pending ||
                  !seconds ||
                  !Number.isFinite(Number(seconds)) ||
                  Number(seconds) < 0 ||
                  Number(seconds) > 86400
                }
                onClick={() =>
                  void perform({
                    type: "seek",
                    seconds: Number(seconds),
                    sessionId: player.sessionId,
                  })
                }
              >
                Seek YouTube
              </button>
              <label>
                YouTube playback speed
                <select
                  value={player.rate}
                  disabled={pending}
                  onChange={(event) =>
                    void perform({
                      type: "set_rate",
                      rate: Number(event.target.value),
                      sessionId: player.sessionId,
                    })
                  }
                >
                  {[0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map((rate) => (
                    <option key={rate} value={rate}>
                      {rate}×
                    </option>
                  ))}
                </select>
              </label>
              <button onClick={() => void perform({ type: "close_player" })}>Close player</button>
            </section>
          )}
          <section aria-label="Observed YouTube sources">
            <h3>Observed metadata</h3>
            {result?.sources.map((source) => (
              <article key={source.id}>
                <h4>{source.title ?? source.videoId}</h4>
                <p>{source.uploader}</p>
                <p>Observed {source.observedAt ?? "unknown"}</p>
                <button onClick={() => setUrl(`https://www.youtube.com/watch?v=${source.videoId}`)}>
                  Select {source.title ?? source.videoId}
                </button>
              </article>
            ))}
            {result?.sources.length === 0 && <p>No metadata observations yet.</p>}
          </section>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

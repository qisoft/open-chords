import type {
  LyricsCandidate,
  OpenChordsDesktopApi,
  ProjectSnapshotResponse,
} from "@open-chords/contracts";
import { LyricsInputSchema, type LyricsInput } from "@open-chords/domain";
import { useEffect, useRef, useState } from "react";

export function LyricsSelection({
  api,
  snapshot,
}: {
  api: OpenChordsDesktopApi;
  snapshot: ProjectSnapshotResponse;
}) {
  const selected = snapshot.project.lyricsDocuments.find(
    (document) => document.id === snapshot.project.activeView?.lyricsDocumentId,
  );
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [language, setLanguage] = useState("und");
  const [format, setFormat] = useState<LyricsInput["format"]>("text");
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState("");
  const [offline, setOffline] = useState<boolean | null>(null);
  const [query, setQuery] = useState("");
  const [videoId, setVideoId] = useState("");
  const [candidates, setCandidates] = useState<LyricsCandidate[]>([]);
  const requestVersion = useRef(0);
  useEffect(() => {
    let live = true;
    void api.lyrics
      .perform({ type: "status" })
      .then((result) => {
        if (!live) return undefined;
        if (result.type === "lyrics.result") setOffline(result.offline);
        else setStatus(result.message);
        return undefined;
      })
      .catch(() => {
        if (live) setStatus("Lyrics discovery is unavailable. You can paste local text.");
      });
    return () => {
      live = false;
      void api.lyrics.perform({ type: "cancel" }).catch(() => {});
    };
  }, [api]);
  async function network(action: Parameters<OpenChordsDesktopApi["lyrics"]["perform"]>[0]) {
    const version = ++requestVersion.current;
    setPending(true);
    setStatus("Loading lyrics…");
    setCandidates([]);
    try {
      const result = await api.lyrics.perform(action);
      if (version !== requestVersion.current) return;
      if (result.type === "desktop.error") {
        setStatus(result.message);
        return;
      }
      setOffline(result.offline);
      if (result.candidates) {
        setCandidates(result.candidates);
        setStatus(
          result.candidates.length
            ? "Choose a candidate; no text has been saved"
            : "No lyrics found. You can paste your own text.",
        );
      } else if (result.projectRevisionId) {
        setStatus("Lyrics saved");
        setOpen(false);
        setText("");
      } else setStatus("");
    } catch {
      if (version === requestVersion.current)
        setStatus("Lyrics unavailable. You can paste local text.");
    } finally {
      if (version === requestVersion.current) setPending(false);
    }
  }

  async function save() {
    setPending(true);
    setStatus("Saving lyrics…");
    try {
      const result = await api.project.addLyrics({
        projectId: snapshot.project.id,
        expectedProjectRevisionId: snapshot.projectRevisionId,
        input: { text, language, format },
      });
      setStatus(result.type === "desktop.error" ? result.message : "Lyrics saved");
      if (result.type !== "desktop.error") {
        setText("");
        setOpen(false);
      }
    } catch {
      setStatus("Lyrics could not be saved. Check the text and supplied timing.");
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="lyrics-selection">
      <button
        className="secondary-button"
        type="button"
        aria-expanded={open}
        onClick={() => {
          requestVersion.current++;
          setCandidates([]);
          setPending(false);
          void api.lyrics.perform({ type: "cancel" }).catch(() => {});
          setOpen(!open);
          setText(selected?.text ?? "");
          setLanguage(selected?.language ?? "und");
          setFormat("text");
          setStatus("");
        }}
      >
        Choose lyrics
      </button>
      <label className="offline-control">
        <input
          type="checkbox"
          checked={offline === true}
          disabled={offline === null}
          onChange={(event) => {
            const value = event.target.checked;
            setOffline(value);
            void network({ type: "set_offline", offline: value });
          }}
        />
        Offline Mode
      </label>
      <output aria-label="Lyrics selection status">{status}</output>
      {open && (
        <fieldset disabled={pending}>
          <legend>Reference Lyrics</legend>
          <p>
            Paste lyrics or timed text. Corrections create a new document and retain the previous
            version.
          </p>
          <label>
            Lyrics text
            <textarea
              maxLength={64000}
              value={text}
              onChange={(event) => setText(event.target.value)}
            />
          </label>
          <label>
            Lyrics language
            <input
              maxLength={35}
              value={language}
              onChange={(event) => setLanguage(event.target.value)}
            />
          </label>
          <label>
            Lyrics format
            <select
              value={format}
              onChange={(event) =>
                setFormat(LyricsInputSchema.shape.format.parse(event.target.value))
              }
            >
              <option value="text">Plain text</option>
              <option value="lrc">LRC</option>
              <option value="vtt">WebVTT</option>
              <option value="srt">SRT</option>
            </select>
          </label>
          <p>
            Imported timing uses Project Time. Provider timing uses Source Time. Untimed words
            remain unmatched.
          </p>
          <button
            className="primary-button"
            type="button"
            disabled={!text.trim()}
            onClick={() => void save()}
          >
            Save new Lyrics Document
          </button>
          <div className="lyrics-search">
            <label>
              Track and artist
              <input
                maxLength={200}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <button
              type="button"
              disabled={offline !== false || !query.trim()}
              onClick={() =>
                void network({
                  type: "search",
                  provider: "lrclib",
                  query,
                  projectId: snapshot.project.id,
                })
              }
            >
              Search LRCLIB
            </button>
            <button
              type="button"
              disabled={offline !== false || !query.trim()}
              onClick={() => void network({ type: "open_genius", query })}
            >
              Open Genius search
            </button>
            <p>Genius opens in your browser for metadata and links only.</p>
            <label>
              YouTube video ID
              <input
                maxLength={11}
                value={videoId}
                onChange={(event) => setVideoId(event.target.value)}
              />
            </label>
            <button
              type="button"
              disabled={offline !== false || !/^[A-Za-z0-9_-]{11}$/.test(videoId)}
              onClick={() =>
                void network({
                  type: "search",
                  provider: "youtube",
                  query: videoId,
                  projectId: snapshot.project.id,
                })
              }
            >
              Find subtitle tracks
            </button>
          </div>
          {candidates.length > 0 && (
            <ul aria-label="Lyrics candidates">
              {candidates.map((candidate) => (
                <li key={candidate.id}>
                  <span>
                    {candidate.label} · {candidate.language} · {candidate.timingKind}
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      void network({
                        type: "select",
                        candidateId: candidate.id,
                        projectId: snapshot.project.id,
                        expectedProjectRevisionId: snapshot.projectRevisionId,
                        language: candidate.language === "und" ? language : candidate.language,
                      })
                    }
                  >
                    Use {candidate.label}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </fieldset>
      )}
      {selected && (
        <p className="lyrics-provenance">
          {selected.provenance.provider} · {selected.language} · {selected.suppliedTimingKind}
          {selected.attribution.length > 0 ? ` · ${selected.attribution.join(" · ")}` : ""}
          {selected.notices.length > 0 ? ` · ${selected.notices.join(" · ")}` : ""}
        </p>
      )}
    </div>
  );
}

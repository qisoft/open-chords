import type {
  AlignmentAction,
  AlignmentJobSummary,
  OpenChordsDesktopApi,
  ProjectSnapshotResponse,
} from "@open-chords/contracts";
import {
  materializeEffectiveTimeline,
  resolveLyricsAnchors,
  type EditTransaction,
} from "@open-chords/domain";
import { useEffect, useRef, useState } from "react";

export function LyricsTiming({
  api,
  snapshot,
}: {
  api: OpenChordsDesktopApi;
  snapshot: ProjectSnapshotResponse;
}) {
  const [open, setOpen] = useState(false);
  const [jobs, setJobs] = useState<AlignmentJobSummary[]>([]);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const version = useRef(0);
  const { project } = snapshot;
  const active = project.activeView;
  const document = project.lyricsDocuments.find((item) => item.id === active?.lyricsDocumentId);
  useEffect(() => {
    if (!open) return undefined;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      const request = ++version.current;
      try {
        const response = await api.alignment.perform({ type: "status", projectId: project.id });
        if (live && request === version.current) {
          if (response.type === "alignment.result") setJobs(response.jobs);
          else setMessage(response.message);
        }
      } catch {
        if (live && request === version.current) setMessage("Alignment status is unavailable");
      } finally {
        if (live) timer = setTimeout(() => void refresh(), 1000);
      }
    };
    void refresh();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [api, open, project.id]);
  async function perform(action: AlignmentAction) {
    version.current++;
    setPending(true);
    setMessage("");
    try {
      const response = await api.alignment.perform(action);
      if (response.type === "desktop.error") setMessage(response.message);
      else setJobs(response.jobs);
    } catch {
      setMessage("Alignment action could not be completed");
    } finally {
      setPending(false);
    }
  }
  const relevant = jobs.filter(
    (job) =>
      job.lyricsDocumentId === document?.id &&
      job.analysisRevisionId === active?.analysisRevisionId,
  );
  const results = project.lyricsAlignments.filter(
    (item) =>
      item.lyricsDocumentId === document?.id &&
      item.analysisRevisionId === active?.analysisRevisionId,
  );
  return (
    <section className="lyrics-timing" aria-label="Alignment Jobs">
      <button
        type="button"
        className="secondary-button"
        aria-expanded={open}
        disabled={!document || !active}
        onClick={() => setOpen(!open)}
      >
        Lyrics timing
      </button>
      {open && (
        <>
          <p>
            Align the selected lyrics locally. Word timing is experimental; review it before
            practising.
          </p>
          <button
            type="button"
            disabled={
              pending ||
              relevant.some(
                (job) => job.state === "running" || job.state === "queued" || job.cleanupPending,
              )
            }
            onClick={() =>
              void perform({
                type: "start",
                projectId: project.id,
                expectedProjectRevisionId: snapshot.projectRevisionId,
              })
            }
          >
            Align lyrics
          </button>
          <ul aria-label="Alignment job history">
            {relevant.map((job) => (
              <li key={job.id}>
                <span>
                  {job.state.replaceAll("_", " ")}
                  {job.state === "running" && job.stage
                    ? ` · ${job.stage.replaceAll("_", " ")}`
                    : ""}
                  {job.cleanupPending ? " · finishing cleanup" : ""}
                  {job.state === "running" ? ` · ${Math.floor(job.elapsedMs / 1000)}s elapsed` : ""}
                </span>
                {job.blockedReasons.includes("missing_pack") && (
                  <p>Install the selected language pack in Language packs, then retry.</p>
                )}
                {job.blockedReasons.includes("missing_runtime") && (
                  <p>
                    This Job requires its original Alignment runtime. Use Align lyrics to request a
                    result with the installed app.
                  </p>
                )}
                {job.blockedReasons.includes("unsupported_language") && (
                  <p>Alignment is available for English and Russian lyrics.</p>
                )}
                {job.blockedReasons.includes("runtime_failure") && (
                  <p>
                    Alignment stopped after a runtime or validation failure. Restart the app before
                    explicitly retrying; repair the installation if this repeats.
                  </p>
                )}
                {job.state === "running" || job.state === "queued" ? (
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() =>
                      void perform({ type: "cancel", projectId: project.id, jobId: job.id })
                    }
                  >
                    Cancel alignment
                  </button>
                ) : (
                  job.state !== "succeeded" && (
                    <button
                      type="button"
                      disabled={pending || job.cleanupPending || job.circuitOpen}
                      onClick={() =>
                        void perform({ type: "retry", projectId: project.id, jobId: job.id })
                      }
                    >
                      Retry alignment
                    </button>
                  )
                )}
              </li>
            ))}
          </ul>
          <label>
            Timing result{" "}
            <select
              value={active?.lyricsAlignmentId ?? ""}
              disabled={pending}
              onChange={(event) =>
                void perform({
                  type: "select",
                  projectId: project.id,
                  expectedProjectRevisionId: snapshot.projectRevisionId,
                  alignmentId: event.target.value,
                })
              }
            >
              <option value="" disabled>
                Choose a result
              </option>
              {results.map((result, index) => (
                <option key={result.id} value={result.id}>
                  {result.provenance
                    ? `Local alignment ${index + 1} · review needed`
                    : `Supplied timing ${index + 1}`}
                </option>
              ))}
            </select>
          </label>
          {document && active && (
            <TimingCorrection
              key={`${project.id}:${document.id}:${active.analysisRevisionId}:${active.lyricsAlignmentId ?? "untimed"}`}
              api={api}
              snapshot={snapshot}
            />
          )}
        </>
      )}
      {message && <p role="alert">{message}</p>}
    </section>
  );
}

function TimingCorrection({
  api,
  snapshot,
}: {
  api: OpenChordsDesktopApi;
  snapshot: ProjectSnapshotResponse;
}) {
  const { project } = snapshot;
  const active = project.activeView!;
  const document = project.lyricsDocuments.find((item) => item.id === active.lyricsDocumentId)!;
  const alignment = materializeEffectiveTimeline(project).lyricsAlignment;
  const anchors = resolveLyricsAnchors(project);
  const [target, setTarget] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [first, setFirst] = useState("");
  const [last, setLast] = useState("");
  const [baseRevision, setBaseRevision] = useState(snapshot.projectRevisionId);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const startSample = Math.round(Number(start) * project.sampleRate);
  const endSample = Math.round(Number(end) * project.sampleRate);
  const valid =
    start.trim() !== "" &&
    end.trim() !== "" &&
    Number.isSafeInteger(startSample) &&
    Number.isSafeInteger(endSample) &&
    startSample >= 0 &&
    endSample > startSample &&
    endSample <= project.durationSamples;
  const stale = baseRevision !== snapshot.projectRevisionId;
  async function save(operation: EditTransaction["operations"][number], success: string) {
    setBusy(true);
    setMessage("");
    try {
      const layer = project.editLayers.find((item) => item.id === active.editLayerId)!;
      const response = await api.project.commitEditTransaction({
        projectId: project.id,
        expectedProjectRevisionId: baseRevision,
        transaction: {
          id: `transaction_${crypto.randomUUID().replaceAll("-", "")}`,
          parentTransactionId: layer.transactions[active.editHistoryPosition - 1]?.id ?? null,
          operations: [operation],
        },
      });
      if (response.type === "desktop.error") setMessage(response.message);
      else {
        setMessage(success);
        setBaseRevision(response.projectRevisionId);
      }
    } catch {
      setMessage("Timing was not saved. Check order, overlap and the selected range.");
    } finally {
      setBusy(false);
    }
  }
  function correct(unmatched: boolean) {
    if (!alignment || !target) return;
    const timing = unmatched
      ? { state: "unmatched" as const, reasonCode: "user_marked_unmatched" }
      : {
          state: "matched" as const,
          startSample,
          endSample,
          assertion: {
            state: "asserted" as const,
            reasonCodes: ["user_authored" as const],
            evidence: [],
          },
        };
    void save(
      target.startsWith("word:")
        ? { type: "set_lyrics_timing", alignmentId: alignment.id, tokenId: target.slice(5), timing }
        : {
            type: "set_lyrics_line_timing",
            alignmentId: alignment.id,
            lineId: target.slice(5),
            timing,
          },
      "Timing correction saved",
    );
  }
  const wordCount =
    alignment?.occurrences.filter((item) => item.timing.state === "matched").length ?? 0;
  const lineCount =
    alignment?.lineOccurrences.filter((item) => item.timing.state === "matched").length ?? 0;
  return (
    <section aria-label="Lyrics timing correction" className="chord-editor">
      <p aria-label="Word coverage">
        Word coverage: {wordCount}/{document.tokens.length}
      </p>
      <p aria-label="Line coverage">
        Line coverage: {lineCount}/{document.lines.length}
      </p>
      <p>
        Times are seconds from the start of this Project. Corrections and anchors use Undo edit /
        Redo edit.
      </p>
      <label>
        Timing occurrence{" "}
        <select
          value={target}
          disabled={busy || !alignment}
          onChange={(event) => {
            setTarget(event.target.value);
            setBaseRevision(snapshot.projectRevisionId);
            setFirst("");
            setLast("");
            setMessage("");
            const timing = event.target.value.startsWith("word:")
              ? alignment?.occurrences.find((item) => item.tokenId === event.target.value.slice(5))
                  ?.timing
              : alignment?.lineOccurrences.find(
                  (item) => item.lineId === event.target.value.slice(5),
                )?.timing;
            setStart(
              timing?.state === "matched" ? String(timing.startSample / project.sampleRate) : "",
            );
            setEnd(
              timing?.state === "matched" ? String(timing.endSample / project.sampleRate) : "",
            );
          }}
        >
          <option value="">Choose a word or line</option>
          {document.tokens.map((token, index) => {
            const timing = alignment?.occurrences.find((item) => item.tokenId === token.id)?.timing;
            return (
              <option key={token.id} value={`word:${token.id}`}>
                Word {index + 1}: {token.text} ·{" "}
                {timing?.state === "matched"
                  ? timing.assertion.state
                  : (timing?.reasonCode ?? "untimed")}
              </option>
            );
          })}
          {document.lines.map((line, index) => {
            const timing = alignment?.lineOccurrences.find(
              (item) => item.lineId === line.id,
            )?.timing;
            return (
              <option key={line.id} value={`line:${line.id}`}>
                Line {index + 1}: {document.text.slice(line.startOffset, line.endOffset)} ·{" "}
                {timing?.state === "matched"
                  ? timing.assertion.state
                  : (timing?.reasonCode ?? "untimed")}
              </option>
            );
          })}
        </select>
      </label>
      <label>
        Start seconds{" "}
        <input
          type="number"
          min="0"
          step="any"
          value={start}
          disabled={busy}
          onChange={(event) => {
            setStart(event.target.value);
          }}
        />
      </label>
      <label>
        End seconds{" "}
        <input
          type="number"
          min="0"
          step="any"
          value={end}
          disabled={busy}
          onChange={(event) => {
            setEnd(event.target.value);
          }}
        />
      </label>
      <button
        type="button"
        disabled={busy || stale || !target || !valid}
        onClick={() => correct(false)}
      >
        Save timing
      </button>
      <button type="button" disabled={busy || stale || !target} onClick={() => correct(true)}>
        Mark untimed
      </button>
      <fieldset disabled={busy}>
        <legend>Anchor a lyric range for the next alignment</legend>
        <p>Use the start and end above for this word range.</p>
        <label>
          First anchor word{" "}
          <select
            value={first}
            onChange={(event) => {
              setFirst(event.target.value);
            }}
          >
            <option value="">Choose first word</option>
            {document.tokens.map((token, index) => (
              <option key={token.id} value={token.id}>
                {index + 1}: {token.text}
              </option>
            ))}
          </select>
        </label>
        <label>
          Last anchor word{" "}
          <select
            value={last}
            onChange={(event) => {
              setLast(event.target.value);
            }}
          >
            <option value="">Choose last word</option>
            {document.tokens.map((token, index) => (
              <option key={token.id} value={token.id}>
                {index + 1}: {token.text}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          disabled={
            stale ||
            !valid ||
            !first ||
            !last ||
            document.tokens.findIndex((item) => item.id === first) >
              document.tokens.findIndex((item) => item.id === last)
          }
          onClick={() =>
            void save(
              {
                type: "set_lyrics_anchor",
                anchor: {
                  id: `anchor_${crypto.randomUUID().replaceAll("-", "")}`,
                  lyricsDocumentId: document.id,
                  analysisRevisionId: active.analysisRevisionId,
                  firstTokenId: first,
                  lastTokenId: last,
                  startSample,
                  endSample,
                },
              },
              "Lyrics anchor saved",
            )
          }
        >
          Save anchor
        </button>
        <ul>
          {anchors.map((anchor, index) => (
            <li key={anchor.id}>
              Anchor {index + 1}: {anchor.startSample / project.sampleRate}–
              {anchor.endSample / project.sampleRate}s{" "}
              <button
                type="button"
                disabled={stale}
                onClick={() =>
                  void save(
                    { type: "remove_lyrics_anchor", anchorId: anchor.id },
                    "Lyrics anchor removed",
                  )
                }
              >
                Remove anchor {index + 1}
              </button>
            </li>
          ))}
        </ul>
      </fieldset>
      {stale && <p>The Project changed. Reset this draft before saving another correction.</p>}
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          setTarget("");
          setFirst("");
          setLast("");
          setStart("");
          setEnd("");
          setMessage("");
          setBaseRevision(snapshot.projectRevisionId);
        }}
      >
        Reset timing draft
      </button>
      <output>{message}</output>
    </section>
  );
}

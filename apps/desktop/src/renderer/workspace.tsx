/* oxlint-disable jsx-a11y/media-has-caption -- This hidden local-recording transport has its optional reference lyrics in the visible Lyrics viewport; no transcript is fabricated. */
import { Button } from "@base-ui/react/button";
import { Tooltip } from "@base-ui/react/tooltip";
import type {
  MediaPlaybackResponse,
  OpenChordsDesktopApi,
  ProjectSnapshotResponse,
} from "@open-chords/contracts";
import {
  getPracticeState,
  practiceNavigation,
  resolvePracticeLoop,
  type PracticeAction,
} from "@open-chords/domain";
import { FolderOpen, Pause, Play, Repeat2, RotateCcw } from "lucide-react";
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { ChordEditor } from "./chord-editor.tsx";
import { LyricsSelection } from "./lyrics-selection.tsx";
import { LyricsViewport } from "./lyrics-viewport.tsx";
import { ModelPacks } from "./model-packs.tsx";
import { createPlaybackClock, type PlaybackClock } from "./playback-clock.ts";
import { usePracticeAudio } from "./practice-audio.ts";
import { PracticeControls } from "./practice-controls.tsx";
import { TimelineSurface } from "./timeline-surface.tsx";
import { buildWorkspaceContent } from "./workspace-content.ts";
import { continueLoopAtBoundary, requestProjectPlayback } from "./workspace-playback.ts";
import {
  buildWorkspaceTimeline,
  reconcileWorkspaceRegionState,
  shouldRestoreRegionFocus,
  type WorkspaceTimelineRegion,
} from "./workspace-timeline.ts";

export function ProjectWorkspace({
  api,
  snapshot,
}: {
  api: OpenChordsDesktopApi;
  snapshot: ProjectSnapshotResponse;
}) {
  const timeline = useMemo(() => buildWorkspaceTimeline(snapshot.project), [snapshot.project]);
  const content = useMemo(() => buildWorkspaceContent(snapshot.project), [snapshot.project]);
  const [playback, setPlayback] = useState<MediaPlaybackResponse | null>(null);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const [clock, setClock] = useState<PlaybackClock | null>(null);
  const [selectedRegionId, setSelectedRegionId] = useState(timeline.regions[0]?.id ?? null);
  const [loopEnd, setLoopEnd] = useState<{ first: string; last: string } | null>(null);
  const practice = useMemo(() => getPracticeState(snapshot.project), [snapshot.project]);
  const loop = useMemo(() => resolvePracticeLoop(snapshot.project), [snapshot.project]);
  const loopRegionId = practice.loop?.firstBarId ?? null;
  const [practicePending, setPracticePending] = useState(false);
  const [practiceMessage, setPracticeMessage] = useState("");
  const changePractice = async (action: PracticeAction) => {
    if (practicePending) return;
    setPracticePending(true);
    setPracticeMessage("Saving practice…");
    try {
      const response = await api.project.changePractice({
        projectId: snapshot.project.id,
        expectedProjectRevisionId: snapshot.projectRevisionId,
        action,
      });
      setPracticeMessage(response.type === "desktop.error" ? response.message : "Practice saved");
    } catch {
      setPracticeMessage("Practice could not be saved. Try again.");
    } finally {
      setPracticePending(false);
    }
  };
  const audioRef = useRef<HTMLAudioElement>(null);
  const practiceAudio = usePracticeAudio(
    snapshot.project,
    snapshot.projectRevisionId,
    audioRef,
    clock,
  );
  const regionElements = useRef(new Map<string, HTMLButtonElement>());
  const timelineOwnedFocus = useRef(false);
  const regionState = reconcileWorkspaceRegionState(timeline.regions, {
    loopRegionId,
    selectedRegionId,
  });

  useEffect(() => {
    document.title = `${snapshot.project.id} · Local Project · Open Chords`;
    return () => {
      document.title = "Open Chords";
    };
  }, [snapshot.project.id]);

  useEffect(() => {
    if (regionState.selectedRegionId !== selectedRegionId) {
      setSelectedRegionId(regionState.selectedRegionId);
      if (
        regionState.selectedRegionId !== null &&
        shouldRestoreRegionFocus(
          timelineOwnedFocus.current,
          selectedRegionId,
          regionState.selectedRegionId,
        )
      ) {
        regionElements.current.get(regionState.selectedRegionId)?.focus();
      }
    }
  }, [loopRegionId, regionState.loopRegionId, regionState.selectedRegionId, selectedRegionId]);

  useEffect(() => {
    const audio = audioRef.current;
    if (audio === null) return undefined;
    audio.preload = "auto";
    return () => {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    };
  }, []);

  useEffect(() => {
    let current = true;
    void requestProjectPlayback(api.media, snapshot.project.id).then((result) => {
      if (!current) return undefined;
      if (result.kind === "error") {
        setPlaybackError(result.message);
        return undefined;
      }
      const { response } = result;
      if (response.type === "desktop.error") {
        setPlaybackError(response.message);
        return undefined;
      }
      setPlayback(response);
      if (response.type === "media.source_unavailable") {
        setPlaybackError("The verified Source is unavailable. Relink it to enable playback.");
      }
      return undefined;
    });
    return () => {
      current = false;
    };
  }, [api, snapshot.project.id]);

  useEffect(() => {
    const audio = audioRef.current;
    if (audio === null) return undefined;
    const ready = playback?.type === "media.playback_ready" ? playback : null;
    if (ready !== null) {
      audio.src = ready.playbackUrl;
      audio.currentTime = ready.startSourceSample / ready.sampleRate;
    }
    const nextClock = createPlaybackClock({
      cancelFrame: cancelAnimationFrame,
      durationSamples: snapshot.project.durationSamples,
      requestFrame: requestAnimationFrame,
      sampleRate: snapshot.project.sampleRate,
      source: audio,
      startSourceSample: ready?.startSourceSample ?? 0,
    });
    setClock(nextClock);
    return () => {
      nextClock.dispose();
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
      setClock(null);
    };
  }, [playback, snapshot.project.durationSamples, snapshot.project.sampleRate]);

  useEffect(() => {
    if (clock === null) return undefined;
    let current = true;
    let wasPlaying = clock.getSnapshot().playing;
    const unsubscribe = clock.subscribe(() => {
      const { playing, positionSamples } = clock.getSnapshot();
      const reachedMediaEnd = wasPlaying && audioRef.current?.ended === true;
      wasPlaying = playing;
      if (loop !== null && (playing || reachedMediaEnd) && positionSamples >= loop.endSample) {
        const audio = audioRef.current;
        if (audio === null) {
          clock.seek(loop.startSample);
          return;
        }
        void continueLoopAtBoundary(audio, loop.startSample, (nextPositionSamples) =>
          clock.seek(nextPositionSamples),
        ).then((message) => {
          if (current && message !== null) setPlaybackError(message);
          return undefined;
        });
        return;
      }
      if (loop === null && playing && positionSamples >= timeline.durationSamples) {
        audioRef.current?.pause();
      }
    });
    return () => {
      current = false;
      unsubscribe();
    };
  }, [clock, loop, timeline.durationSamples]);

  useEffect(() => {
    if (audioRef.current !== null) {
      audioRef.current.preservesPitch = true;
      audioRef.current.playbackRate = practice.speed;
    }
  }, [practice.speed, playback]);

  const selectedRegion = timeline.regions.find(({ id }) => id === regionState.selectedRegionId);
  const readyPlayback = playback?.type === "media.playback_ready" ? playback : null;

  const selectRegion = (region: WorkspaceTimelineRegion) => {
    practiceAudio.cancel();
    setSelectedRegionId(region.id);
    clock?.seek(region.startSample);
  };

  const selectAdjacent = (direction: -1 | 1) => {
    const current = timeline.regions.findIndex(({ id }) => id === regionState.selectedRegionId);
    const next =
      timeline.regions[Math.max(0, Math.min(timeline.regions.length - 1, current + direction))];
    if (next !== undefined) {
      selectRegion(next);
      regionElements.current.get(next.id)?.focus();
    }
  };

  const togglePlayback = () => practiceAudio.toggle();
  const navigate = (kind: "chord" | "bar", direction: -1 | 1) => {
    practiceAudio.cancel();
    clock?.seek(
      practiceNavigation(snapshot.project, clock.getSnapshot().positionSamples, kind, direction),
    );
  };

  useEffect(() => {
    const handle = (event: globalThis.KeyboardEvent) => {
      if (
        event.code !== "Space" ||
        event.repeat ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        (event.target instanceof Element &&
          event.target.closest("button, input, select, textarea, [contenteditable=true]"))
      )
        return;
      event.preventDefault();
      if (readyPlayback !== null && !practicePending) void practiceAudio.toggle();
    };
    document.addEventListener("keydown", handle);
    return () => document.removeEventListener("keydown", handle);
  }, [practiceAudio, practicePending, readyPlayback]);

  return (
    <main
      className="workspace"
      tabIndex={-1}

      aria-labelledby="workspace-heading"
      onFocusCapture={(event) => {
        timelineOwnedFocus.current =
          event.target instanceof Element && event.target.matches(".timeline-region");
      }}
      onPointerDownCapture={(event) => {
        timelineOwnedFocus.current =
          event.target instanceof Element && event.target.closest(".timeline-region") !== null;
      }}
    >
      <audio ref={audioRef} hidden aria-hidden="true" />
      <header className="workspace-header">
        <div>
          <p className="eyebrow">Committed Project</p>
          <h1 id="workspace-heading">Local Project</h1>
          <p className="project-identity">{snapshot.project.id}</p>
        </div>
        <div className="project-facts" aria-label="Project facts">
          <span>{formatDuration(timeline.durationSamples, snapshot.project.sampleRate)}</span>
          <span>{snapshot.project.sampleRate.toLocaleString("en-US")} Hz</span>
          <span>
            {snapshot.project.activeView === null ? "Awaiting analysis" : "Analysis ready"}
          </span>
        </div>
        <ModelPacks api={api} />
      </header>

      <section className="timeline-section" aria-labelledby="timeline-heading">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Project Time</p>
            <h2 id="timeline-heading">Musical timeline</h2>
          </div>
          <div className="timeline-legend" aria-label="Timeline state legend">
            <span>
              <i className="selection-key" />
              Selected
            </span>
            <span>
              <i className="loop-key" />
              Loop
            </span>
          </div>
        </div>
        <TimelineSurface
          autoscroll={practice.autoscroll}
          onSeek={practiceAudio.cancel}
          clock={clock}
          timeline={timeline}
          sampleRate={snapshot.project.sampleRate}
        >
          {timeline.regions.map((region) => (
            <button
              aria-label={`${region.label}. ${region.chordLabels.length === 0 ? "No chord assertions" : `Chords: ${region.chordLabels.join(", ")}`}`}
              aria-pressed={regionState.selectedRegionId === region.id}
              className="timeline-region"
              data-kind={region.kind}
              data-region-id={region.id}
              data-looped={
                loop !== null &&
                region.startSample >= loop.startSample &&
                region.endSample <= loop.endSample
                  ? "true"
                  : undefined
              }
              key={region.id}
              onClick={(event) => {
                setSelectedRegionId(region.id);
                if (event.detail === 0) {
                  practiceAudio.cancel();
                  clock?.seek(region.startSample);
                }
              }}
              onKeyDown={(event) => handleRegionKey(event, selectAdjacent)}
              ref={(element) => {
                if (element === null) regionElements.current.delete(region.id);
                else regionElements.current.set(region.id, element);
              }}
              style={{
                left: `${String((region.startSample / timeline.durationSamples) * 100)}%`,
                width: `${String(((region.endSample - region.startSample) / timeline.durationSamples) * 100)}%`,
              }}
              tabIndex={regionState.selectedRegionId === region.id ? 0 : -1}
              type="button"
            >
              <span className="region-name">{region.label}</span>
              <span className="region-chords">
                {region.chordLabels.length === 0 ? "No analysis" : region.chordLabels.join(" · ")}
              </span>
            </button>
          ))}
        </TimelineSurface>

        <div className="selection-actions" aria-label="Timeline selection actions">
          <span>
            Selection: <strong>{selectedRegion?.label ?? "None"}</strong>
          </span>
          <label>
            Through{" "}
            <select
              aria-label="Loop end Bar"
              disabled={selectedRegion?.kind !== "bar" || practicePending}
              value={loopEnd?.first === selectedRegion?.id ? loopEnd?.last : selectedRegion?.id}
              onChange={(event) => {
                if (selectedRegion !== undefined)
                  setLoopEnd({ first: selectedRegion.id, last: event.target.value });
              }}
            >
              {timeline.regions
                .slice(timeline.regions.findIndex(({ id }) => id === selectedRegion?.id))
                .filter(
                  (region, index, remaining) =>
                    region.kind === "bar" &&
                    remaining
                      .slice(0, index)
                      .every(
                        (prior, priorIndex) =>
                          prior.endSample === remaining[priorIndex + 1]!.startSample &&
                          prior.kind === "bar",
                      ),
                )
                .map((region) => (
                  <option value={region.id} key={region.id}>
                    {region.label} · {Math.round(region.startSample / snapshot.project.sampleRate)}s
                  </option>
                ))}
            </select>
          </label>
          <Button
            className="secondary-button"
            disabled={practicePending || selectedRegion?.kind !== "bar"}
            onClick={() => {
              if (selectedRegion?.kind === "bar")
                void changePractice({
                  type: "set_loop",
                  firstBarId: selectedRegion.id,
                  lastBarId:
                    loopEnd?.first === selectedRegion.id ? loopEnd.last : selectedRegion.id,
                });
            }}
          >
            <Repeat2 aria-hidden="true" size={16} />
            Set loop from selection
          </Button>
          <Button
            className="quiet-button"
            disabled={practicePending || practice.loop === null}
            onClick={() => void changePractice({ type: "clear_loop" })}
          >
            <RotateCcw aria-hidden="true" size={15} />
            Clear loop
          </Button>
          <output className="loop-status">
            Loop:{" "}
            {practice.loop?.status === "needs_review"
              ? "Needs review — set the loop again"
              : (timeline.regions.find(({ id }) => id === loopRegionId)?.label ?? "Off") +
                (practice.loop !== null && practice.loop.lastBarId !== practice.loop.firstBarId
                  ? ` through ${timeline.regions.find(({ id }) => id === practice.loop?.lastBarId)?.label ?? "missing Bar"}`
                  : "")}
          </output>
        </div>
        <div className="practice-controls" aria-label="Practice settings">
          <label>
            Playback speed{" "}
            <select
              aria-label="Playback speed"
              value={practice.speed}
              disabled={practicePending}
              onChange={(event) =>
                void changePractice({ type: "settings", speed: Number(event.target.value) })
              }
            >
              {[0.5, 0.75, 1, 1.25, 1.5].map((rate) => (
                <option key={rate} value={rate}>
                  {rate}×
                </option>
              ))}
            </select>
          </label>
          <output aria-label="Practice settings status">{practiceMessage}</output>
        </div>
        <ChordEditor api={api} snapshot={snapshot} />
      </section>

      <footer className="transport" aria-label="Playback controls">
        <PlaybackButton
          clock={clock}
          disabled={practicePending || readyPlayback === null || clock === null}
          counting={practiceAudio.counting}
          onToggle={() => void togglePlayback()}
        />
        <div className="practice-navigation">
          {(["bar", "chord"] as const).map((kind) => (
            <span key={kind}>
              <Button
                className="quiet-button"
                disabled={clock === null || snapshot.project.activeView === null}
                onClick={() => navigate(kind, -1)}
              >
                Previous {kind}
              </Button>
              <Button
                className="quiet-button"
                disabled={clock === null || snapshot.project.activeView === null}
                onClick={() => navigate(kind, 1)}
              >
                Next {kind}
              </Button>
            </span>
          ))}
        </div>
        <PositionReadout clock={clock} sampleRate={snapshot.project.sampleRate} />
        <span
          className="source-status"
          role={
            playbackError !== null || (practiceAudio.status !== "" && !practiceAudio.counting)
              ? "alert"
              : "status"
          }
        >
          {practiceAudio.status ||
            (playbackError ??
              (readyPlayback === null ? "Preparing verified Source…" : "Verified local playback"))}
        </span>
      </footer>

      <PracticeControls
        project={snapshot.project}
        pending={practicePending}
        change={(action) => void changePractice(action)}
        clock={clock}
      />
      <LyricsSelection key={snapshot.project.id} api={api} snapshot={snapshot} />
      <section className="content-section" aria-labelledby="content-heading">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Reference content</p>
            <h2 id="content-heading">Lyrics and instrumental sections</h2>
          </div>
        </div>
        <LyricsViewport clock={clock} content={content} />
      </section>
    </main>
  );
}

function PlaybackButton({
  counting = false,
  clock,
  disabled,
  onToggle,
}: {
  clock: PlaybackClock | null;
  disabled: boolean;
  onToggle: () => void;
  counting?: boolean;
}) {
  const playing = useClockPlaying(clock);
  return (
    <Tooltip.Provider>
      <Tooltip.Root>
        <Tooltip.Trigger
          aria-label={counting ? "Cancel count-in" : playing ? "Pause" : "Play"}
          className="play-button"
          onClick={onToggle}
          render={<Button disabled={disabled} />}
        >
          {playing ? <Pause aria-hidden="true" size={19} /> : <Play aria-hidden="true" size={19} />}
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Positioner sideOffset={8}>
            <Tooltip.Popup className="control-tooltip" role="tooltip">
              {counting ? "Cancel count-in" : playing ? "Pause" : "Play"}
            </Tooltip.Popup>
          </Tooltip.Positioner>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}

function PositionReadout({
  clock,
  sampleRate,
}: {
  clock: PlaybackClock | null;
  sampleRate: number;
}) {
  const elapsedSeconds = useClockElapsedSeconds(clock, sampleRate);
  return (
    <output aria-label="Current Project Time" aria-live="off" className="position-readout">
      {formatElapsedSeconds(elapsedSeconds)}
    </output>
  );
}

function useClockPlaying(clock: PlaybackClock | null) {
  const subscribe = useCallback(
    (listener: () => void) =>
      clock?.subscribeSelection(({ playing }) => playing, listener) ?? emptySubscribe(),
    [clock],
  );
  const getSnapshot = useCallback(() => clock?.getSnapshot().playing ?? false, [clock]);
  return useSyncExternalStore(subscribe, getSnapshot);
}

function useClockElapsedSeconds(clock: PlaybackClock | null, sampleRate: number) {
  const subscribe = useCallback(
    (listener: () => void) =>
      clock?.subscribeSelection(
        ({ positionSamples }) => Math.floor(positionSamples / sampleRate),
        listener,
      ) ?? emptySubscribe(),
    [clock, sampleRate],
  );
  const getSnapshot = useCallback(
    () => Math.floor((clock?.getSnapshot().positionSamples ?? 0) / sampleRate),
    [clock, sampleRate],
  );
  return useSyncExternalStore(subscribe, getSnapshot);
}

function handleRegionKey(
  event: KeyboardEvent<HTMLButtonElement>,
  selectAdjacent: (direction: -1 | 1) => void,
) {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  event.preventDefault();
  selectAdjacent(event.key === "ArrowLeft" ? -1 : 1);
}

function formatDuration(samples: number, sampleRate: number): string {
  return formatElapsedSeconds(samples / sampleRate);
}

function formatElapsedSeconds(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes)}:${Math.floor(seconds % 60)
    .toString()
    .padStart(2, "0")}`;
}

const emptySubscribe = () => () => undefined;

export function EmptyWorkspace({
  busy,
  error,
  onChoose,
}: {
  busy: boolean;
  error: string | null;
  onChoose: () => void;
}) {
  return (
    <main className="empty-workspace" aria-labelledby="empty-heading">
      <div className="brand-mark" aria-hidden="true">
        OC
      </div>
      <p className="eyebrow">Local-first workspace</p>
      <h1 id="empty-heading">Open a local recording</h1>
      <p>Select a WAV recording to create a durable Project and verify playback locally.</p>
      <Button className="primary-button" disabled={busy} onClick={onChoose}>
        <FolderOpen aria-hidden="true" size={18} />
        {busy ? "Creating Project…" : "Choose local recording"}
      </Button>
      {error === null ? null : <p role="alert">{error}</p>}
    </main>
  );
}

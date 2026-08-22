import { Button } from "@base-ui/react/button";
import type {
  MediaPlaybackResponse,
  OpenChordsDesktopApi,
  ProjectSnapshotResponse,
} from "@open-chords/contracts";
import { FolderOpen, Pause, Play, Repeat2, RotateCcw } from "lucide-react";
import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { createPlaybackClock, type PlaybackClock } from "./playback-clock.ts";
import {
  buildWorkspaceTimeline,
  type WorkspaceTimeline,
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
  const [playback, setPlayback] = useState<MediaPlaybackResponse | null>(null);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const [clock, setClock] = useState<PlaybackClock | null>(null);
  const [selectedRegionId, setSelectedRegionId] = useState(timeline.regions[0]?.id ?? null);
  const [loopRegionId, setLoopRegionId] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    const audio = new Audio();
    audio.preload = "metadata";
    audioRef.current = audio;
    return () => {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
      audioRef.current = null;
    };
  }, []);

  useEffect(() => {
    let current = true;
    void api.media.openPlayback(snapshot.project.id).then((response) => {
      if (!current) return undefined;
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
    if (audio === null || playback?.type !== "media.playback_ready") return undefined;
    audio.src = playback.playbackUrl;
    audio.currentTime = playback.startSourceSample / playback.sampleRate;
    const nextClock = createPlaybackClock({
      cancelFrame: cancelAnimationFrame,
      durationSamples: playback.endSourceSample - playback.startSourceSample,
      requestFrame: requestAnimationFrame,
      sampleRate: playback.sampleRate,
      source: audio,
      startSourceSample: playback.startSourceSample,
    });
    setClock(nextClock);
    return () => {
      nextClock.dispose();
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
      setClock(null);
    };
  }, [playback]);

  useEffect(() => {
    if (clock === null || loopRegionId === null) return undefined;
    const loop = timeline.regions.find(({ id }) => id === loopRegionId);
    if (loop === undefined) return undefined;
    return clock.subscribe(() => {
      const position = clock.getSnapshot().positionSamples;
      if (position >= loop.endSample) clock.seek(loop.startSample);
    });
  }, [clock, loopRegionId, timeline.regions]);

  const selectedRegion = timeline.regions.find(({ id }) => id === selectedRegionId);
  const readyPlayback = playback?.type === "media.playback_ready" ? playback : null;

  const selectRegion = (region: WorkspaceTimelineRegion) => {
    setSelectedRegionId(region.id);
    clock?.seek(region.startSample);
  };

  const selectAdjacent = (direction: -1 | 1) => {
    const current = timeline.regions.findIndex(({ id }) => id === selectedRegionId);
    const next =
      timeline.regions[Math.max(0, Math.min(timeline.regions.length - 1, current + direction))];
    if (next !== undefined) selectRegion(next);
  };

  const togglePlayback = async () => {
    const audio = audioRef.current;
    if (audio === null || readyPlayback === null || clock === null) return;
    if (!audio.paused) {
      audio.pause();
      return;
    }
    const loop = timeline.regions.find(({ id }) => id === loopRegionId);
    if (loop !== undefined) {
      const position = clock.getSnapshot().positionSamples;
      if (position < loop.startSample || position >= loop.endSample) clock.seek(loop.startSample);
    }
    await audio.play();
  };

  return (
    <main className="workspace" aria-labelledby="workspace-heading">
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
        <div className="timeline-viewport">
          <div className="fixed-playhead" aria-hidden="true" />
          <TimelineMotion clock={clock} timeline={timeline}>
            {timeline.regions.map((region) => (
              <button
                aria-label={`${region.label}. ${region.chordLabels.length === 0 ? "No chord assertions" : `Chords: ${region.chordLabels.join(", ")}`}`}
                aria-pressed={selectedRegionId === region.id}
                className="timeline-region"
                data-kind={region.kind}
                data-looped={loopRegionId === region.id ? "true" : undefined}
                key={region.id}
                onClick={() => selectRegion(region)}
                onKeyDown={(event) => handleRegionKey(event, selectAdjacent)}
                style={{
                  flexBasis: `${String(((region.endSample - region.startSample) / timeline.durationSamples) * 100)}%`,
                }}
                type="button"
              >
                <span className="region-name">{region.label}</span>
                <span className="region-chords">
                  {region.chordLabels.length === 0 ? "No analysis" : region.chordLabels.join(" · ")}
                </span>
              </button>
            ))}
          </TimelineMotion>
        </div>

        <div className="selection-actions" aria-label="Timeline selection actions">
          <span>
            Selection: <strong>{selectedRegion?.label ?? "None"}</strong>
          </span>
          <Button
            className="secondary-button"
            disabled={selectedRegionId === null}
            onClick={() => setLoopRegionId(selectedRegionId)}
          >
            <Repeat2 aria-hidden="true" size={16} />
            Set loop from selection
          </Button>
          <Button
            className="quiet-button"
            disabled={loopRegionId === null}
            onClick={() => setLoopRegionId(null)}
          >
            <RotateCcw aria-hidden="true" size={15} />
            Clear loop
          </Button>
          <output className="loop-status">
            Loop: {timeline.regions.find(({ id }) => id === loopRegionId)?.label ?? "Off"}
          </output>
        </div>
      </section>

      <section className="content-section" aria-labelledby="content-heading">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Reference content</p>
            <h2 id="content-heading">Lyrics and instrumental sections</h2>
          </div>
        </div>
        <ProjectContent snapshot={snapshot} />
      </section>

      <footer className="transport" aria-label="Playback controls">
        <PlaybackButton
          clock={clock}
          disabled={readyPlayback === null || clock === null}
          onToggle={() => void togglePlayback()}
        />
        <PositionReadout clock={clock} sampleRate={snapshot.project.sampleRate} />
        <span className="source-status" role={playbackError === null ? "status" : "alert"}>
          {playbackError ??
            (readyPlayback === null ? "Preparing verified Source…" : "Verified local playback")}
        </span>
      </footer>
    </main>
  );
}

function TimelineMotion({
  children,
  clock,
  timeline,
}: {
  children: ReactNode;
  clock: PlaybackClock | null;
  timeline: WorkspaceTimeline;
}) {
  const position = useClockSnapshot(clock).positionSamples;
  const percentage = (position / timeline.durationSamples) * 100;
  return (
    <div
      className="timeline-track"
      data-position-samples={position}
      style={{ transform: `translateX(calc(50% - ${String(percentage)}%))` }}
    >
      {children}
    </div>
  );
}

function PlaybackButton({
  clock,
  disabled,
  onToggle,
}: {
  clock: PlaybackClock | null;
  disabled: boolean;
  onToggle: () => void;
}) {
  const { playing } = useClockSnapshot(clock);
  return (
    <Button
      aria-label={playing ? "Pause" : "Play"}
      className="play-button"
      disabled={disabled}
      onClick={onToggle}
    >
      {playing ? <Pause aria-hidden="true" size={19} /> : <Play aria-hidden="true" size={19} />}
    </Button>
  );
}

function PositionReadout({
  clock,
  sampleRate,
}: {
  clock: PlaybackClock | null;
  sampleRate: number;
}) {
  const { positionSamples } = useClockSnapshot(clock);
  return (
    <output aria-live="off" className="position-readout">
      {formatDuration(positionSamples, sampleRate)}
    </output>
  );
}

function useClockSnapshot(clock: PlaybackClock | null) {
  const subscribe = useCallback(
    (listener: () => void) => clock?.subscribe(listener) ?? emptySubscribe(),
    [clock],
  );
  const getSnapshot = useCallback(() => clock?.getSnapshot() ?? stopped, [clock]);
  return useSyncExternalStore(subscribe, getSnapshot);
}

function ProjectContent({ snapshot }: { snapshot: ProjectSnapshotResponse }) {
  const active = snapshot.project.activeView;
  const document = snapshot.project.lyricsDocuments.find(
    ({ id }) => id === active?.lyricsDocumentId,
  );
  if (document === undefined) {
    return (
      <div className="instrumental-message">
        <strong>Instrumental or no Reference Lyrics</strong>
        <p>The chord timeline remains available without fabricating lyrical content.</p>
      </div>
    );
  }
  return (
    <div className="lyrics-lines">
      {document.lines.map((line) => (
        <p key={line.id}>{document.text.slice(line.startOffset, line.endOffset)}</p>
      ))}
    </div>
  );
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
  const seconds = samples / sampleRate;
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes)}:${Math.floor(seconds % 60)
    .toString()
    .padStart(2, "0")}`;
}

const emptySubscribe = () => () => undefined;
const stopped = { playing: false, positionSamples: 0 } as const;

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

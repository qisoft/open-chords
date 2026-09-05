import { type ReactNode, useEffect, useRef, useState } from "react";

import type { PlaybackClock } from "./playback-clock.ts";
import { createTimelineGeometry } from "./workspace-geometry.ts";
import type { WorkspaceTimeline } from "./workspace-timeline.ts";

export function TimelineSurface({
  children,
  clock,
  sampleRate,
  timeline,
}: {
  children: ReactNode;
  clock: PlaybackClock | null;
  sampleRate: number;
  timeline: WorkspaceTimeline;
}) {
  const [zoom, setZoom] = useState(1);
  const [width, setWidth] = useState(1);
  const [selectedChordId, setSelectedChordId] = useState<string | null>(null);
  const chordRefs = useRef(new Map<string, HTMLButtonElement>());
  const chordOwnedFocus = useRef(false);
  const selectedChord = timeline.chords.find((chord) => chord.id === selectedChordId);
  const tabChordId = selectedChord?.id ?? timeline.chords[0]?.id;
  const viewportRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const positionRef = useRef<HTMLInputElement>(null);
  const drag = useRef<{ x: number; position: number; moved: boolean; pointerId: number } | null>(
    null,
  );
  const suppressClick = useRef(false);
  const geometry = createTimelineGeometry(timeline.durationSamples, width, zoom);

  useEffect(() => {
    const trackFocus = (event: Event) => {
      chordOwnedFocus.current =
        event.target instanceof Element &&
        event.target.matches(".timeline-chord") &&
        (viewportRef.current?.contains(event.target) ?? false);
    };
    document.addEventListener("focusin", trackFocus);
    document.addEventListener("pointerdown", trackFocus);
    return () => {
      document.removeEventListener("focusin", trackFocus);
      document.removeEventListener("pointerdown", trackFocus);
    };
  }, []);

  useEffect(() => {
    if (selectedChordId === null || selectedChord !== undefined) return;
    setSelectedChordId(tabChordId ?? null);
    if (chordOwnedFocus.current && tabChordId !== undefined)
      chordRefs.current.get(tabChordId)?.focus({ preventScroll: true });
  }, [selectedChord, selectedChordId, tabChordId]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (viewport === null) return undefined;
    const resize = () => setWidth(viewport.clientWidth);
    const observer = new ResizeObserver(resize);
    observer.observe(viewport);
    resize();
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const motion = matchMedia("(prefers-reduced-motion: reduce)");
    let previousRegion: Element | null = null;
    let previousChord: Element | null = null;
    const render = () => {
      const { positionSamples: position, playing } = clock?.getSnapshot() ?? {
        positionSamples: 0,
        playing: false,
      };
      const track = trackRef.current;
      if (track === null) return;
      const frameGeometry = createTimelineGeometry(timeline.durationSamples, width, zoom);
      // Reduced Motion advances by semantic region, without continuous panning.
      const visualPosition =
        motion.matches && playing
          ? (timeline.regions.find(
              (region) => position >= region.startSample && position < region.endSample,
            )?.startSample ?? position)
          : position;
      track.style.transform = `translateX(${String(frameGeometry.xAt(0, visualPosition))}px)`;
      track.dataset.positionSamples = String(position);
      const currentRegion = timeline.regions.find(
        (region) => position >= region.startSample && position < region.endSample,
      );
      const currentChord = timeline.chords.find(
        (chord) => position >= chord.startSample && position < chord.endSample,
      );
      const regionElement =
        currentRegion === undefined
          ? null
          : track.querySelector(`[data-region-id="${CSS.escape(currentRegion.id)}"]`);
      const chordElement =
        currentChord === undefined ? null : (chordRefs.current.get(currentChord.id) ?? null);
      if (previousRegion !== regionElement) {
        previousRegion?.removeAttribute("data-current");
        previousRegion?.removeAttribute("aria-current");
        regionElement?.setAttribute("data-current", "true");
        regionElement?.setAttribute("aria-current", "true");
        previousRegion = regionElement;
      }
      if (previousChord !== chordElement) {
        previousChord?.removeAttribute("aria-current");
        chordElement?.setAttribute("aria-current", "true");
        previousChord = chordElement;
      }
      const input = positionRef.current;
      if (input !== null) {
        input.value = String(position);
        input.setAttribute(
          "aria-valuetext",
          `${(position / sampleRate).toFixed(2)} of ${(timeline.durationSamples / sampleRate).toFixed(2)} seconds`,
        );
      }
    };
    render();
    const unsubscribe = clock?.subscribe(render);
    motion.addEventListener("change", render);
    return () => {
      unsubscribe?.();
      motion.removeEventListener("change", render);
      previousRegion?.removeAttribute("data-current");
      previousRegion?.removeAttribute("aria-current");
      previousChord?.removeAttribute("aria-current");
    };
  }, [clock, sampleRate, timeline, width, zoom]);

  return (
    <>
      <div className="timeline-tools">
        <label>
          Zoom{" "}
          <input
            aria-label="Timeline zoom"
            type="range"
            min="1"
            max="16"
            step="0.25"
            value={zoom}
            onChange={(event) => setZoom(Number(event.target.value))}
          />
        </label>
        <output>{zoom}×</output>
        <span>Drag to scrub. Use Project position to seek with arrow keys, Home or End.</span>
      </div>
      <div
        className="timeline-viewport"
        ref={viewportRef}
        onClickCapture={(event) => {
          if (suppressClick.current && event.detail !== 0) {
            event.preventDefault();
            event.stopPropagation();
          }
        }}
        onPointerDown={(event) => {
          if (event.button !== 0 || !event.isPrimary) return;
          suppressClick.current = false;
          drag.current = {
            x: event.clientX,
            position: clock?.getSnapshot().positionSamples ?? 0,
            moved: false,
            pointerId: event.pointerId,
          };
          if (event.target instanceof Element) event.target.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const start = drag.current;
          if (start === null || start.pointerId !== event.pointerId) return;
          if (Math.abs(event.clientX - start.x) > 3) start.moved = true;
          if (start.moved) {
            suppressClick.current = true;
            clock?.seek(geometry.scrub(start.position, event.clientX - start.x));
          }
        }}
        onPointerUp={(event) => {
          const start = drag.current;
          if (start === null || start.pointerId !== event.pointerId) return;
          if (!start.moved) {
            const left =
              event.currentTarget.getBoundingClientRect().left + event.currentTarget.clientLeft;
            clock?.seek(geometry.sampleAt(event.clientX - left, start.position));
          }
          drag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
          suppressClick.current = true;
        }}
        onLostPointerCapture={() => {
          drag.current = null;
        }}
      >
        <div className="fixed-playhead" aria-hidden="true" />
        <div className="timeline-track" ref={trackRef} style={{ width: geometry.trackWidth }}>
          {children}
          {timeline.beats.map((beat) => (
            <i
              key={beat.id}
              className="beat-mark"
              data-role={beat.role}
              aria-hidden="true"
              style={{ left: `${String((beat.atSample / timeline.durationSamples) * 100)}%` }}
            />
          ))}
          {timeline.chords.map((chord, index) => (
            <button
              key={chord.id}
              type="button"
              className="timeline-chord"
              ref={(element) => {
                if (element === null) chordRefs.current.delete(chord.id);
                else chordRefs.current.set(chord.id, element);
              }}
              aria-label={`Chord ${chord.label}. ${chord.state}`}
              aria-pressed={selectedChordId === chord.id}
              tabIndex={tabChordId === chord.id ? 0 : -1}
              title={`${chord.label} · ${chord.state}`}
              data-state={chord.state}
              onFocus={() => setSelectedChordId(chord.id)}
              onClick={(event) => {
                setSelectedChordId(chord.id);
                if (event.detail === 0) clock?.seek(chord.startSample);
              }}
              onKeyDown={(event) => {
                const nextIndex =
                  event.key === "ArrowRight"
                    ? Math.min(timeline.chords.length - 1, index + 1)
                    : event.key === "ArrowLeft"
                      ? Math.max(0, index - 1)
                      : event.key === "Home"
                        ? 0
                        : event.key === "End"
                          ? timeline.chords.length - 1
                          : null;
                const next = nextIndex === null ? undefined : timeline.chords[nextIndex];
                if (next !== undefined) {
                  event.preventDefault();
                  setSelectedChordId(next.id);
                  clock?.seek(next.startSample);
                  chordRefs.current.get(next.id)?.focus({ preventScroll: true });
                }
              }}
              style={{
                left: `${String((chord.startSample / timeline.durationSamples) * 100)}%`,
                width: `${String(((chord.endSample - chord.startSample) / timeline.durationSamples) * 100)}%`,
              }}
            >
              {chord.label}
            </button>
          ))}
        </div>
      </div>
      <label className="position-control">
        Project position
        <input
          ref={positionRef}
          aria-label="Project position"
          type="range"
          min="0"
          max={timeline.durationSamples}
          step="1"
          defaultValue="0"
          onChange={(event) => clock?.seek(Number(event.target.value))}
          onKeyDown={(event) => {
            const position = clock?.getSnapshot().positionSamples ?? 0;
            const step = sampleRate * (event.shiftKey ? 5 : 0.1);
            const next = {
              ArrowRight: position + step,
              ArrowUp: position + step,
              ArrowLeft: position - step,
              ArrowDown: position - step,
              Home: 0,
              End: timeline.durationSamples,
              PageUp: position + sampleRate * 10,
              PageDown: position - sampleRate * 10,
            }[event.key];
            if (next !== undefined) {
              event.preventDefault();
              clock?.seek(next);
            }
          }}
        />
      </label>
      <output aria-label="Selected chord" className="selected-chord" aria-live="polite">
        {(() => {
          const currentChord = timeline.chords.find((chord) => chord.id === selectedChordId);
          return currentChord === undefined
            ? "Select a chord to read its complete label"
            : `${currentChord.label} · ${currentChord.state}`;
        })()}
      </output>
    </>
  );
}

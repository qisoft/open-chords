/* oxlint-disable jsx-a11y/prefer-tag-over-role -- Inline SVG diagrams need an image role and an accessible name. */
import {
  PracticeActionSchema,
  capoGuidance,
  chordDiagram,
  getPracticeState,
  materializeEffectiveTimeline,
  presentChord,
  type PracticeAction,
  type ProjectContract,
} from "@open-chords/domain";
import { useMemo, useSyncExternalStore } from "react";

import type { PlaybackClock } from "./playback-clock.ts";
import { chordLabel } from "./workspace-timeline.ts";

export function PracticeControls({
  project,
  pending,
  change,
  clock,
}: {
  project: ProjectContract;
  pending: boolean;
  change: (action: PracticeAction) => void;
  clock: PlaybackClock | null;
}) {
  const practice = getPracticeState(project);
  const presentation = project.activeView?.presentation;
  const chords = useMemo(
    () => (project.activeView === null ? [] : materializeEffectiveTimeline(project).chordEvents),
    [project],
  );
  const currentIndex = useSyncExternalStore(
    (listener) => clock?.subscribe(listener) ?? (() => undefined),
    () =>
      chords.findIndex(
        (event) =>
          event.startSample <= (clock?.getSnapshot().positionSamples ?? 0) &&
          event.endSample > (clock?.getSnapshot().positionSamples ?? 0),
      ),
  );
  const current = chords[currentIndex];
  const value =
    current === undefined || presentation === undefined
      ? null
      : presentChord(current.value, presentation);
  const diagram =
    value === null || current?.assertion.state === "abstained"
      ? null
      : chordDiagram(value, practice.instrument);
  const guidance = capoGuidance(presentation?.transposeSemitones ?? 0, practice.instrument);
  return (
    <section className="practice-panel" aria-label="Practice and chord presentation">
      <fieldset disabled={pending} className="practice-controls">
        <legend>Practice</legend>
        <label>
          Count-in{" "}
          <select
            aria-label="Count-in"
            value={practice.countInBars}
            onChange={(event) =>
              change({ type: "settings", countInBars: Number(event.target.value) })
            }
          >
            <option value={0}>Off</option>
            <option value={1}>1 bar</option>
            <option value={2}>2 bars</option>
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            checked={practice.metronome}
            onChange={(event) => change({ type: "settings", metronome: event.target.checked })}
          />{" "}
          Metronome
        </label>
        <label>
          <input
            type="checkbox"
            checked={practice.autoscroll}
            onChange={(event) => change({ type: "settings", autoscroll: event.target.checked })}
          />{" "}
          Timeline autoscroll
        </label>
        <label>
          Transpose{" "}
          <select
            aria-label="Transpose"
            disabled={presentation === undefined}
            value={presentation?.transposeSemitones ?? 0}
            onChange={(event) =>
              change({ type: "settings", transposeSemitones: Number(event.target.value) })
            }
          >
            {Array.from({ length: 23 }, (_, i) => i - 11).map((semitones) => (
              <option value={semitones} key={semitones}>
                {semitones > 0 ? "+" : ""}
                {semitones} semitones
              </option>
            ))}
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            disabled={presentation === undefined}
            checked={presentation?.beginnerView ?? false}
            onChange={(event) => change({ type: "settings", beginnerView: event.target.checked })}
          />{" "}
          Beginner View
        </label>
        <label>
          Spelling{" "}
          <select
            aria-label="Enharmonic spelling"
            disabled={presentation === undefined}
            value={presentation?.enharmonicPreference ?? "contextual"}
            onChange={(event) =>
              change(
                PracticeActionSchema.parse({
                  type: "settings",
                  enharmonicPreference: event.target.value,
                }),
              )
            }
          >
            <option value="contextual">Contextual</option>
            <option value="sharp">Sharps</option>
            <option value="flat">Flats</option>
          </select>
        </label>
        <label>
          Instrument{" "}
          <select
            aria-label="Instrument"
            value={practice.instrument}
            onChange={(event) =>
              change(
                PracticeActionSchema.parse({ type: "settings", instrument: event.target.value }),
              )
            }
          >
            <option value="guitar">Guitar</option>
            <option value="ukulele">Ukulele</option>
            <option value="piano">Piano</option>
          </select>
        </label>
      </fieldset>
      {guidance !== null && <p>{guidance}</p>}
      <div className="chord-diagram">
        <strong>
          {value === null
            ? "No active chord"
            : current?.assertion.state === "abstained"
              ? "Unknown chord"
              : chordLabel(value)}
        </strong>
        {diagram === null ? (
          <span>No asserted chord diagram.</span>
        ) : diagram.kind === "unavailable" ? (
          <span>{diagram.reason}</span>
        ) : diagram.kind === "piano" ? (
          <>
            <svg
              role="img"
              aria-label={`Piano diagram: MIDI notes ${diagram.notes.join(", ")}${diagram.bass === null ? "" : `; bass ${diagram.bass}`}`}
              viewBox="0 0 336 82"
            >
              {Array.from({ length: 24 }, (_, index) => 48 + index)
                .filter((note) => ![1, 3, 6, 8, 10].includes(note % 12))
                .map((note, index) => (
                  <g key={note}>
                    <rect
                      x={index * 24}
                      y={0}
                      width={23}
                      height={60}
                      fill={diagram.notes.includes(note) ? "var(--color-focus)" : "#f0eee8"}
                    />
                    <text
                      x={index * 24 + 12}
                      y={77}
                      textAnchor="middle"
                      fill="currentColor"
                      fontSize={9}
                    >
                      {["C", "", "D", "", "E", "F", "", "G", "", "A", "", "B"][note % 12]}
                      {Math.floor(note / 12) - 1}
                    </text>
                  </g>
                ))}
              {Array.from({ length: 24 }, (_, index) => 48 + index)
                .filter((note) => [1, 3, 6, 8, 10].includes(note % 12))
                .map((note) => {
                  const whitesBefore = Array.from(
                    { length: note - 48 },
                    (_, index) => 48 + index,
                  ).filter((pitch) => ![1, 3, 6, 8, 10].includes(pitch % 12)).length;
                  return (
                    <rect
                      key={note}
                      x={whitesBefore * 24 - 8}
                      y={0}
                      width={15}
                      height={38}
                      fill={diagram.notes.includes(note) ? "var(--color-focus)" : "#30333a"}
                      stroke="#111"
                    />
                  );
                })}
            </svg>
            <span>
              Notes {diagram.notes.join(" · ")}
              {diagram.bass === null ? "" : `; bass ${diagram.bass}`}
            </span>
          </>
        ) : (
          <>
            <svg
              role="img"
              aria-label={`${practice.instrument === "guitar" ? "Guitar" : "Ukulele"} diagram: frets ${diagram.frets.join(", ")}${diagram.barre === null ? "" : `; barre ${diagram.barre}`}`}
              viewBox="0 0 180 110"
            >
              {Array.from({ length: 5 }, (_, index) => (
                <line
                  key={index}
                  x1={20}
                  y1={25 + index * 17}
                  x2={160}
                  y2={25 + index * 17}
                  stroke="currentColor"
                />
              ))}
              {diagram.frets.map((fret, index) => {
                const x = 20 + (index * 140) / (diagram.frets.length - 1);
                const first = Math.max(1, Math.min(...diagram.frets));
                return (
                  <g key={index}>
                    <line x1={x} y1={25} x2={x} y2={93} stroke="currentColor" />
                    <text x={x} y={14} textAnchor="middle" fill="currentColor" fontSize={10}>
                      {fret}
                    </text>
                    {fret > 0 && (
                      <circle
                        cx={x}
                        cy={33 + (fret - first) * 17}
                        r={6}
                        fill="var(--color-focus)"
                      />
                    )}
                  </g>
                );
              })}
            </svg>
            <span>
              Frets {diagram.frets.join(" · ")}
              {diagram.barre === null ? "; 0 = open" : `; barre fret ${diagram.barre}`}
            </span>
          </>
        )}
      </div>
    </section>
  );
}

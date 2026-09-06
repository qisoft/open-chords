import { combine } from "@atlaskit/pragmatic-drag-and-drop/combine";
import {
  draggable,
  dropTargetForElements,
} from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import type { OpenChordsDesktopApi, ProjectSnapshotResponse } from "@open-chords/contracts";
import {
  materializeEffectiveTimeline,
  reviewEditMapping,
  type EditHistoryAction,
} from "@open-chords/domain";
import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "zustand";

import { createEditorDraft, type DraftEvent } from "./editor-draft.ts";
import { chordLabel } from "./workspace-timeline.ts";

export function ChordEditor({
  api,
  snapshot,
}: {
  api: OpenChordsDesktopApi;
  snapshot: ProjectSnapshotResponse;
}) {
  const targets = useMemo(
    () =>
      snapshot.project.activeView === null
        ? []
        : materializeEffectiveTimeline(snapshot.project).chordEvents.map(({ id }) => id),
    [snapshot.project],
  );
  const [draft, setDraft] = useState<ReturnType<typeof createEditorDraft> | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [redoId, setRedoId] = useState("");
  const opener = useRef<HTMLButtonElement>(null);
  const reviewOpener = useRef<HTMLButtonElement>(null);
  const active = snapshot.project.activeView;
  const layer = snapshot.project.editLayers.find(({ id }) => id === active?.editLayerId);
  const current = layer?.transactions[(active?.editHistoryPosition ?? 0) - 1];
  const branches =
    layer?.transactions.filter(
      ({ parentTransactionId }) => parentTransactionId === (current?.id ?? null),
    ) ?? [];
  const close = () => {
    setDraft(null);
    opener.current?.focus();
  };
  const changeHistory = async (action: EditHistoryAction) => {
    setBusy(true);
    setError(null);
    try {
      const response = await api.project.changeEditHistory({
        projectId: snapshot.project.id,
        expectedProjectRevisionId: snapshot.projectRevisionId,
        action,
      });
      if (response.type === "desktop.error") setError(response.message);
      else if (response.type === "project.edit_conflicts")
        setError(response.conflicts.map(({ message }) => message).join(" "));
      else setRedoId("");
    } catch {
      setError("The edit could not be saved. Try again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="editor-section" aria-label="Editing">
      <div className="editor-actions">
        <button
          ref={opener}
          className="secondary-button"
          type="button"
          aria-expanded={draft !== null}
          disabled={targets.length === 0 || busy || reviewing}
          onClick={() =>
            draft === null
              ? setDraft(
                  createEditorDraft({
                    project: snapshot.project,
                    projectRevisionId: snapshot.projectRevisionId,
                    targetIds: targets,
                  }),
                )
              : close()
          }
        >
          Edit chords
        </button>
        <button
          type="button"
          className="quiet-button"
          disabled={draft !== null || reviewing || busy || current === undefined}
          onClick={() => void changeHistory({ type: "undo" })}
        >
          Undo edit
        </button>
        <label>
          Redo branch{" "}
          <select
            aria-label="Redo branch"
            disabled={draft !== null || reviewing || busy || branches.length === 0}
            value={branches.some(({ id }) => id === redoId) ? redoId : ""}
            onChange={(event) => setRedoId(event.target.value)}
          >
            <option value="">Choose a saved branch</option>
            {branches.map((branch, index) => (
              <option key={branch.id} value={branch.id}>
                Branch {index + 1}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="quiet-button"
          disabled={
            draft !== null || reviewing || busy || !branches.some(({ id }) => id === redoId)
          }
          onClick={() => void changeHistory({ type: "redo", transactionId: redoId })}
        >
          Redo edit
        </button>
        <button
          type="button"
          className="quiet-button"
          disabled={draft !== null || reviewing || busy || current === undefined}
          onClick={() => void changeHistory({ type: "reset" })}
        >
          Reset saved edits
        </button>
        <button
          ref={reviewOpener}
          type="button"
          className="quiet-button"
          disabled={
            draft !== null ||
            busy ||
            snapshot.project.analysisRevisions.length < 2 ||
            !snapshot.project.editLayers.some(({ transactions }) => transactions.length > 0)
          }
          onClick={() => setReviewing(true)}
        >
          Review edits on another analysis
        </button>
      </div>
      {reviewing && (
        <MappingReview
          api={api}
          snapshot={snapshot}
          onClose={() => {
            setReviewing(false);
            reviewOpener.current?.focus();
          }}
        />
      )}
      {error !== null && <p role="alert">{error}</p>}
      {draft !== null && (
        <DraftSession
          api={api}
          draft={draft}
          snapshot={snapshot}
          targets={targets}
          onClose={close}
        />
      )}
    </section>
  );
}

function MappingReview({
  api,
  snapshot,
  onClose,
}: {
  api: OpenChordsDesktopApi;
  snapshot: ProjectSnapshotResponse;
  onClose: () => void;
}) {
  const [base] = useState(snapshot);
  const region = useRef<HTMLElement>(null);
  useEffect(() => {
    region.current?.querySelector("select")?.focus();
  }, []);
  const layers = base.project.editLayers.filter(({ transactions }) => transactions.length > 0);
  const [sourceId, setSourceId] = useState(
    layers.find(({ id }) => id === base.project.activeView?.editLayerId)?.id ?? layers[0]!.id,
  );
  const source = layers.find(({ id }) => id === sourceId)!;
  const [position, setPosition] = useState(
    base.project.activeView?.editLayerId === sourceId &&
      base.project.activeView.editHistoryPosition > 0
      ? base.project.activeView.editHistoryPosition
      : source.transactions.length,
  );
  const [targetId, setTargetId] = useState("");
  const [mappings, setMappings] = useState<Array<{ sourceId: string; targetId: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const action = {
    type: "map_edits" as const,
    sourceEditLayerId: sourceId,
    sourceHistoryPosition: position,
    targetAnalysisRevisionId: targetId,
    mappings,
  };
  const review = reviewEditMapping(base.project, action);
  const stale =
    snapshot.projectRevisionId !== base.projectRevisionId ||
    snapshot.project.id !== base.project.id;
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy && region.current?.contains(document.activeElement)) {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [busy, onClose]);
  const apply = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await api.project.changeEditHistory({
        expectedProjectRevisionId: base.projectRevisionId,
        projectId: base.project.id,
        action,
      });
      if (response.type === "desktop.error") setError(response.message);
      else if (response.type === "project.edit_conflicts")
        setError(response.conflicts.map(({ message }) => message).join(" "));
      else onClose();
    } catch {
      setError("Reviewed edits could not be saved.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="chord-editor" aria-label="Review edit mappings" ref={region}>
      <h3>Review edit mappings</h3>
      <p>
        Match each saved edit to the new analysis. Applying creates a separate Edit Layer. Original
        analysis and edits remain saved. Lyrics alignment is not carried to another analysis.
      </p>
      {stale && <p role="alert">The saved Project changed. Cancel and reopen this review.</p>}
      {error !== null && <p role="alert">{error}</p>}
      <fieldset className="editor-fields chord-picker" disabled={busy || stale}>
        <label>
          Saved edits{" "}
          <select
            value={sourceId}
            onChange={(event) => {
              setSourceId(event.target.value);
              setPosition(layers.find(({ id }) => id === event.target.value)!.transactions.length);
              setTargetId("");
              setMappings([]);
            }}
          >
            {layers.map((layer) => (
              <option key={layer.id} value={layer.id}>
                {layer.id}
              </option>
            ))}
          </select>
        </label>
        <label>
          Saved history{" "}
          <select
            value={position}
            onChange={(event) => {
              setPosition(Number(event.target.value));
              setMappings([]);
            }}
          >
            {source.transactions.map((transaction, index) => (
              <option key={transaction.id} value={index + 1}>
                Edit {index + 1}
              </option>
            ))}
          </select>
        </label>
        <label>
          Target analysis{" "}
          <select
            value={targetId}
            onChange={(event) => {
              setTargetId(event.target.value);
              setMappings([]);
            }}
          >
            <option value="">Choose an analysis</option>
            {base.project.analysisRevisions
              .filter(({ id }) => id !== source.analysisRevisionId)
              .map((revision) => (
                <option key={revision.id} value={revision.id}>
                  {revision.id}
                </option>
              ))}
          </select>
        </label>
        {review.requirements.map((requirement) => (
          <label key={requirement.sourceId}>
            Match {requirement.sourceId}
            <select
              value={
                mappings.find(
                  ({ sourceId: mappedSourceId }) => mappedSourceId === requirement.sourceId,
                )?.targetId ?? ""
              }
              onChange={(event) =>
                setMappings([
                  ...mappings.filter(
                    ({ sourceId: mappedSourceId }) => mappedSourceId !== requirement.sourceId,
                  ),
                  ...(event.target.value === ""
                    ? []
                    : [{ sourceId: requirement.sourceId, targetId: event.target.value }]),
                ])
              }
            >
              <option value="">Unresolved</option>
              {requirement.targetIds.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          </label>
        ))}
      </fieldset>
      {targetId !== "" && review.conflicts.length > 0 && (
        <p role="alert">{[...new Set(review.conflicts.map(({ message }) => message))].join(" ")}</p>
      )}
      <div className="editor-actions">
        <button
          type="button"
          className="primary-button"
          disabled={busy || stale || review.conflicts.length > 0}
          onClick={() => void apply()}
        >
          Apply reviewed edits
        </button>
        <button type="button" className="secondary-button" disabled={busy} onClick={onClose}>
          Cancel review
        </button>
      </div>
    </section>
  );
}

function DraftSession({
  api,
  draft,
  snapshot,
  targets,
  onClose,
}: {
  api: OpenChordsDesktopApi;
  draft: ReturnType<typeof createEditorDraft>;
  snapshot: ProjectSnapshotResponse;
  targets: string[];
  onClose: () => void;
}) {
  const state = useStore(draft.store);
  const minimumDuration = Math.min(
    ...state.events.map((entry) => Math.max(1, entry.endSample - entry.startSample)),
  );
  const [baseRevision] = useState(snapshot.projectRevisionId);
  const [baseProjectId] = useState(snapshot.project.id);
  const [picker, setPicker] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const region = useRef<HTMLElement>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  useEffect(() => {
    draft.reconcile({
      project: snapshot.project,
      projectRevisionId: snapshot.projectRevisionId,
      targetIds: targets,
    });
  }, [draft, snapshot, targets]);
  useEffect(() => {
    region.current?.focus();
  }, []);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || busy || !region.current?.contains(document.activeElement))
        return;
      event.stopPropagation();
      if (picker !== null) {
        setPicker(null);
        buttons.current.get(picker)?.focus();
      } else onClose();
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [busy, onClose, picker]);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await api.project.commitEditTransaction({
        expectedProjectRevisionId: baseRevision,
        projectId: baseProjectId,
        transaction: draft.transaction(`transaction_${crypto.randomUUID().replaceAll("-", "")}`),
      });
      if (response.type === "desktop.error") setError(response.message);
      else onClose();
    } catch {
      setError("The draft could not be saved. Review it and try again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section ref={region} tabIndex={-1} aria-label="Chord Editor" className="chord-editor">
      <h3>Chord Editor</h3>
      <p>Changes stay in this draft until Save. Durations must fill the saved span.</p>
      {state.stale && (
        <p role="alert">
          The Project or revision changed. Cancel this draft and reopen the editor from the current
          saved version.
        </p>
      )}
      {state.errors.map((message) => (
        <p role="alert" key={message}>
          {message}
        </p>
      ))}
      {error !== null && <p role="alert">{error}</p>}
      <fieldset disabled={busy || state.stale} className="editor-fields">
        <legend className="sr-only">Draft events</legend>
        <ul className="editor-rail" aria-label="Draft chord events">
          {state.events.map((event) => (
            <EditorEvent
              key={event.id}
              event={event}
              events={state.events}
              minimumDuration={minimumDuration}
              draft={draft}
              disabled={busy || state.stale}
              reviewed={state.reviewedIds.includes(event.id)}
              onChoose={() => setPicker(event.id)}
              buttonRef={(element) => {
                if (element === null) buttons.current.delete(event.id);
                else buttons.current.set(event.id, element);
              }}
            />
          ))}
        </ul>
        {picker !== null && (
          <ChordPicker
            key={picker}
            value={state.events.find(({ id }) => id === picker)!.value}
            onDone={(value) => {
              draft.setChord(picker, value);
              setPicker(null);
              buttons.current.get(picker)?.focus();
            }}
          />
        )}
      </fieldset>
      <div className="editor-actions">
        <button
          className="primary-button"
          type="button"
          disabled={
            busy || state.stale || !state.dirty || state.errors.length > 0 || picker !== null
          }
          onClick={() => void save()}
        >
          Save
        </button>
        <button className="secondary-button" type="button" disabled={busy} onClick={onClose}>
          Cancel
        </button>
        <button
          className="quiet-button"
          type="button"
          disabled={busy}
          onClick={() => {
            draft.reset();
            setPicker(null);
            setError(null);
          }}
        >
          Reset draft
        </button>
      </div>
    </section>
  );
}

function EditorEvent({
  event,
  events,
  minimumDuration,
  reviewed,
  draft,
  disabled,
  onChoose,
  buttonRef,
}: {
  event: DraftEvent;
  events: DraftEvent[];
  minimumDuration: number;
  reviewed: boolean;
  draft: ReturnType<typeof createEditorDraft>;
  disabled: boolean;
  onChoose: () => void;
  buttonRef: (element: HTMLButtonElement | null) => void;
}) {
  const element = useRef<HTMLLIElement>(null);
  const handle = useRef<HTMLButtonElement>(null);
  const [target, setTarget] = useState("");
  const [indicator, setIndicator] = useState<"before" | "after" | null>(null);
  const [announcement, setAnnouncement] = useState("");
  useEffect(() => {
    const node = element.current;
    const dragHandle = handle.current;
    if (node === null || dragHandle === null) return undefined;
    const side = (x: number) =>
      x < node.getBoundingClientRect().left + node.getBoundingClientRect().width / 2
        ? ("before" as const)
        : ("after" as const);
    return combine(
      draggable({
        element: node,
        dragHandle,
        canDrag: () => !disabled,
        getInitialData: () => ({
          kind: "chord-draft",
          sessionKey: draft.store.getState().key,
          eventId: event.id,
        }),
      }),
      dropTargetForElements({
        element: node,
        canDrop: ({ source }) =>
          !disabled &&
          source.data.kind === "chord-draft" &&
          source.data.sessionKey === draft.store.getState().key &&
          source.data.eventId !== event.id,
        getData: ({ input }) => ({ side: side(input.clientX) }),
        onDragEnter: ({ location }) => setIndicator(side(location.current.input.clientX)),
        onDrag: ({ location }) => setIndicator(side(location.current.input.clientX)),
        onDragLeave: () => setIndicator(null),
        onDrop: ({ source, location }) => {
          setIndicator(null);
          if (typeof source.data.eventId === "string" && !disabled) {
            draft.move(source.data.eventId, event.id, side(location.current.input.clientX));
            setAnnouncement(
              `Chord moved ${side(location.current.input.clientX)} ${chordLabel(event.value)}`,
            );
          }
        },
      }),
    );
  }, [disabled, draft, event.id, event.value]);
  const move = (side: "before" | "after") => {
    draft.move(event.id, target, side);
    setAnnouncement(`Chord moved ${side} the selected event`);
  };
  return (
    <li
      ref={element}
      className="editor-event"
      style={{
        flexBasis: `${(Math.max(1, event.endSample - event.startSample) / minimumDuration) * 224}px`,
      }}
      data-event-id={event.id}
      data-drop-side={indicator ?? undefined}
    >
      <button
        ref={handle}
        type="button"
        className="quiet-button editor-drag-handle"
        aria-label="Drag chord"
      >
        ⋮⋮
      </button>
      <strong title={chordLabel(event.value)}>{chordLabel(event.value)}</strong>
      <button type="button" className="secondary-button" ref={buttonRef} onClick={onChoose}>
        Choose chord
      </button>
      <div className="editor-review-action">
        {draft.isAbstained(event.id) && !reviewed && <span>Unasserted candidate</span>}
        {draft.needsReview(event.id) && (
          <button
            type="button"
            className="quiet-button"
            disabled={reviewed}
            onClick={() => draft.markReviewed(event.id)}
          >
            {reviewed ? "Reviewed in draft" : "Mark reviewed"}
          </button>
        )}
      </div>
      <label>
        Duration{" "}
        <select
          aria-label="Duration"
          value={event.endSample - event.startSample}
          onChange={(change) => draft.setDuration(event.id, Number(change.target.value))}
        >
          <option value={event.endSample - event.startSample}>Current duration</option>
          {draft.durationOptions(event.id).map(({ label, samples }) => (
            <option key={label} value={samples}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Move target{" "}
        <select
          aria-label="Move target"
          value={target}
          onChange={(change) => setTarget(change.target.value)}
        >
          <option value="">Choose another event</option>
          {events
            .filter(({ id }) => id !== event.id)
            .map((entry) => (
              <option key={entry.id} value={entry.id}>
                {events.indexOf(entry) + 1}. {chordLabel(entry.value)}
              </option>
            ))}
        </select>
      </label>
      <div className="editor-move-actions">
        <button
          type="button"
          className="quiet-button"
          disabled={target === ""}
          onClick={() => move("before")}
        >
          Move before
        </button>
        <button
          type="button"
          className="quiet-button"
          disabled={target === ""}
          onClick={() => move("after")}
        >
          Move after
        </button>
      </div>
      <output className="sr-only" aria-live="polite">
        {announcement}
      </output>
      {indicator !== null && (
        <span className="drop-indicator" aria-hidden="true">
          Insert {indicator}
        </span>
      )}
    </li>
  );
}

const pitches = [
  "C",
  "C#",
  "Db",
  "D",
  "D#",
  "Eb",
  "E",
  "F",
  "F#",
  "Gb",
  "G",
  "G#",
  "Ab",
  "A",
  "A#",
  "Bb",
  "B",
] as const;
const qualities = [
  "major",
  "minor",
  "diminished",
  "augmented",
  "sus2",
  "sus4",
  "major7",
  "minor7",
  "diminished7",
  "half_diminished",
] as const;
function ChordPicker({
  value,
  onDone,
}: {
  value: DraftEvent["value"];
  onDone: (value: DraftEvent["value"]) => void;
}) {
  const [next, setNext] = useState(value);
  const rootSelect = useRef<HTMLSelectElement>(null);
  useEffect(() => {
    rootSelect.current?.focus();
  }, []);
  return (
    <fieldset className="chord-picker" aria-label="Chord picker">
      <label>
        Root{" "}
        <select
          ref={rootSelect}
          value={next.kind === "no_chord" ? "N" : next.root}
          onChange={(event) =>
            setNext(
              event.target.value === "N"
                ? { kind: "no_chord" }
                : {
                    ...(next.kind === "chord"
                      ? next
                      : {
                          kind: "chord",
                          quality: "major",
                          extensions: [],
                          additions: [],
                          alterations: [],
                          omissions: [],
                        }),
                    root: pitches.find((pitch) => pitch === event.target.value) ?? "C",
                  },
            )
          }
        >
          <option value="N">N — no chord</option>
          {pitches.map((pitch) => (
            <option key={pitch}>{pitch}</option>
          ))}
        </select>
      </label>
      {next.kind === "chord" && (
        <>
          <label>
            Quality{" "}
            <select
              value={next.quality}
              onChange={(event) =>
                setNext({
                  ...next,
                  quality: qualities.find((quality) => quality === event.target.value) ?? "major",
                })
              }
            >
              {qualities.map((quality) => (
                <option key={quality} value={quality}>
                  {quality.replaceAll("_", " ")}
                </option>
              ))}
            </select>
          </label>
          <label>
            Bass (optional){" "}
            <select
              value={next.bass ?? ""}
              onChange={(event) => {
                const chord = { ...next };
                if (event.target.value === "") delete chord.bass;
                else chord.bass = pitches.find((pitch) => pitch === event.target.value) ?? "C";
                setNext(chord);
              }}
            >
              <option value="">No separate bass</option>
              {pitches.map((pitch) => (
                <option key={pitch}>{pitch}</option>
              ))}
            </select>
          </label>
        </>
      )}
      <button type="button" className="secondary-button" onClick={() => onDone(next)}>
        Done
      </button>
    </fieldset>
  );
}

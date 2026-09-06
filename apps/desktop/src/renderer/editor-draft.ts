import {
  canonicalSerialize,
  materializeEffectiveTimeline,
  parseProjectContract,
  type EditTransaction,
  type ProjectContract,
} from "@open-chords/domain";
import { createStore } from "zustand/vanilla";

type ChordEvent = ProjectContract["analysisRevisions"][number]["timeline"]["chordEvents"][number];
export type DraftEvent = Pick<ChordEvent, "id" | "startSample" | "endSample" | "value">;
type DraftInput = { project: ProjectContract; projectRevisionId: string; targetIds: string[] };

const draftKey = (input: DraftInput) =>
  canonicalSerialize([
    input.project.id,
    input.projectRevisionId,
    input.project.activeView?.analysisRevisionId,
    input.targetIds,
  ]);

export function createEditorDraft(input: DraftInput) {
  const project = structuredClone(input.project);
  const active = project.activeView;
  if (active === null) throw new Error("An Analysis Revision is required to edit");
  const effective = materializeEffectiveTimeline(project);
  const base = effective.chordEvents
    .filter((event) => input.targetIds.includes(event.id))
    .map(({ id, startSample, endSample, value }) => ({ id, startSample, endSample, value }));
  if (base.length === 0 || base.length !== new Set(input.targetIds).size)
    throw new Error("Editor target is unavailable");
  const layer = project.editLayers.find((candidate) => candidate.id === active.editLayerId)!;
  const parentTransactionId = layer.transactions[active.editHistoryPosition - 1]?.id ?? null;
  const key = draftKey(input);
  const store = createStore<{
    dirty: boolean;
    events: DraftEvent[];
    errors: string[];
    key: string;
    stale: boolean;
  }>(() => ({ dirty: false, events: structuredClone(base), errors: [], key, stale: false }));
  const operationsFor = (events: DraftEvent[]): EditTransaction["operations"] => {
    if (
      events.some(
        (event, index) =>
          event.id !== base[index]?.id ||
          event.startSample !== base[index]?.startSample ||
          event.endSample !== base[index]?.endSample,
      )
    )
      return [
        {
          type: "replace_chord_sequence",
          targetEventIds: base.map((event) => event.id),
          events: structuredClone(events),
        },
      ];
    return events
      .filter(
        (event, index) =>
          canonicalSerialize(event.value) !== canonicalSerialize(base[index]?.value),
      )
      .map((event) => ({
        type: "replace_chord_value",
        eventId: event.id,
        value: structuredClone(event.value),
      }));
  };
  const grid = new Set(
    effective.chordEvents.flatMap(({ startSample, endSample }) => [startSample, endSample]),
  );
  for (const bar of effective.bars) {
    const boundaries = [...bar.beats.map(({ atSample }) => atSample), bar.endSample];
    for (let index = 0; index < boundaries.length - 1; index += 1) {
      for (let subdivision = 0; subdivision <= 4; subdivision += 1)
        grid.add(
          Math.round(
            boundaries[index]! + ((boundaries[index + 1]! - boundaries[index]!) * subdivision) / 4,
          ),
        );
    }
  }
  const update = (events: DraftEvent[]) => {
    const dirty = canonicalSerialize(events) !== canonicalSerialize(base);
    const errors: string[] = [];
    if (events.some(({ startSample, endSample }) => !grid.has(startSample) || !grid.has(endSample)))
      errors.push("New boundaries must snap to a quarter-beat subdivision.");
    if (dirty) {
      try {
        const candidate = structuredClone(project);
        const candidateLayer = candidate.editLayers.find(
          (entry) => entry.id === active.editLayerId,
        )!;
        let suffix = candidateLayer.transactions.length;
        while (
          candidate.editLayers.some((entry) =>
            entry.transactions.some(({ id }) => id === `transaction_draft_validation_${suffix}`),
          )
        )
          suffix += 1;
        const id = `transaction_draft_validation_${suffix}`;
        candidateLayer.transactions.push({
          id,
          parentTransactionId,
          operations: operationsFor(events),
        });
        candidate.activeView!.editHistoryPosition = candidateLayer.transactions.length;
        parseProjectContract(candidate);
      } catch {
        errors.push("Durations must be positive and fill the saved span without gaps or overlap.");
      }
    }
    store.setState({ events, dirty, errors });
  };
  const reflow = (events: DraftEvent[]) => {
    let startSample = base[0]!.startSample;
    return events.map((event) => {
      const duration = event.endSample - event.startSample;
      const next = { ...event, startSample, endSample: startSample + duration };
      startSample = next.endSample;
      return next;
    });
  };
  return {
    store,
    reconcile(next: DraftInput) {
      if (draftKey(next) !== key) store.setState({ stale: true });
    },
    durationOptions(eventId: string) {
      const event = store.getState().events.find(({ id }) => id === eventId);
      const bar = effective.bars.find(
        (entry) =>
          event !== undefined &&
          event.startSample >= entry.startSample &&
          event.startSample < entry.endSample,
      );
      if (event === undefined || bar === undefined) return [];
      const boundaries = [...bar.beats.map(({ atSample }) => atSample), bar.endSample];
      const beatIndex = Math.max(
        0,
        boundaries.findIndex((sample) => sample > event.startSample) - 1,
      );
      const beatDuration = boundaries[beatIndex + 1]! - boundaries[beatIndex]!;
      return [0.25, 0.5, 1, 2, 3, 4]
        .map((beats) => ({
          label: `${beats} ${beats === 1 ? "beat" : "beats"}`,
          samples: Math.max(1, Math.round(beatDuration * beats)),
        }))
        .concat([{ label: "Whole bar", samples: bar.endSample - bar.startSample }]);
    },
    setChord(eventId: string, value: DraftEvent["value"]) {
      update(
        store
          .getState()
          .events.map((event) =>
            event.id === eventId ? { ...event, value: structuredClone(value) } : event,
          ),
      );
    },
    setDuration(eventId: string, durationSamples: number) {
      update(
        reflow(
          store
            .getState()
            .events.map((event) =>
              event.id === eventId
                ? { ...event, endSample: event.startSample + durationSamples }
                : event,
            ),
        ),
      );
    },
    move(eventId: string, targetId: string, side: "before" | "after") {
      if (eventId === targetId) return;
      const events = [...store.getState().events];
      const source = events.find((event) => event.id === eventId);
      if (source === undefined || !events.some((event) => event.id === targetId))
        throw new Error("Reorder target is unavailable");
      const remaining = events.filter((event) => event.id !== eventId);
      remaining.splice(
        remaining.findIndex((event) => event.id === targetId) + (side === "after" ? 1 : 0),
        0,
        source,
      );
      update(reflow(remaining));
    },
    reset() {
      store.setState({ events: structuredClone(base), dirty: false, errors: [] });
    },
    transaction(id: string): EditTransaction {
      if (store.getState().stale || !store.getState().dirty || store.getState().errors.length > 0)
        throw new Error("Draft is not ready to save");
      return { id, parentTransactionId, operations: operationsFor(store.getState().events) };
    },
  };
}

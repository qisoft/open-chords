import { readFileSync } from "node:fs";

import { materializeEffectiveTimeline, parseProjectContract } from "@open-chords/domain";
import { expect, it } from "vitest";

import { createEditorDraft } from "../apps/desktop/src/renderer/editor-draft.ts";

function projectFixture() {
  const fixture = JSON.parse(
    readFileSync(
      new URL("../packages/testkit/contracts/v1/valid/project-envelope.json", import.meta.url),
      "utf8",
    ),
  );
  return parseProjectContract(fixture.payload);
}

it("isolates chord changes in one session and resets to the committed base", () => {
  const project = projectFixture();
  const before = materializeEffectiveTimeline(project);
  const draft = createEditorDraft({
    project,
    projectRevisionId: "projectrevision_base",
    targetIds: ["chord_am7_e"],
  });
  draft.setChord("chord_am7_e", { kind: "no_chord" });
  expect(draft.store.getState().dirty).toBe(true);
  expect(materializeEffectiveTimeline(project)).toEqual(before);
  const second = createEditorDraft({
    project,
    projectRevisionId: "projectrevision_base",
    targetIds: ["chord_am7_e"],
  });
  expect(second.store.getState().dirty).toBe(false);
  expect(draft.transaction("transaction_draft").operations).toEqual([
    { type: "replace_chord_value", eventId: "chord_am7_e", value: { kind: "no_chord" } },
  ]);
  draft.reset();
  expect(draft.store.getState().dirty).toBe(false);
  expect(draft.store.getState().events[0]?.value).toEqual(before.chordEvents[0]?.value);
});

it("validates duration conflicts and reorders stable identities before one atomic transaction", () => {
  const project = projectFixture();
  const before = materializeEffectiveTimeline(project);
  const draft = createEditorDraft({
    project,
    projectRevisionId: "projectrevision_base",
    targetIds: before.chordEvents.map((event) => event.id),
  });
  draft.setDuration("chord_am7_e", 4000);
  expect(draft.store.getState().errors.length).toBeGreaterThan(0);
  expect(() => draft.transaction("transaction_invalid")).toThrow("Draft is not ready to save");
  expect(materializeEffectiveTimeline(project)).toEqual(before);
  draft.reset();
  draft.move("chord_am7_e", "chord_g7", "after");
  const transaction = draft.transaction("transaction_reorder");
  const edited = structuredClone(project);
  edited.editLayers[0]!.transactions.push(transaction);
  edited.activeView!.editHistoryPosition = edited.editLayers[0]!.transactions.length;
  const result = materializeEffectiveTimeline(parseProjectContract(edited));
  expect(result.chordEvents.map((event) => event.id)).toEqual([
    "chord_c_sharp",
    "chord_n",
    "chord_g7",
    "chord_am7_e",
  ]);
  expect(result.chordEvents.at(-1)).toMatchObject({ startSample: 40000, endSample: 48000 });
  expect(edited.analysisRevisions).toEqual(project.analysisRevisions);
});

it("invalidates a session across committed revisions and uses actual metrical capacity", () => {
  const project = projectFixture();
  const draft = createEditorDraft({
    project,
    projectRevisionId: "projectrevision_base",
    targetIds: ["chord_am7_e"],
  });
  expect(draft.durationOptions("chord_am7_e")).toContainEqual({
    label: "Whole bar",
    samples: 8000,
  });
  const three = createEditorDraft({
    project,
    projectRevisionId: "projectrevision_base",
    targetIds: ["chord_c_sharp"],
  });
  expect(three.durationOptions("chord_c_sharp")).toContainEqual({
    label: "Whole bar",
    samples: 24000,
  });
  draft.setChord("chord_am7_e", { kind: "no_chord" });
  draft.reconcile({
    project,
    projectRevisionId: "projectrevision_changed",
    targetIds: ["chord_am7_e"],
  });
  expect(draft.store.getState().stale).toBe(true);
  expect(() => draft.transaction("transaction_stale")).toThrow("Draft is not ready to save");
  draft.reset();
  expect(draft.store.getState().stale).toBe(true);
  expect(draft.store.getState().dirty).toBe(false);
});

it("rejects off-subdivision boundaries even when durations fill the saved span", () => {
  const project = projectFixture();
  const draft = createEditorDraft({
    project,
    projectRevisionId: "projectrevision_base",
    targetIds: materializeEffectiveTimeline(project).chordEvents.map(({ id }) => id),
  });
  draft.setDuration("chord_am7_e", 8001);
  draft.setDuration("chord_c_sharp", 11999);
  expect(draft.store.getState().errors).toContain(
    "New boundaries must snap to a quarter-beat subdivision.",
  );
  expect(() => draft.transaction("transaction_unsnapped")).toThrow("Draft is not ready to save");
  draft.setDuration("chord_am7_e", 16000);
  draft.setDuration("chord_c_sharp", 4000);
  expect(draft.store.getState().errors).toEqual([]);
  expect(draft.transaction("transaction_snapped").operations[0]).toMatchObject({
    type: "replace_chord_sequence",
  });
});

it("explicitly reviews an unchanged chord without overwriting machine evidence", () => {
  const project = projectFixture();
  const before = materializeEffectiveTimeline(project);
  const draft = createEditorDraft({
    project,
    projectRevisionId: "projectrevision_base",
    targetIds: ["chord_g7"],
  });
  draft.markReviewed("chord_g7");
  expect(draft.store.getState().dirty).toBe(true);
  const transaction = draft.transaction("transaction_reviewed");
  const edited = structuredClone(project);
  edited.editLayers[0]!.transactions.push(transaction);
  edited.activeView!.editHistoryPosition = edited.editLayers[0]!.transactions.length;
  const result = materializeEffectiveTimeline(parseProjectContract(edited));
  expect(result.chordEvents[3]!.value).toEqual(before.chordEvents[3]!.value);
  expect(result.chordEvents[3]!.assertion).toMatchObject({
    state: "asserted",
    reasonCodes: ["user_authored"],
  });
  expect(edited.analysisRevisions).toEqual(project.analysisRevisions);
  draft.reset();
  expect(draft.store.getState().dirty).toBe(false);
});

it("treats choosing an abstained candidate as an explicit user assertion", () => {
  const project = projectFixture();
  const candidate = materializeEffectiveTimeline(project).chordEvents[1]!;
  expect(candidate.assertion.state).toBe("abstained");
  const draft = createEditorDraft({
    project,
    projectRevisionId: "projectrevision_base",
    targetIds: [candidate.id],
  });
  draft.setChord(candidate.id, candidate.value);
  expect(draft.store.getState().dirty).toBe(true);
  expect(draft.transaction("transaction_asserted").operations).toEqual([
    { type: "replace_chord_value", eventId: candidate.id, value: candidate.value },
  ]);
});

it("invalidates a dirty draft when the active view disappears", () => {
  const project = projectFixture();
  const draft = createEditorDraft({
    project,
    projectRevisionId: "projectrevision_base",
    targetIds: ["chord_am7_e"],
  });
  draft.setChord("chord_am7_e", { kind: "no_chord" });
  const next = structuredClone(project);
  next.activeView = null;
  expect(() =>
    draft.reconcile({ project: next, projectRevisionId: "projectrevision_changed", targetIds: [] }),
  ).not.toThrow();
  expect(draft.store.getState().stale).toBe(true);
  expect(() => draft.transaction("transaction_stale")).toThrow("Draft is not ready to save");
  draft.reset();
  expect(draft.store.getState().stale).toBe(true);
});

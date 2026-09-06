import { z } from "zod";

import { materializeEffectiveTimeline } from "./projection.ts";
import {
  ActiveViewSchema,
  PracticeStateSchema,
  StableIdSchema,
  type ProjectContract,
} from "./schema.ts";

export const PracticeActionSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("set_loop"),
    firstBarId: StableIdSchema,
    lastBarId: StableIdSchema,
  }),
  z.strictObject({ type: z.literal("clear_loop") }),
  z.strictObject({
    type: z.literal("settings"),
    ...PracticeStateSchema.omit({ loop: true }).partial().shape,
    ...ActiveViewSchema.shape.presentation.partial().shape,
  }),
]);
export type PracticeAction = z.infer<typeof PracticeActionSchema>;
export type PracticeState = z.infer<typeof PracticeStateSchema>;

export function getPracticeState(project: ProjectContract): PracticeState {
  return structuredClone(
    project.practice ?? {
      loop: null,
      speed: 1,
      countInBars: 0,
      metronome: false,
      autoscroll: true,
      instrument: "guitar",
    },
  );
}

export function resolvePracticeLoop(
  project: ProjectContract,
): { startSample: number; endSample: number } | null {
  const loop = getPracticeState(project).loop;
  if (
    loop === null ||
    loop.status !== "ready" ||
    project.activeView?.analysisRevisionId !== loop.analysisRevisionId
  )
    return null;
  const bars = materializeEffectiveTimeline(project).bars;
  const first = bars.findIndex(({ id }) => id === loop.firstBarId);
  const last = bars.findIndex(({ id }) => id === loop.lastBarId);
  if (first < 0 || last < first) return null;
  for (let index = first; index < last; index += 1) {
    if (bars[index]!.endSample !== bars[index + 1]!.startSample) return null;
  }
  return { startSample: bars[first]!.startSample, endSample: bars[last]!.endSample };
}

export function applyPracticeAction(
  input: ProjectContract,
  rawAction: PracticeAction,
): ProjectContract {
  const action = PracticeActionSchema.parse(rawAction);
  const project = structuredClone(input);
  const practice = getPracticeState(project);
  if (action.type === "clear_loop") practice.loop = null;
  else if (action.type === "settings") {
    const {
      type: _type,
      transposeSemitones,
      beginnerView,
      enharmonicPreference,
      ...settings
    } = action;
    Object.assign(practice, settings);
    if (project.activeView !== null) {
      const presentation = project.activeView.presentation;
      if (transposeSemitones !== undefined) presentation.transposeSemitones = transposeSemitones;
      if (beginnerView !== undefined) presentation.beginnerView = beginnerView;
      if (enharmonicPreference !== undefined)
        presentation.enharmonicPreference = enharmonicPreference;
    }
  } else {
    if (project.activeView === null) throw new Error("An active Analysis Revision is required");
    practice.loop = {
      analysisRevisionId: project.activeView.analysisRevisionId,
      firstBarId: action.firstBarId,
      lastBarId: action.lastBarId,
      status: "ready",
    };
  }
  project.practice = practice;
  if (action.type === "set_loop" && resolvePracticeLoop(project) === null)
    throw new Error("Loop must cover contiguous active Bars");
  return project;
}

export function reconcilePracticeState(
  before: ProjectContract,
  input: ProjectContract,
): ProjectContract {
  const project = structuredClone(input);
  const loop = project.practice?.loop;
  if (loop === undefined || loop === null || loop.status === "needs_review") return project;
  if (
    project.activeView?.analysisRevisionId !== loop.analysisRevisionId ||
    before.activeView === null
  ) {
    loop.status = "needs_review";
    return project;
  }
  const oldBars = materializeEffectiveTimeline(before).bars;
  const newBars = materializeEffectiveTimeline(project).bars;
  const structural =
    oldBars.map(({ id }) => id).join("|") !== newBars.map(({ id }) => id).join("|");
  const anchorsChanged = [loop.firstBarId, loop.lastBarId].some((id) => {
    const old = oldBars.find((bar) => bar.id === id);
    const next = newBars.find((bar) => bar.id === id);
    return (
      old === undefined ||
      next === undefined ||
      old.startSample !== next.startSample ||
      old.endSample !== next.endSample
    );
  });
  if ((structural && anchorsChanged) || resolvePracticeLoop(project) === null)
    loop.status = "needs_review";
  return project;
}

export function practiceCountIn(
  project: ProjectContract,
  position: number,
): { beatCount: number; beatSeconds: number; durationSeconds: number } | null {
  const settings = getPracticeState(project);
  if (settings.countInBars === 0 || project.activeView === null) return null;
  const bar = materializeEffectiveTimeline(project).bars.find(
    (candidate) => candidate.startSample <= position && candidate.endSample > position,
  );
  if (bar === undefined) return null;
  const gaps = bar.beats
    .map((beat, index) => (bar.beats[index + 1]?.atSample ?? bar.endSample) - beat.atSample)
    .filter((gap) => gap > 0)
    .toSorted((a, b) => a - b);
  const beatSamples = gaps[Math.floor(gaps.length / 2)];
  if (beatSamples === undefined) return null;
  const beatCount = bar.meter.numerator * settings.countInBars;
  const beatSeconds = beatSamples / project.sampleRate / settings.speed;
  return { beatCount, beatSeconds, durationSeconds: beatCount * beatSeconds };
}

export function practiceNavigation(
  project: ProjectContract,
  position: number,
  kind: "chord" | "bar",
  direction: -1 | 1,
): number {
  if (project.activeView === null) return direction === -1 ? 0 : project.durationSamples;
  const timeline = materializeEffectiveTimeline(project);
  const starts = (kind === "bar" ? timeline.bars : timeline.chordEvents).map(
    ({ startSample }) => startSample,
  );
  return direction === -1
    ? (starts.findLast((sample) => sample < position) ?? 0)
    : (starts.find((sample) => sample > position) ?? project.durationSamples);
}

import {
  getPracticeState,
  materializeEffectiveTimeline,
  practiceCountIn,
  resolvePracticeLoop,
  type ProjectContract,
} from "@open-chords/domain";
import { useEffect, useRef, useState, type RefObject } from "react";

import type { PlaybackClock } from "./playback-clock.ts";

export function usePracticeAudio(
  project: ProjectContract,
  revision: string,
  source: RefObject<HTMLAudioElement | null>,
  clock: PlaybackClock | null,
) {
  const context = useRef<AudioContext | null>(null);
  const nodes = useRef(new Set<OscillatorNode>());
  const metronomeNodes = useRef(new Set<OscillatorNode>());
  const cancelPending = useRef<(() => void) | null>(null);
  const [counting, setCounting] = useState(false);
  const [status, setStatus] = useState("");
  const generation = useRef(0);
  const previousGrid = useRef("");
  const getContext = () => {
    context.current ??= new AudioContext();
    return context.current;
  };
  const silence = () => {
    for (const node of nodes.current) {
      node.stop();
      node.disconnect();
    }
    nodes.current.clear();
    metronomeNodes.current.clear();
  };
  const silenceMetronome = () => {
    for (const node of metronomeNodes.current) {
      node.stop();
      node.disconnect();
      nodes.current.delete(node);
    }
    metronomeNodes.current.clear();
  };
  const cancel = () => {
    generation.current += 1;
    cancelPending.current?.();
    cancelPending.current = null;
    silence();
    setCounting(false);
    setStatus("");
  };
  const click = (audioContext: AudioContext, at: number, accent: boolean, countIn = false) => {
    const node = audioContext.createOscillator();
    const gain = audioContext.createGain();
    node.frequency.value = accent ? 1200 : 800;
    gain.gain.setValueAtTime(0.12, at);
    gain.gain.exponentialRampToValueAtTime(0.001, at + 0.035);
    node.connect(gain).connect(audioContext.destination);
    nodes.current.add(node);
    if (!countIn) metronomeNodes.current.add(node);
    node.onended = () => {
      nodes.current.delete(node);
      metronomeNodes.current.delete(node);
      node.disconnect();
      gain.disconnect();
    };
    node.start(at);
    node.stop(at + 0.04);
  };
  useEffect(() => {
    cancel();
    const grid =
      project.activeView === null
        ? ""
        : materializeEffectiveTimeline(project)
            .bars.map(
              ({ id, beats, meter }) =>
                `${id}:${beats.map((beat) => beat.id).join(",")}:${meter.numerator}/${meter.denominator}`,
            )
            .join("|");
    if (previousGrid.current !== "" && previousGrid.current !== grid) source.current?.pause();
    previousGrid.current = grid;
    return cancel;
  }, [project, revision, source]);
  useEffect(
    () => () => {
      cancel();
      void context.current?.close();
    },
    [],
  );

  useEffect(() => {
    const settings = getPracticeState(project);
    if (!settings.metronome || project.activeView === null || clock === null) return undefined;
    const effectSource = source.current;
    const loop = resolvePracticeLoop(project);
    const beats = materializeEffectiveTimeline(project)
      .bars.flatMap((bar) => bar.beats)
      .filter(
        (beat) =>
          loop === null || (beat.atSample >= loop.startSample && beat.atSample < loop.endSample),
      );
    let lastPosition = -1;
    const scheduled = new Set<string>();
    const schedule = () => {
      const audio = source.current;
      const ctx = context.current;
      if (audio === null || audio.paused || counting || ctx === null || ctx.state !== "running")
        return;
      const position = clock.getSnapshot().positionSamples;
      if (position < lastPosition) {
        silenceMetronome();
        scheduled.clear();
      }
      lastPosition = position;
      const ahead = project.sampleRate * settings.speed * 0.1;
      for (const beat of beats) {
        if (
          beat.atSample < position - project.sampleRate * 0.02 ||
          beat.atSample > position + ahead ||
          scheduled.has(beat.id)
        )
          continue;
        scheduled.add(beat.id);
        click(
          ctx,
          ctx.currentTime +
            Math.max(0, (beat.atSample - position) / project.sampleRate / settings.speed),
          beat.role === "downbeat",
        );
      }
    };
    const reset = () => {
      silenceMetronome();
      scheduled.clear();
      lastPosition = -1;
    };
    effectSource?.addEventListener("seeking", reset);
    effectSource?.addEventListener("pause", reset);
    const timer = setInterval(schedule, 25);
    return () => {
      clearInterval(timer);
      effectSource?.removeEventListener("seeking", reset);
      effectSource?.removeEventListener("pause", reset);
      reset();
    };
  }, [project, clock, counting, source]);

  const toggle = async () => {
    const audio = source.current;
    if (audio === null || clock === null) return;
    if (counting || cancelPending.current !== null) {
      cancel();
      return;
    }
    if (!audio.paused) {
      audio.pause();
      cancel();
      return;
    }
    cancel();
    const token = generation.current;
    const settings = getPracticeState(project);
    if (settings.loop?.status === "needs_review") {
      setStatus("Loop needs review. Set it again or clear it before playback.");
      return;
    }
    const loop = resolvePracticeLoop(project);
    if (loop !== null) clock.seek(loop.startSample);
    else if (clock.getSnapshot().positionSamples >= project.durationSamples) clock.seek(0);
    const start = clock.getSnapshot().positionSamples;
    const plan = practiceCountIn(project, start);
    if (settings.countInBars > 0 && plan === null) {
      setStatus(
        "Count-in is unavailable without a metered Bar. Turn count-in off to play this region.",
      );
      return;
    }
    try {
      if (plan !== null || settings.metronome) {
        const ctx = getContext();
        await ctx.resume();
        if (token !== generation.current) return;
        if (plan !== null) {
          setCounting(true);
          setStatus(`Count-in: ${String(plan.beatCount)} beats`);
          const first = ctx.currentTime + 0.03;
          for (let index = 0; index < plan.beatCount; index += 1)
            click(ctx, first + index * plan.beatSeconds, index === 0, true);
          const completed = await new Promise<boolean>((resolve) => {
            let finished = false;
            const finish = (didComplete: boolean) => {
              if (finished) return;
              finished = true;
              cancelPending.current = null;
              resolve(didComplete);
            };
            const timer = setTimeout(() => finish(true), (plan.durationSeconds + 0.03) * 1000);
            cancelPending.current = () => {
              clearTimeout(timer);
              finish(false);
            };
          });
          if (!completed || token !== generation.current) return;
          setCounting(false);
        }
      }
      if (token !== generation.current) return;
      audio.preservesPitch = true;
      audio.playbackRate = settings.speed;
      await audio.play();
      if (token !== generation.current) audio.pause();
      else setStatus("");
    } catch {
      cancel();
      setStatus("Playback could not start. Check the verified Source.");
    }
  };
  return { cancel, counting, status, toggle };
}

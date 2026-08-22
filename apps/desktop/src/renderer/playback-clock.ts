export type PlaybackClockSnapshot = {
  playing: boolean;
  positionSamples: number;
};

type PlaybackSource = {
  addEventListener(name: string, listener: () => void): void;
  currentTime: number;
  paused: boolean;
  removeEventListener(name: string, listener: () => void): void;
};

type PlaybackClockOptions = {
  cancelFrame: (handle: number) => void;
  durationSamples?: number;
  requestFrame: (callback: FrameRequestCallback) => number;
  sampleRate: number;
  source: PlaybackSource;
  startSourceSample?: number;
};

export function createPlaybackClock(options: PlaybackClockOptions) {
  const listeners = new Set<() => void>();
  const startSourceSample = options.startSourceSample ?? 0;
  let frameHandle: number | null = null;
  let snapshot = readSnapshot();

  function readSnapshot(): PlaybackClockSnapshot {
    const sourceSamples = Math.round(options.source.currentTime * options.sampleRate);
    const projectSamples = Math.max(0, sourceSamples - startSourceSample);
    return {
      playing: !options.source.paused,
      positionSamples:
        options.durationSamples === undefined
          ? projectSamples
          : Math.min(options.durationSamples, projectSamples),
    };
  }

  const publish = () => {
    const next = readSnapshot();
    if (next.playing !== snapshot.playing || next.positionSamples !== snapshot.positionSamples) {
      snapshot = next;
      for (const listener of listeners) listener();
    }
  };

  const stopFrames = () => {
    if (frameHandle === null) return;
    options.cancelFrame(frameHandle);
    frameHandle = null;
  };

  const scheduleFrame = () => {
    if (frameHandle !== null || options.source.paused) return;
    frameHandle = options.requestFrame(() => {
      frameHandle = null;
      publish();
      scheduleFrame();
    });
  };

  const onPlay = () => {
    publish();
    scheduleFrame();
  };
  const onStopped = () => {
    stopFrames();
    publish();
  };
  const onPosition = () => publish();

  options.source.addEventListener("play", onPlay);
  options.source.addEventListener("pause", onStopped);
  options.source.addEventListener("ended", onStopped);
  options.source.addEventListener("seeked", onPosition);
  options.source.addEventListener("timeupdate", onPosition);

  return {
    dispose() {
      stopFrames();
      options.source.removeEventListener("play", onPlay);
      options.source.removeEventListener("pause", onStopped);
      options.source.removeEventListener("ended", onStopped);
      options.source.removeEventListener("seeked", onPosition);
      options.source.removeEventListener("timeupdate", onPosition);
      listeners.clear();
    },
    getSnapshot: () => snapshot,
    seek(positionSamples: number) {
      const bounded = Math.max(
        0,
        Math.min(options.durationSamples ?? Number.MAX_SAFE_INTEGER, Math.round(positionSamples)),
      );
      options.source.currentTime = (startSourceSample + bounded) / options.sampleRate;
      publish();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export type PlaybackClock = ReturnType<typeof createPlaybackClock>;

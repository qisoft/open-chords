import { describe, expect, it } from "vitest";

import { createPlaybackClock } from "../apps/desktop/src/renderer/playback-clock.ts";

describe("playback clock", () => {
  it("starts frame updates when the playback source is already playing", () => {
    let requestedFrames = 0;
    const source = {
      addEventListener: () => undefined,
      currentTime: 0.5,
      paused: false,
      removeEventListener: () => undefined,
    };

    const clock = createPlaybackClock({
      cancelFrame: () => undefined,
      requestFrame: () => {
        requestedFrames += 1;
        return 1;
      },
      sampleRate: 48_000,
      source,
    });

    expect(clock.getSnapshot()).toEqual({ playing: true, positionSamples: 24_000 });
    expect(requestedFrames).toBe(1);
    clock.dispose();
  });

  it("publishes frame positions without changing its subscription contract", () => {
    let frame: FrameRequestCallback | undefined;
    const listeners = new Map<string, Set<() => void>>();
    const source = {
      addEventListener(name: string, listener: () => void) {
        const group = listeners.get(name) ?? new Set();
        group.add(listener);
        listeners.set(name, group);
      },
      currentTime: 0,
      paused: true,
      removeEventListener(name: string, listener: () => void) {
        listeners.get(name)?.delete(listener);
      },
    };
    const clock = createPlaybackClock({
      cancelFrame: () => undefined,
      requestFrame: (callback) => {
        frame = callback;
        return 1;
      },
      sampleRate: 48_000,
      source,
    });
    let notifications = 0;
    let playingNotifications = 0;
    clock.subscribe(() => {
      notifications += 1;
    });
    clock.subscribeSelection(
      ({ playing }) => playing,
      () => {
        playingNotifications += 1;
      },
    );

    expect(clock.getSnapshot()).toEqual({ playing: false, positionSamples: 0 });
    expect(clock.getSnapshot()).toBe(clock.getSnapshot());
    source.paused = false;
    listeners.get("play")?.forEach((listener) => listener());
    source.currentTime = 0.25;
    frame?.(0);

    expect(clock.getSnapshot()).toEqual({ playing: true, positionSamples: 12_000 });
    expect(notifications).toBe(2);
    expect(playingNotifications).toBe(1);
  });
});

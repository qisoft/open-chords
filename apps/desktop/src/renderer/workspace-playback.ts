import type { OpenChordsDesktopApi } from "@open-chords/contracts";

type MediaPlaybackApi = Pick<OpenChordsDesktopApi["media"], "openPlayback">;

export type ProjectPlaybackRequest =
  | { kind: "error"; message: string }
  | { kind: "response"; response: Awaited<ReturnType<MediaPlaybackApi["openPlayback"]>> };

type LoopPlaybackSource = Pick<HTMLMediaElement, "ended" | "play">;

export async function continueLoopAtBoundary(
  source: LoopPlaybackSource,
  loopStartSample: number,
  seek: (positionSamples: number) => void,
): Promise<string | null> {
  const ended = source.ended;
  seek(loopStartSample);
  if (!ended) return null;
  try {
    await source.play();
    return null;
  } catch {
    return "Playback could not resume the loop. Check the verified Source.";
  }
}

export async function requestProjectPlayback(
  api: MediaPlaybackApi,
  projectId: string,
): Promise<ProjectPlaybackRequest> {
  try {
    return { kind: "response", response: await api.openPlayback(projectId) };
  } catch {
    return { kind: "error", message: "Could not prepare the verified Source for playback." };
  }
}

import type { OpenChordsDesktopApi } from "@open-chords/contracts";

type MediaPlaybackApi = Pick<OpenChordsDesktopApi["media"], "openPlayback">;

export type ProjectPlaybackRequest =
  | { kind: "error"; message: string }
  | { kind: "response"; response: Awaited<ReturnType<MediaPlaybackApi["openPlayback"]>> };

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

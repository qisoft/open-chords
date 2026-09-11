import {
  YouTubeActionSchema,
  type YouTubeAction,
  type YouTubePlayerState,
} from "@open-chords/contracts";

import type { AcquisitionJobs } from "./acquisition-jobs.ts";
import type { NetworkMode } from "./network-mode.ts";
import type { ProjectLibrary } from "./project-library.ts";
import { canonicalYouTubeSource, type YouTubeMetadata } from "./youtube-source.ts";

export type YouTubePlayer = {
  open(videoId: string): Promise<void>;
  command(
    action: Extract<YouTubeAction, { type: "play" | "pause" | "seek" | "set_rate" }>,
  ): Promise<void>;
  state(): Promise<YouTubePlayerState | null>;
  close(): void;
};

type YouTubeServiceOptions = {
  library: ProjectLibrary;
  acquisition?: AcquisitionJobs;
  network: NetworkMode;
  metadata: YouTubeMetadata;
  player?: YouTubePlayer;
  openExternal?: (url: string) => Promise<void>;
};
export class YouTubeService {
  readonly #options: YouTubeServiceOptions;
  readonly #unsubscribe: () => void;
  #busy = false;
  #epoch = 0;
  #controller: AbortController | null = null;
  constructor(options: YouTubeServiceOptions) {
    this.#options = options;
    this.#unsubscribe = options.network.subscribe(() => {
      this.#cancelMetadata();
      if (options.network.offline) options.player?.close();
    });
  }
  cancel() {
    this.#cancelMetadata();
    this.#options.player?.close();
  }
  #cancelMetadata() {
    this.#controller?.abort();
    this.#epoch++;
    this.#options.metadata.cancel();
  }
  close() {
    this.cancel();
    this.#options.metadata.close();
    this.#unsubscribe();
  }

  async perform(raw: YouTubeAction) {
    const action = YouTubeActionSchema.parse(raw);
    const { network, metadata, library, player } = this.#options;
    const control = [
      "status",
      "cancel",
      "set_offline",
      "close_player",
      "acquire",
      "cancel_acquisition",
      "clear_acquisition_history",
    ].includes(action.type);
    if (!control && this.#busy) throw new Error("YouTube operation is busy");
    if (!control) this.#busy = true;
    try {
      if (action.type === "acquire") {
        if (!this.#options.acquisition)
          throw new Error("Acquisition is unavailable. Open an authorized local recording.");
        await this.#options.acquisition.start({ url: action.url });
      }
      if (action.type === "cancel_acquisition")
        await this.#options.acquisition?.cancel(action.jobId);
      if (action.type === "clear_acquisition_history")
        await this.#options.acquisition?.clearHistory();
      if (action.type === "set_offline") await network.setOffline(action.offline);
      if (action.type === "cancel") this.cancel();
      if (action.type === "close_player") player?.close();
      if (!control && network.offline) throw new Error("Offline Mode is enabled");
      if (action.type === "refresh") {
        const controller = new AbortController();
        this.#controller = controller;
        const epoch = this.#epoch;
        const result = await metadata.observe(action.url);
        if (epoch !== this.#epoch || network.offline) throw new Error("Metadata request cancelled");
        await library.observeYouTubeSource(
          result.source.identity.videoId,
          result.observation,
          controller.signal,
        );
      }
      if (action.type === "open_player") {
        if (!player) throw new Error("YouTube player is unavailable");
        await player.open(canonicalYouTubeSource(action.url).identity.videoId);
      }
      if (action.type === "open_external") {
        if (!this.#options.openExternal) throw new Error("External browser is unavailable");
        await this.#options.openExternal(canonicalYouTubeSource(action.url).canonicalUrl);
      }
      if (
        action.type === "play" ||
        action.type === "pause" ||
        action.type === "seek" ||
        action.type === "set_rate"
      ) {
        if (!player) throw new Error("YouTube player is unavailable");
        await player.command(action);
      }
      const sources = (await library.listYouTubeSources())
        .slice(-100)
        .reverse()
        .map((source) => {
          if (source.identity.kind !== "youtube") throw new Error("Invalid Source identity");
          const latest = source.metadataObservations.at(-1);
          return {
            id: source.id,
            snapshots: source.snapshots.map(({ id, durationSamples }) => ({ id, durationSamples })),
            videoId: source.identity.videoId,
            title: latest?.title,
            uploader: latest?.uploader,
            observedAt: latest?.observedAt,
          };
        });
      return {
        offline: network.offline,
        sources,
        player: (await player?.state()) ?? null,
        acquisitionJobs: (this.#options.acquisition?.list() ?? [])
          .slice(-100)
          .reverse()
          .map(({ id, videoId, state, stage, reason, snapshotId }) => ({
            id,
            videoId,
            state,
            stage,
            reason,
            snapshotId,
          })),
      };
    } finally {
      if (!control) this.#busy = false;
    }
  }
}

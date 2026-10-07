import { UpdateActionSchema, UpdateReleaseSchema, type UpdateStatus } from "@open-chords/contracts";
import { z } from "zod";

import type { NetworkMode } from "./network-mode.ts";

export const RELEASE_METADATA_URL =
  "https://api.github.com/repos/qisoft/open-chords/releases/latest";
const REPOSITORY = "https://github.com/qisoft/open-chords";
const VERIFICATION_URL = `${REPOSITORY}/blob/main/docs/distribution/installing.md`;
const MAX_METADATA_BYTES = 1024 * 1024;
const metadataSchema = z.object({
  tag_name: UpdateReleaseSchema.shape.tag,
  name: z.string().max(200).nullable(),
  body: z.string().max(64000).nullable(),
  published_at: z.iso.datetime(),
  draft: z.literal(false),
  prerelease: z.literal(false),
  assets: z
    .array(
      z.object({
        name: z.string().min(1).max(200),
        size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        state: z.string().max(30),
        digest: z.string().max(100).nullable().optional(),
      }),
    )
    .max(100),
});

type Options = {
  network: NetworkMode;
  currentVersion: string;
  platform: string;
  arch: string;
  fetch?: typeof fetch;
  openExternal(url: string): Promise<void>;
};

export class ManualUpdates {
  readonly #options: Options;
  readonly #fetch: typeof fetch;
  #controller: AbortController | null = null;
  #state: UpdateStatus["state"] = "idle";
  #checkedAt: string | null = null;
  #release: UpdateStatus["release"] = null;
  constructor(options: Options) {
    this.#options = options;
    this.#fetch = options.fetch ?? fetch;
    options.network.subscribe(() => {
      if (options.network.offline) this.cancel();
    });
  }
  status(): UpdateStatus {
    return {
      state: this.#options.network.offline ? "offline" : this.#state,
      currentVersion: this.#options.currentVersion,
      target:
        this.#options.platform === "darwin" && this.#options.arch === "arm64"
          ? "macos-arm64"
          : this.#options.platform === "win32" && this.#options.arch === "x64"
            ? "windows-x64"
            : "unsupported",
      offline: this.#options.network.offline,
      checkedAt: this.#checkedAt,
      release: this.#release,
    };
  }
  cancel() {
    this.#controller?.abort();
    if (this.#state === "checking") this.#state = "cancelled";
  }
  async perform(raw: unknown): Promise<UpdateStatus> {
    const action = UpdateActionSchema.parse(raw);
    if (action.type === "status") return this.status();
    if (action.type === "cancel") {
      this.cancel();
      return this.status();
    }
    if (this.#options.network.offline) {
      if (action.type === "check") return this.status();
      throw new Error("Offline Mode is enabled");
    }
    if (action.type === "open_verification") {
      await this.#options.openExternal(VERIFICATION_URL);
      return this.status();
    }
    if (action.type === "open_release") {
      if (!this.#release) throw new Error("Check for a published release first");
      await this.#options.openExternal(this.#release.url);
      return this.status();
    }
    if (this.#controller) throw new Error("An update check is running");
    const controller = new AbortController();
    this.#controller = controller;
    this.#state = "checking";
    this.#release = null;
    this.#checkedAt = null;
    const deadline = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await this.#fetch(RELEASE_METADATA_URL, {
        signal: controller.signal,
        redirect: "error",
        credentials: "omit",
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "OpenChords",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      });
      if (response.status === 404) {
        await response.body?.cancel();
        controller.signal.throwIfAborted();
        this.#state = "not_published";
      } else {
        if (!response.ok || !response.body) {
          await response.body?.cancel();
          throw new Error("Release metadata unavailable");
        }
        const reader = response.body.getReader();
        const abortRead = () => {
          void reader.cancel().catch(() => {});
        };
        controller.signal.addEventListener("abort", abortRead, { once: true });
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        try {
          for (;;) {
            controller.signal.throwIfAborted();
            const chunk = await reader.read();
            if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (bytes > MAX_METADATA_BYTES) throw new Error("Release metadata exceeds limit");
            chunks.push(chunk.value);
          }
        } finally {
          controller.signal.removeEventListener("abort", abortRead);
          await reader.cancel();
          reader.releaseLock();
        }
        const metadata = metadataSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        const target = this.status().target;
        const uploaded = metadata.assets.filter((asset) => asset.state === "uploaded");
        const tag = metadata.tag_name;
        const version = tag.replace(/^v/, "");
        const artifacts = uploaded.filter(
          (asset) => asset.name === `open-chords-${version}-${target}.zip` && asset.size > 0,
        );
        if (
          artifacts.length > 1 ||
          uploaded.filter((asset) => asset.name === "SHA256SUMS").length > 1
        )
          throw new Error("Release assets are ambiguous");
        const release = UpdateReleaseSchema.parse({
          tag,
          name: metadata.name ?? tag,
          notes: metadata.body ?? "",
          publishedAt: metadata.published_at,
          url: `${REPOSITORY}/releases/tag/${tag}`,
          checksumsUrl: uploaded.some((asset) => asset.name === "SHA256SUMS" && asset.size > 0)
            ? `${REPOSITORY}/releases/download/${tag}/SHA256SUMS`
            : null,
          artifacts: artifacts.map((asset) => ({
            name: asset.name,
            size: asset.size,
            sha256:
              asset.digest && /^sha256:[a-f0-9]{64}$/.test(asset.digest)
                ? asset.digest.slice(7)
                : null,
          })),
        });
        controller.signal.throwIfAborted();
        if (this.#options.network.offline) throw new Error("Offline Mode is enabled");
        this.#release = release;
        this.#state = "available";
      }
      this.#checkedAt = new Date().toISOString();
    } catch {
      this.#state = this.status().state === "cancelled" ? "cancelled" : "failed";
    } finally {
      clearTimeout(deadline);
      this.#controller = null;
    }
    return this.status();
  }
}

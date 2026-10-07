import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import { ManualUpdates, RELEASE_METADATA_URL } from "../apps/desktop/src/main/manual-updates.ts";
import { openNetworkMode } from "../apps/desktop/src/main/network-mode.ts";

const digest = `sha256:${"a".repeat(64)}`;
const release = {
  tag_name: "v1.2.3",
  name: "Open Chords 1.2.3",
  body: "Release notes <script>unsafe</script>",
  draft: false,
  prerelease: false,
  published_at: "2026-10-07T10:00:00Z",
  assets: [
    { name: "open-chords-1.2.3-macos-arm64.zip", size: 1000, state: "uploaded", digest },
    { name: "open-chords-1.2.3-windows-x64.zip", size: 2000, state: "uploaded", digest: null },
    { name: "SHA256SUMS", size: 200, state: "uploaded", digest },
  ],
};
async function fixture(fetcher: typeof fetch) {
  const root = await mkdtemp(join(tmpdir(), "oc-updates-"));
  const network = await openNetworkMode(root);
  const opened = vi.fn<(url: string) => Promise<void>>(async (_url) => {});
  const service = new ManualUpdates({
    network,
    fetch: fetcher,
    currentVersion: "0.0.0",
    platform: "darwin",
    arch: "arm64",
    openExternal: opened,
  });
  return { root, network, opened, service };
}

it("does no background I/O and reads only bounded credential-free release metadata on explicit check", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json(release));
  const f = await fixture(fetcher);
  try {
    expect(f.service.status().state).toBe("idle");
    expect(fetcher).not.toHaveBeenCalled();
    const result = await f.service.perform({ type: "check" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![0]).toBe(RELEASE_METADATA_URL);
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ redirect: "error", credentials: "omit" });
    expect(result.release).toMatchObject({
      tag: "v1.2.3",
      notes: release.body,
      artifacts: [{ name: release.assets[0]!.name, sha256: "a".repeat(64) }],
    });
    expect(result.release?.artifacts).toHaveLength(1);
    expect(result.release?.checksumsUrl).toBe(
      "https://github.com/qisoft/open-chords/releases/download/v1.2.3/SHA256SUMS",
    );
    expect(f.opened).not.toHaveBeenCalled();
    await f.service.perform({ type: "open_release" });
    expect(f.opened).toHaveBeenCalledExactlyOnceWith(
      "https://github.com/qisoft/open-chords/releases/tag/v1.2.3",
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

it("Offline Mode makes no request and aborts an active request before publication", async () => {
  const fetcher = vi.fn<typeof fetch>(
    async (_url, options) =>
      new Promise((_resolve, reject) => {
        options!.signal!.addEventListener("abort", () => reject(new Error("private path/token")), {
          once: true,
        });
      }),
  );
  const f = await fixture(fetcher);
  try {
    await f.network.setOffline(true);
    expect((await f.service.perform({ type: "check" })).state).toBe("offline");
    expect(fetcher).not.toHaveBeenCalled();
    await f.network.setOffline(false);
    const pending = f.service.perform({ type: "check" });
    await f.network.setOffline(true);
    expect((await pending).state).toBe("offline");
    expect(f.service.status().release).toBeNull();
    expect(JSON.stringify(f.service.status())).not.toContain("private");
    await expect(f.service.perform({ type: "open_verification" })).rejects.toThrow(
      "Offline Mode is enabled",
    );
    expect(f.opened).not.toHaveBeenCalled();
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

it.each(["oversized", "invalid", "draft", "redirect", "missing"])(
  "handles %s release metadata without trusting URLs or exposing response data",
  async (kind) => {
    const response =
      kind === "oversized"
        ? new Response("x".repeat(1024 * 1024 + 1))
        : kind === "invalid"
          ? Response.json({ ...release, tag_name: "../private" })
          : kind === "draft"
            ? Response.json({ ...release, draft: true })
            : kind === "redirect"
              ? new Response(null, { status: 302, headers: { location: "https://evil.example" } })
              : new Response(null, { status: 404 });
    const f = await fixture(async () => response);
    try {
      const result = await f.service.perform({ type: "check" });
      expect(result.state).toBe(kind === "missing" ? "not_published" : "failed");
      expect(result.release).toBeNull();
      expect(JSON.stringify(result)).not.toContain("private");
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  },
);

it("user cancellation prevents late responses from publishing and does not automatically retry", async () => {
  let resolve!: (response: Response) => void;
  const fetcher = vi.fn<typeof fetch>(
    async () =>
      new Promise<Response>((r) => {
        resolve = r;
      }),
  );
  const f = await fixture(fetcher);
  try {
    const pending = f.service.perform({ type: "check" });
    expect((await f.service.perform({ type: "cancel" })).state).toBe("cancelled");
    resolve(Response.json(release));
    expect((await pending).state).toBe("cancelled");
    expect(f.service.status().release).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

it("cancels a stalled metadata body without publishing partial content", async () => {
  let entered!: () => void;
  const reading = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const cancel = vi.fn<() => void>();
  const f = await fixture(
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull() {
            entered();
          },
          cancel,
        }),
      ),
  );
  try {
    const pending = f.service.perform({ type: "check" });
    await reading;
    await f.service.perform({ type: "cancel" });
    expect((await pending).state).toBe("cancelled");
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(f.service.status().release).toBeNull();
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

it("provides Windows assets with a missing digest as unavailable verification evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "oc-update-windows-"));
  try {
    const service = new ManualUpdates({
      network: await openNetworkMode(root),
      currentVersion: "1.0.0",
      platform: "win32",
      arch: "x64",
      fetch: async () => Response.json(release),
      openExternal: async () => {},
    });
    expect((await service.perform({ type: "check" })).release?.artifacts).toEqual([
      { name: release.assets[1]!.name, size: 2000, sha256: null },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

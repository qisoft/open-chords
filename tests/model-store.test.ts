import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { openModelStore } from "../apps/desktop/src/main/model-store.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const directory of roots.splice(0)) await rm(directory, { recursive: true, force: true });
});
const bytes = Buffer.from("HELLO HH AH L OW\n");
const hash = createHash("sha256").update(bytes).digest("hex");
const pack = {
  id: "english_mfa-3.1.0",
  language: "en" as const,
  version: "3.1.0",
  runtime: "mfa-3.4.1" as const,
  artifacts: [
    {
      id: "english_mfa_dictionary",
      version: "3.1.0",
      sha256: hash,
      url: "https://github.com/MontrealCorpusTools/mfa-models/releases/download/dictionary-english_mfa-v3.1.0/english_mfa.dict",
      license: "CC-BY-4.0",
      attribution: "Montreal Corpus Tools",
      modelCard: "https://mfa-models.readthedocs.io/en/latest/",
      format: "file" as const,
      bytes: bytes.length,
      installedBytes: bytes.length,
    },
  ],
};
async function root() {
  const result = await mkdtemp(join(tmpdir(), "open-chords-model-store-"));
  roots.push(result);
  return result;
}

it("installs an exact immutable pack explicitly and resolves it after reopening", async () => {
  const stateRoot = await root();
  let transfers = 0;
  const options = {
    stateRoot,
    packs: [pack],
    runtime: "mfa-3.4.1",
    fetch: async () => {
      transfers++;
      return new Response(bytes);
    },
  };
  const store = await openModelStore(options);
  expect(await store.list()).toMatchObject([{ id: pack.id, installed: false }]);
  expect(transfers).toBe(0);
  await store.install(pack.id);
  expect(await store.list()).toMatchObject([{ id: pack.id, installed: true }]);
  const reopened = await openModelStore(options);
  const installedArtifact = await reopened.resolve({
    id: "english_mfa_dictionary",
    version: "3.1.0",
    sha256: hash,
  });
  expect(installedArtifact).not.toBeNull();
  const { readFile } = await import("node:fs/promises");
  expect(await readFile(join(dirname(installedArtifact!), "NOTICE.txt"), "utf8")).toBe(
    "Open Chords Alignment Language Pack\n\n" +
      "English (en), version 3.1.0\n" +
      "Compatible runtime: mfa-3.4.1\n\n" +
      "english_mfa_dictionary 3.1.0\n" +
      `SHA-256: ${hash}\n` +
      "License: CC-BY-4.0\n" +
      "Attribution: Montreal Corpus Tools\n" +
      "Model card: https://mfa-models.readthedocs.io/en/latest/\n" +
      "Source: https://github.com/MontrealCorpusTools/mfa-models/releases/download/dictionary-english_mfa-v3.1.0/english_mfa.dict\n",
  );
  expect(
    await reopened.resolve({ id: "english_mfa_dictionary", version: "3.0.0", sha256: hash }),
  ).toBeNull();
  await reopened.install(pack.id);
  expect(transfers).toBe(1);
});

it("cancels an in-flight transfer and publishes nothing before retry", async () => {
  const stateRoot = await root();
  let release!: () => void;
  let started!: () => void;
  const observed = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const store = await openModelStore({
    stateRoot,
    packs: [pack],
    runtime: pack.runtime,
    fetch: async () => {
      started();
      await gate;
      return new Response(bytes);
    },
  });
  const installing = store.install(pack.id);
  await observed;
  store.cancel();
  release();
  await expect(installing).rejects.toThrow("cancelled");
  expect(await store.list()).toMatchObject([{ installed: false }]);
  await store.install(pack.id);
  expect(await store.list()).toMatchObject([{ installed: true }]);
});

it("Offline Mode persists, cancels transfers, and denies model installation", async () => {
  const { openNetworkMode } = await import("../apps/desktop/src/main/network-mode.ts");
  const stateRoot = await root();
  const network = await openNetworkMode(stateRoot);
  let requests = 0;
  const store = await openModelStore({
    stateRoot,
    packs: [pack],
    runtime: pack.runtime,
    network,
    fetch: async () => {
      requests++;
      return new Response(bytes);
    },
  });
  await network.setOffline(true);
  await expect(store.install(pack.id)).rejects.toThrow("Offline Mode");
  expect(requests).toBe(0);
  expect((await openNetworkMode(stateRoot)).offline).toBe(true);
  await network.setOffline(false);
  await store.install(pack.id);
  expect(requests).toBe(1);
});

it("keeps the committed network policy when an Offline Mode write fails", async () => {
  const { mkdir } = await import("node:fs/promises");
  const { openNetworkMode } = await import("../apps/desktop/src/main/network-mode.ts");
  const stateRoot = await root();
  const network = await openNetworkMode(stateRoot);
  const store = await openModelStore({
    stateRoot,
    packs: [pack],
    runtime: pack.runtime,
    network,
    fetch: async () => new Response(bytes),
  });
  await mkdir(join(stateRoot, "network-mode.json"));
  await expect(network.setOffline(true)).rejects.toThrow(/EISDIR|EPERM|EACCES|EEXIST/);
  expect(network.offline).toBe(false);
  await store.install(pack.id);
  expect(await store.list()).toMatchObject([{ installed: true }]);
});

it("never publishes a mismatched artifact and permits a clean retry", async () => {
  const stateRoot = await root();
  let valid = false;
  const store = await openModelStore({
    stateRoot,
    packs: [pack],
    runtime: pack.runtime,
    fetch: async () => new Response(valid ? bytes : Buffer.alloc(bytes.length)),
  });
  await expect(store.install(pack.id)).rejects.toThrow("checksum");
  expect(await store.list()).toMatchObject([{ installed: false }]);
  expect(await store.resolve(pack.artifacts[0]!)).toBeNull();
  valid = true;
  await store.install(pack.id);
  expect(await store.list()).toMatchObject([{ installed: true }]);
});

it("bounds a streamed transfer before accepting more than the declared bytes", async () => {
  let cancelled = false;
  let sent = false;
  const store = await openModelStore({
    stateRoot: await root(),
    packs: [pack],
    runtime: pack.runtime,
    fetch: async () =>
      new Response(
        new ReadableStream(
          {
            pull(controller) {
              if (sent) controller.close();
              else {
                sent = true;
                controller.enqueue(new Uint8Array(bytes.length + 1));
              }
            },
            cancel() {
              cancelled = true;
            },
          },
          { highWaterMark: 0 },
        ),
      ),
  });
  await expect(store.install(pack.id)).rejects.toThrow("size");
  expect(cancelled).toBe(true);
  expect(await store.list()).toMatchObject([{ installed: false }]);
});

it("verifies ZIP contents before publishing and exposes only the unpacked model", async () => {
  const { readFile } = await import("node:fs/promises");
  const zip = await readFile(
    new URL("../packages/testkit/models/small-acoustic.zip", import.meta.url),
  );
  const text = Buffer.from('{"version":"3.1.0"}\n');
  const artifact = {
    ...pack.artifacts[0]!,
    id: "english_mfa_acoustic",
    format: "zip" as const,
    sha256: createHash("sha256").update(zip).digest("hex"),
    bytes: zip.length,
    installedBytes: text.length,
    files: [
      {
        path: "english_mfa/meta.json",
        bytes: text.length,
        sha256: createHash("sha256").update(text).digest("hex"),
      },
    ],
  };
  const store = await openModelStore({
    stateRoot: await root(),
    packs: [{ ...pack, artifacts: [artifact] }],
    runtime: pack.runtime,
    fetch: async () => new Response(zip),
  });
  await store.install(pack.id);
  const installed = await store.resolve(artifact);
  expect(await readFile(join(installed!, "english_mfa/meta.json"), "utf8")).toBe(
    '{"version":"3.1.0"}\n',
  );
});

it("reports corrupted installed data as unavailable and repairs it only by explicit reinstall", async () => {
  const { writeFile } = await import("node:fs/promises");
  const store = await openModelStore({
    stateRoot: await root(),
    packs: [pack],
    runtime: pack.runtime,
    fetch: async () => new Response(bytes),
  });
  await store.install(pack.id);
  const path = await store.resolve(pack.artifacts[0]!);
  await writeFile(path!, "broken");
  expect(await store.list()).toMatchObject([{ installed: false }]);
  expect(await store.resolve(pack.artifacts[0]!)).toBeNull();
  await store.install(pack.id);
  expect(await store.list()).toMatchObject([{ installed: true }]);
});

it("rejects a release manifest that could escape its Model Store", async () => {
  await expect(
    openModelStore({
      stateRoot: await root(),
      runtime: pack.runtime,
      packs: [{ ...pack, artifacts: [{ ...pack.artifacts[0]!, sha256: "../escape" }] }],
    }),
  ).rejects.toThrow("manifest");
});

it("uses the same Offline Mode for lyrics discovery and model installation", async () => {
  const { openNetworkMode } = await import("../apps/desktop/src/main/network-mode.ts");
  const { openLyricsDiscovery } = await import("../apps/desktop/src/main/lyrics-discovery.ts");
  const stateRoot = await root();
  const network = await openNetworkMode(stateRoot);
  let requests = 0;
  const store = await openModelStore({
    stateRoot,
    packs: [pack],
    runtime: pack.runtime,
    network,
    fetch: async () => {
      requests++;
      return new Response(bytes);
    },
  });
  const lyrics = await openLyricsDiscovery({ stateRoot, network });
  await lyrics.setOffline(true);
  await expect(store.install(pack.id)).rejects.toThrow("Offline Mode");
  expect(requests).toBe(0);
});

it("keeps exact versions independent when removing a pack and reports referenced Projects", async () => {
  const newer = {
    ...pack,
    id: "english_mfa-3.2.0",
    version: "3.2.0",
    artifacts: [{ ...pack.artifacts[0]!, version: "3.2.0" }],
  };
  const store = await openModelStore({
    stateRoot: await root(),
    packs: [pack, newer],
    runtime: pack.runtime,
    fetch: async () => new Response(bytes),
  });
  await store.install(pack.id);
  await store.install(newer.id);
  const references = [{ projectId: "project_one", artifacts: [pack.artifacts[0]!] }];
  const impact = store.previewRemoval(pack.id, references);
  expect(impact.affectedProjectIds).toEqual(["project_one"]);
  const unknownImpact = store.previewRemoval(pack.id, [
    ...references,
    { projectId: "project_damaged", artifacts: [], impactUnknown: true },
  ]);
  expect(unknownImpact.unknownProjectIds).toEqual(["project_damaged"]);
  expect(unknownImpact.impactId).not.toBe(impact.impactId);
  await store.remove(pack.id);
  expect(await store.resolve(pack.artifacts[0]!)).toBeNull();
  expect(await store.resolve(newer.artifacts[0]!)).not.toBeNull();
  expect(references[0]!.artifacts[0]!.version).toBe("3.1.0");
});

it("exposes only named model operations through the real main gateway", async () => {
  const { openProjectLibrary } = await import("../apps/desktop/src/main/project-library.ts");
  const { DesktopCommandGateway } =
    await import("../apps/desktop/src/main/desktop-command-gateway.ts");
  const { openNetworkMode } = await import("../apps/desktop/src/main/network-mode.ts");
  const stateRoot = await root();
  const library = await openProjectLibrary({ stateRoot });
  const network = await openNetworkMode(stateRoot);
  const store = await openModelStore({
    stateRoot,
    packs: [pack],
    runtime: pack.runtime,
    network,
    fetch: async () => new Response(bytes),
  });
  const gateway = new DesktopCommandGateway(library, undefined, undefined, {
    store,
    network,
    references: () => library.listModelReferences(),
    runtime: {
      id: pack.runtime,
      available: true,
      installedBytes: 100,
      transferBytes: 50,
      placement: "bundled" as const,
    },
  });
  const sender = {
    frameUrl: "open-chords://app/index.html",
    generationId: "generation_models",
    isMainFrame: true,
    senderId: 1,
    security: {
      contextIsolation: true,
      nodeIntegration: false,
      persistentSession: false,
      sandbox: true,
      webSecurity: true,
    },
  } as const;
  const command = {
    protocol: "open-chords/desktop-ipc",
    protocolVersion: "1.0",
    generationId: sender.generationId,
    requestId: "request_models",
    type: "models.perform",
  };
  const status = await gateway.execute({ ...command, action: { type: "status" } }, sender);
  expect(status.response).toMatchObject({
    type: "models.result",
    packs: [{ id: pack.id, installed: false }],
  });
  expect(JSON.stringify(status.response)).not.toContain(stateRoot);
  expect(
    (await gateway.execute({ ...command, action: { type: "install", packId: pack.id } }, sender))
      .response,
  ).toMatchObject({ type: "models.result", packs: [{ installed: true }] });
  expect(
    (
      await gateway.execute(
        { ...command, action: { type: "install", packId: pack.id, url: "https://evil.invalid" } },
        sender,
      )
    ).response,
  ).toMatchObject({ type: "desktop.error", code: "invalid_command" });
  const flooded = await Promise.all(
    Array.from({ length: 40 }, () =>
      gateway.execute({ ...command, action: { type: "cancel" } }, sender),
    ),
  );
  expect(flooded.filter(({ response }) => response.type === "models.result")).toHaveLength(1);
  expect(
    flooded.filter(({ response }) => response.type === "desktop.error" && response.code === "busy"),
  ).toHaveLength(39);
});

it("does not report a runtime available from metadata alone", async () => {
  const { writeFile } = await import("node:fs/promises");
  const { inspectAlignmentRuntime } = await import("../apps/desktop/src/main/alignment-runtime.ts");
  const path = await root();
  await writeFile(
    join(path, "runtime-info.json"),
    JSON.stringify({
      id: "mfa-3.4.1",
      available: true,
      placement: "bundled",
      installedBytes: 100,
      transferBytes: 50,
    }),
  );
  expect((await inspectAlignmentRuntime(path)).available).toBe(false);
});

it("follows only the bounded GitHub release-asset redirect before verifying bytes", async () => {
  const urls: string[] = [];
  const store = await openModelStore({
    stateRoot: await root(),
    packs: [pack],
    runtime: pack.runtime,
    fetch: async (input, init) => {
      urls.push(input instanceof Request ? input.url : input.toString());
      expect(init?.credentials).toBe("omit");
      expect(init?.redirect).toBe("manual");
      return urls.length === 1
        ? new Response(null, {
            status: 302,
            headers: {
              location: "https://release-assets.githubusercontent.com/asset?signature=transient",
            },
          })
        : new Response(bytes);
    },
  });
  await store.install(pack.id);
  expect(urls).toHaveLength(2);
  expect(JSON.stringify(await store.list())).not.toContain("transient");
});

it("rejects hostile ZIP paths without publishing the selected pack", async () => {
  const { readFile } = await import("node:fs/promises");
  const zip = await readFile(
    new URL("../packages/testkit/models/traversal-acoustic.zip", import.meta.url),
  );
  const text = Buffer.from('{"version":"3.1.0"}\n');
  const artifact = {
    ...pack.artifacts[0]!,
    format: "zip" as const,
    bytes: zip.length,
    installedBytes: text.length,
    sha256: createHash("sha256").update(zip).digest("hex"),
    files: [
      {
        path: "english_mfa/meta.json",
        bytes: text.length,
        sha256: createHash("sha256").update(text).digest("hex"),
      },
    ],
  };
  const store = await openModelStore({
    stateRoot: await root(),
    packs: [{ ...pack, artifacts: [artifact] }],
    runtime: pack.runtime,
    fetch: async () => new Response(zip),
  });
  await expect(store.install(pack.id)).rejects.toThrow("archive");
  expect(await store.list()).toMatchObject([{ installed: false }]);
});

it("refuses a redirected staging directory without deleting foreign files", async () => {
  const { mkdir, symlink, writeFile, readFile } = await import("node:fs/promises");
  const stateRoot = await root();
  const foreign = await root();
  await writeFile(join(foreign, "keep.txt"), "keep");
  await mkdir(join(stateRoot, "models"));
  await symlink(
    foreign,
    join(stateRoot, "models/staging"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await expect(openModelStore({ stateRoot, packs: [pack], runtime: pack.runtime })).rejects.toThrow(
    "directory",
  );
  expect(await readFile(join(foreign, "keep.txt"), "utf8")).toBe("keep");
});

import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { syncDirectory } from "./filesystem-durability.ts";
import { unpackModel, type ModelFile } from "./model-archive.ts";
import { openNetworkMode, type NetworkMode } from "./network-mode.ts";

export type ModelArtifact = {
  id: string;
  version: string;
  sha256: string;
  url: string;
  license: string;
  attribution: string;
  modelCard: string;
  format: "file" | "zip";
  bytes: number;
  installedBytes: number;
  files?: ModelFile[] | undefined;
};
export type AlignmentPack = {
  id: string;
  language: "en" | "ru";
  version: string;
  runtime: string;
  artifacts: ModelArtifact[];
};
type Options = {
  stateRoot: string;
  packs: AlignmentPack[];
  runtime: string;
  fetch?: typeof fetch;
  network?: NetworkMode;
};
const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const safeId = z.string().regex(/^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,100}$/);
const fileSchema = z.strictObject({
  path: z
    .string()
    .max(240)
    .refine((value) =>
      value.split("/").every((part) => /^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(part)),
    ),
  bytes: z
    .number()
    .int()
    .nonnegative()
    .max(128 * 1024 * 1024),
  sha256: hashSchema,
});
const artifactSchema = z
  .strictObject({
    id: safeId,
    version: safeId,
    sha256: hashSchema,
    url: z.url().refine((value) => {
      const url = new URL(value);
      return (
        url.origin === "https://github.com" &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        url.pathname.startsWith("/MontrealCorpusTools/mfa-models/releases/download/")
      );
    }),
    license: z.literal("CC-BY-4.0"),
    attribution: z.string().min(1).max(2000),
    modelCard: z
      .url()
      .refine((value) => new URL(value).origin === "https://mfa-models.readthedocs.io"),
    format: z.enum(["file", "zip"]),
    bytes: z
      .number()
      .int()
      .positive()
      .max(128 * 1024 * 1024),
    installedBytes: z
      .number()
      .int()
      .positive()
      .max(256 * 1024 * 1024),
    files: z.array(fileSchema).min(1).max(128).optional(),
  })
  .refine((value) =>
    value.format === "file"
      ? value.files === undefined && value.bytes === value.installedBytes
      : value.files !== undefined &&
        new Set(value.files.map((file) => file.path.toLowerCase())).size === value.files.length &&
        value.files.reduce((sum, file) => sum + file.bytes, 0) === value.installedBytes,
  );
const packsSchema = z
  .array(
    z
      .strictObject({
        id: safeId,
        language: z.enum(["en", "ru"]),
        version: safeId,
        runtime: safeId,
        artifacts: z.array(artifactSchema).min(1).max(2),
      })
      .refine(
        (pack) =>
          new Set(pack.artifacts.map((artifact) => artifact.sha256)).size === pack.artifacts.length,
      ),
  )
  .max(20)
  .refine((packs) => new Set(packs.map((pack) => pack.id)).size === packs.length);
const installationSchema = z.strictObject({
  installedAt: z.iso.datetime(),
  packHash: hashSchema,
});

function packNotice(pack: AlignmentPack) {
  const language = pack.language === "en" ? "English" : "Russian";
  return `${[
    "Open Chords Alignment Language Pack",
    "",
    `${language} (${pack.language}), version ${pack.version}`,
    `Compatible runtime: ${pack.runtime}`,
    "",
    ...pack.artifacts.flatMap((artifact) => [
      `${artifact.id} ${artifact.version}`,
      `SHA-256: ${artifact.sha256}`,
      `License: ${artifact.license}`,
      `Attribution: ${artifact.attribution}`,
      `Model card: ${artifact.modelCard}`,
      `Source: ${artifact.url}`,
      "",
    ]),
  ]
    .join("\n")
    .trimEnd()}\n`;
}

export async function openModelStore(options: Options) {
  const parsed = packsSchema.safeParse(options.packs);
  if (!parsed.success) throw new Error("Invalid model manifest");
  options = {
    ...options,
    packs: parsed.data,
    network: options.network ?? (await openNetworkMode(options.stateRoot)),
  };
  const root = join(options.stateRoot, "models");
  await mkdir(root, { recursive: true });
  if (!(await lstat(root)).isDirectory()) throw new Error("Invalid Model Store directory");
  await mkdir(join(root, "packs"), { recursive: true });
  await mkdir(join(root, "staging"), { recursive: true });
  await assertStoreDirectories(root);
  for (const entry of await readdir(join(root, "staging")))
    await rm(join(root, "staging", entry), { recursive: true, force: true });
  await syncDirectory(join(root, "staging"));
  return new ModelStore(root, options);
}

export class ModelStore {
  readonly #root: string;
  readonly #packs: AlignmentPack[];
  readonly #fetch: typeof fetch;
  readonly #runtime: string;
  readonly #network: NetworkMode | undefined;
  #controller: AbortController | null = null;
  cancel() {
    this.#controller?.abort(new Error("Model installation cancelled"));
  }
  constructor(root: string, options: Options) {
    this.#root = root;
    this.#packs = structuredClone(options.packs);
    this.#fetch = options.fetch ?? fetch;
    this.#runtime = options.runtime;
    this.#network = options.network;
    options.network?.subscribe(() => this.cancel());
  }
  #path(pack: AlignmentPack) {
    return join(this.#root, "packs", digest(JSON.stringify(pack)));
  }
  async #installed(pack: AlignmentPack) {
    try {
      const root = this.#path(pack);
      if (!(await lstat(root)).isDirectory()) return false;
      if ((await readFile(join(root, "manifest.json"), "utf8")) !== JSON.stringify(pack))
        return false;
      if ((await readFile(join(root, "NOTICE.txt"), "utf8")) !== packNotice(pack)) return false;
      const receipt = installationSchema.safeParse(
        JSON.parse(await readFile(join(root, "installation.json"), "utf8")),
      );
      if (!receipt.success || receipt.data.packHash !== digest(JSON.stringify(pack))) return false;
      for (const artifact of pack.artifacts) {
        const path = join(root, artifact.sha256);
        if (artifact.format === "file") {
          if (!(await lstat(path)).isFile() || digest(await readFile(path)) !== artifact.sha256)
            return false;
        } else {
          if (!(await lstat(path)).isDirectory() || !artifact.files) return false;
          for (const file of artifact.files) {
            let parent = path;
            for (const part of file.path.split("/").slice(0, -1)) {
              parent = join(parent, part);
              if (!(await lstat(parent)).isDirectory()) return false;
            }
            if (
              !(await lstat(join(path, file.path))).isFile() ||
              digest(await readFile(join(path, file.path))) !== file.sha256
            )
              return false;
          }
        }
      }
      return true;
    } catch {
      return false;
    }
  }
  async list() {
    await assertStoreDirectories(this.#root);
    return Promise.all(
      this.#packs.map(async (pack) => ({
        ...structuredClone(pack),
        installed: await this.#installed(pack),
      })),
    );
  }
  async resolve(reference: { id: string; version: string; sha256: string }) {
    for (const pack of this.#packs) {
      const artifact = pack.artifacts.find(
        (item) =>
          item.id === reference.id &&
          item.version === reference.version &&
          item.sha256 === reference.sha256,
      );
      if (!artifact || !(await this.#installed(pack))) continue;
      const path = join(this.#path(pack), artifact.sha256);
      if (artifact.format === "zip") {
        if (!artifact.files) continue;
        let valid = true;
        for (const file of artifact.files) {
          try {
            if (digest(await readFile(join(path, file.path))) !== file.sha256) valid = false;
          } catch {
            valid = false;
          }
        }
        if (valid) return path;
      } else if (digest(await readFile(path)) === artifact.sha256) return path;
    }
    return null;
  }
  previewRemoval(
    id: string,
    references: Array<{
      projectId: string;
      artifacts: Array<{ id: string; version: string; sha256: string }>;
    }>,
  ) {
    const pack = this.#packs.find((item) => item.id === id);
    if (!pack) throw new Error("Unsupported alignment pack");
    const affectedProjectIds = [
      ...new Set(
        references
          .filter((reference) =>
            reference.artifacts.some((used) =>
              pack.artifacts.some(
                (artifact) =>
                  artifact.id === used.id &&
                  artifact.version === used.version &&
                  artifact.sha256 === used.sha256,
              ),
            ),
          )
          .map((reference) => reference.projectId),
      ),
    ].sort();
    return {
      packId: id,
      affectedProjectIds,
      impactId: digest(JSON.stringify({ pack, affectedProjectIds })),
    };
  }
  async remove(id: string) {
    await assertStoreDirectories(this.#root);
    const pack = this.#packs.find((item) => item.id === id);
    if (!pack) throw new Error("Unsupported alignment pack");
    if (this.#controller) throw new Error("Model installation busy");
    const removed = join(this.#root, "staging", randomUUID());
    try {
      await rename(this.#path(pack), removed);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    await syncDirectory(join(this.#root, "packs"));
    await syncDirectory(join(this.#root, "staging"));
    await rm(removed, { recursive: true, force: true });
  }
  async install(id: string) {
    await assertStoreDirectories(this.#root);
    const pack = this.#packs.find((item) => item.id === id);
    if (!pack) throw new Error("Unsupported alignment pack");
    if (pack.runtime !== this.#runtime) throw new Error("Compatible alignment runtime unavailable");
    if (await this.#installed(pack)) return;
    if (this.#network?.offline) throw new Error("Offline Mode is enabled");
    if (this.#controller) throw new Error("Model installation busy");
    const controller = new AbortController();
    this.#controller = controller;
    const staging = join(this.#root, "staging", randomUUID());
    const timeout = setTimeout(
      () => controller.abort(new Error("Model transfer deadline exceeded")),
      300_000,
    );
    timeout.unref();
    try {
      await mkdir(staging);
      for (const artifact of pack.artifacts) {
        let response = await this.#fetch(artifact.url, {
          credentials: "omit",
          redirect: "manual",
          signal: controller.signal,
        });
        controller.signal.throwIfAborted();
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const target = new URL(response.headers.get("location") ?? "", artifact.url);
          await response.body?.cancel();
          if (
            target.origin !== "https://release-assets.githubusercontent.com" ||
            target.username ||
            target.password ||
            target.hash
          )
            throw new Error("Model redirect rejected");
          response = await this.#fetch(target.href, {
            credentials: "omit",
            redirect: "manual",
            signal: controller.signal,
          });
          controller.signal.throwIfAborted();
        }
        if (!response.ok) throw new Error("Model transfer failed");
        const reader = response.body?.getReader();
        if (!reader) throw new Error("Empty model transfer");
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          while (true) {
            controller.signal.throwIfAborted();
            const next = await reader.read();
            controller.signal.throwIfAborted();
            if (next.done) break;
            size += next.value.length;
            if (size > artifact.bytes) throw new Error("Model transfer size exceeded");
            chunks.push(next.value);
          }
        } finally {
          await reader.cancel().catch(() => {});
        }
        const bytes = Buffer.concat(chunks);
        if (bytes.length !== artifact.bytes || digest(bytes) !== artifact.sha256)
          throw new Error("Model checksum mismatch");
        if (artifact.format === "zip") {
          if (
            !artifact.files ||
            artifact.files.reduce((sum, file) => sum + file.bytes, 0) !== artifact.installedBytes
          )
            throw new Error("Invalid model manifest");
          await unpackModel(bytes, join(staging, artifact.sha256), artifact.files);
          continue;
        }
        const file = await open(join(staging, artifact.sha256), "wx", 0o600);
        try {
          await file.writeFile(bytes);
          await file.sync();
        } finally {
          await file.close();
        }
      }
      await writeSyncedFile(join(staging, "NOTICE.txt"), packNotice(pack));
      await writeSyncedFile(
        join(staging, "installation.json"),
        JSON.stringify({
          installedAt: new Date().toISOString(),
          packHash: digest(JSON.stringify(pack)),
        }),
      );
      await writeSyncedFile(join(staging, "manifest.json"), JSON.stringify(pack));
      await syncDirectories(staging);
      controller.signal.throwIfAborted();
      // A corrupt prior installation is never repaired in place or substituted silently.
      const damaged = join(this.#root, "staging", randomUUID());
      try {
        await rename(this.#path(pack), damaged);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
      await rename(staging, this.#path(pack));
      await syncDirectory(join(this.#root, "packs"));
      await syncDirectory(join(this.#root, "staging"));
      await rm(damaged, { recursive: true, force: true });
    } finally {
      clearTimeout(timeout);
      this.#controller = null;
      await rm(staging, { recursive: true, force: true });
    }
  }
}

async function writeSyncedFile(path: string, content: string | Uint8Array) {
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(content);
    await file.sync();
  } finally {
    await file.close();
  }
}

async function syncDirectories(root: string): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true }))
    if (entry.isDirectory()) await syncDirectories(join(root, entry.name));
  await syncDirectory(root);
}

async function assertStoreDirectories(root: string) {
  for (const path of [root, join(root, "packs"), join(root, "staging")])
    if (!(await lstat(path)).isDirectory()) throw new Error("Invalid Model Store directory");
}

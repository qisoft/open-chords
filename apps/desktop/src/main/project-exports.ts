import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

import { ExportActionSchema, type ExportAction } from "@open-chords/contracts";
import { canonicalSerialize, StableIdSchema } from "@open-chords/domain";
import {
  captureJsonExport,
  JsonExportOptionsSchema,
  serializeJsonExport,
} from "@open-chords/domain";
import { z } from "zod";

import { readBoundedFile } from "./bounded-file.ts";
import { syncDirectory } from "./filesystem-durability.ts";
import type { LocalMediaService } from "./local-media.ts";
import {
  ARCHIVE_EXTENSION,
  ArchiveTooLargeError,
  archivedProjectFor,
  receiptDisplayName,
  writePortableProjectArchive,
} from "./project-archive-format.ts";
import { ARCHIVE_ZIP_LIMITS } from "./project-archive-zip.ts";
import { ExportReceiptSchema } from "./project-library-records.ts";
import type { ProjectLibrary } from "./project-library.ts";

export type ExportFormat = "open_chords_json" | "project_archive";
const TARGETS: Record<ExportFormat, { extension: string; maxBytes: number }> = {
  open_chords_json: { extension: ".json", maxBytes: 32 * 1024 * 1024 },
  project_archive: { extension: ARCHIVE_EXTENSION, maxBytes: ARCHIVE_ZIP_LIMITS.maxArchiveBytes },
};
const revisionRequest = {
  projectId: StableIdSchema,
  expectedProjectRevisionId: z.string().regex(/^projectrevision_[a-f0-9]{32}$/),
};
const jsonRequestSchema = JsonExportOptionsSchema.extend(revisionRequest);
const archiveRequestSchema = z.strictObject({ ...revisionRequest, includeMedia: z.boolean() });
const journalSchema = z.strictObject({
  version: z.literal(1),
  libraryRoot: z.string().min(1),
  projectId: StableIdSchema,
  receipt: ExportReceiptSchema,
});
type Options = {
  library: ProjectLibrary;
  media?: Pick<LocalMediaService, "readVerifiedProjectRange">;
  stateRoot: string;
  protectedRoots?: string[];
  pickTarget: (format: ExportFormat) => Promise<string | null>;
};
type Prepared = {
  activeViewHash: string;
  content: Buffer;
  omissions: string[];
  profileVersion: string;
};
type PublicationState = "saved" | "cancelled" | "receipt_pending" | "too_large";

class ExportTooLargeError extends Error {
  constructor() {
    super("Export exceeds its size budget");
    this.name = "ExportTooLargeError";
  }
}

class ExportMediaUnavailableError extends Error {
  constructor(cause: unknown) {
    super("The verified Project Range is unavailable for this export", { cause });
    this.name = "ExportMediaUnavailableError";
  }
}

const hash = (value: string | Buffer) =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;
const missing = (error: unknown) =>
  error instanceof Error && "code" in error && error.code === "ENOENT";
const nested = (root: string, target: string) => {
  const path = relative(root, target);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
};

export async function openProjectExports(options: Options) {
  const service = new ProjectExports(options);
  await service.recover();
  return service;
}

export class ProjectExports {
  readonly #options: Options;
  readonly #journalRoot: string;
  #controller: AbortController | null = null;
  #pendingRecovery = 0;
  #recovering = false;
  constructor(options: Options) {
    this.#options = options;
    this.#journalRoot = join(options.stateRoot, "export-pending");
  }
  cancel() {
    this.#controller?.abort();
  }
  get busy() {
    return this.#controller !== null || this.#recovering;
  }
  get pendingRecovery() {
    return this.#pendingRecovery;
  }
  receipts(projectId: string) {
    return this.#options.library.listExportReceipts(projectId);
  }

  async perform(raw: ExportAction) {
    const action = ExportActionSchema.parse(raw);
    let state: "idle" | "cancelling" | "media_unavailable" | PublicationState = "idle";
    if (action.type === "save_json") {
      const { type: _type, ...request } = action;
      state = (await this.saveJson(request)).state;
    } else if (action.type === "save_archive") {
      const { type: _type, ...request } = action;
      state = (await this.saveArchive(request)).state;
    } else if (action.type === "cancel") {
      this.cancel();
      state = this.busy ? "cancelling" : "idle";
    } else if (action.type === "recover") {
      if (this.busy) throw new Error("Export is running");
      await this.recover();
    }
    return {
      projectId: action.projectId,
      state,
      busy: this.busy,
      pendingRecovery: this.#pendingRecovery,
      receipts: this.receipts(action.projectId)
        .slice(-100)
        .map(({ outputLocation, ...receipt }) => ({
          ...receipt,
          displayName: receiptDisplayName(outputLocation),
          profileVersion: receipt.profileVersion.slice(0, 100),
          omissions: receipt.omissions.slice(0, 100).map((omission) => omission.slice(0, 200)),
          detailsTruncated:
            receipt.profileVersion.length > 100 ||
            receipt.omissions.length > 100 ||
            receipt.omissions.some((omission) => omission.length > 200) ||
            basename(outputLocation).length > 240,
        })),
    };
  }

  saveJson(raw: unknown): Promise<{ state: PublicationState }> {
    const request = jsonRequestSchema.parse(raw);
    return this.#publishWithinBudget(request, "open_chords_json", async () => {
      const selected = await this.#options.library.getSnapshot(request.projectId);
      if (selected?.projectRevisionId !== request.expectedProjectRevisionId)
        throw new Error("Export requires the current writable Project revision");
      const snapshot = captureJsonExport(selected.project, { presentation: request.presentation });
      return {
        activeViewHash: hash(
          canonicalSerialize({
            project: snapshot.project,
            provenance: snapshot.provenance,
            userAuthorship: snapshot.userAuthorship,
            selection: snapshot.selection,
            original: snapshot.original,
            effectiveTimeline: snapshot.effectiveTimeline,
            presentation: snapshot.presentation,
            ...(snapshot.lyrics ? { lyrics: snapshot.lyrics } : {}),
          }),
        ),
        content: Buffer.from(serializeJsonExport(snapshot), "utf8"),
        omissions: snapshot.omissions,
        profileVersion: `open_chords_json/1.0/${request.presentation}`,
      };
    });
  }

  async saveArchive(raw: unknown): Promise<{ state: PublicationState | "media_unavailable" }> {
    const request = archiveRequestSchema.parse(raw);
    try {
      return await this.#publishWithinBudget(request, "project_archive", async () => {
        const project = await this.#options.library.readProject(request.projectId);
        if (project.projectRevisionId !== request.expectedProjectRevisionId)
          throw new Error("Export requires the current writable Project revision");
        const { document, omissions } = archivedProjectFor(project);
        const media = request.includeMedia
          ? await this.#readProjectRange(request.projectId)
          : undefined;
        const { archive, projectHash } = writePortableProjectArchive({
          document,
          ...(media === undefined ? {} : { media }),
        });
        return {
          activeViewHash: projectHash,
          content: archive,
          omissions,
          profileVersion: `project_archive/1.0/${request.includeMedia ? "project_range_media" : "no_media"}`,
        };
      });
    } catch (error) {
      if (error instanceof ExportMediaUnavailableError) return { state: "media_unavailable" };
      throw error;
    }
  }

  async #readProjectRange(projectId: string) {
    const media = this.#options.media;
    if (media === undefined) throw new ExportMediaUnavailableError(undefined);
    try {
      return await media.readVerifiedProjectRange(projectId, async (range) => ({
        bytes: Buffer.from(
          await range.readCanonicalPcm({
            endProjectSample: range.endSourceSample - range.startSourceSample,
            startProjectSample: 0,
          }),
        ),
        channels: 1 as const,
        encoding: "pcm_s16le" as const,
        endSourceSample: range.endSourceSample,
        sampleRate: range.sampleRate,
        sourceId: range.sourceId,
        sourceSnapshotId: range.sourceSnapshotId,
        startSourceSample: range.startSourceSample,
      }));
    } catch (error) {
      throw new ExportMediaUnavailableError(error);
    }
  }

  async #publishWithinBudget(
    request: { expectedProjectRevisionId: string; projectId: string },
    format: ExportFormat,
    prepare: () => Promise<Prepared>,
  ): Promise<{ state: PublicationState }> {
    try {
      return await this.#publish(request, format, prepare);
    } catch (error) {
      if (error instanceof ArchiveTooLargeError || error instanceof ExportTooLargeError)
        return { state: "too_large" };
      throw error;
    }
  }

  async #publish(
    request: { expectedProjectRevisionId: string; projectId: string },
    format: ExportFormat,
    prepare: () => Promise<Prepared>,
  ): Promise<{ state: PublicationState }> {
    if (this.busy) throw new Error("An export is already running");
    const controller = new AbortController();
    this.#controller = controller;
    const signal = controller.signal;
    let temporary: string | undefined;
    let journalPath: string | undefined;
    let published = false;
    try {
      const { library } = this.#options;
      const root = library.activeRoot;
      const entry = library.listProjects().find((item) => item.projectId === request.projectId);
      if (
        entry?.status !== "active" ||
        entry.compatibility !== "writable" ||
        entry.projectRevisionId !== request.expectedProjectRevisionId
      )
        throw new Error("Export requires the current writable Project revision");
      const prepared = await prepare();
      const { content } = prepared;
      if (content.length > TARGETS[format].maxBytes) throw new ExportTooLargeError();
      signal.throwIfAborted();
      const target = await this.#options.pickTarget(format);
      signal.throwIfAborted();
      if (target === null) return { state: "cancelled" };
      const parent = await this.#validateTarget(target, format);
      const parentIdentity = await lstat(parent);
      const id = `export_${randomUUID().replaceAll("-", "")}`;
      temporary = join(parent, `.${id}.tmp`);
      const receipt = ExportReceiptSchema.parse({
        id,
        activeViewHash: prepared.activeViewHash,
        createdAt: new Date().toISOString(),
        format,
        omissions: prepared.omissions,
        outputHash: hash(content),
        outputLocation: resolve(target),
        profileVersion: prepared.profileVersion,
      });
      await mkdir(this.#journalRoot, { recursive: true, mode: 0o700 });
      const journalRootStat = await lstat(this.#journalRoot);
      if (!journalRootStat.isDirectory() || journalRootStat.isSymbolicLink())
        throw new Error("Invalid export recovery directory");
      // Persist the new directory entry itself before relying on its recovery records.
      await syncDirectory(this.#options.stateRoot);
      journalPath = join(this.#journalRoot, `${id}.json`);
      // Persist recovery intent before target publication. A receipt failure can then be retried.
      await writeDurable(
        journalPath,
        canonicalSerialize({
          version: 1,
          libraryRoot: root,
          projectId: request.projectId,
          receipt,
        }),
      );
      await syncDirectory(this.#journalRoot);
      await writeDurable(temporary, content);
      await syncDirectory(parent);
      signal.throwIfAborted();
      await this.#validateTarget(target, format);
      const currentParent = await lstat(parent);
      if (
        currentParent.dev !== parentIdentity.dev ||
        currentParent.ino !== parentIdentity.ino ||
        library.activeRoot !== root
      )
        throw new Error("Export destination changed");
      signal.throwIfAborted();
      await rename(temporary, target);
      published = true;
      temporary = undefined;
      await syncDirectory(parent);
      await library.recordExportReceipt(request.projectId, receipt);
      await rm(journalPath);
      await syncDirectory(this.#journalRoot);
      return { state: "saved" };
    } catch (error) {
      if (published) {
        this.#pendingRecovery++;
        return { state: "receipt_pending" };
      }
      if (signal.aborted) return { state: "cancelled" };
      throw error;
    } finally {
      try {
        if (!published) {
          if (temporary) await rm(temporary, { force: true });
          if (journalPath) {
            await rm(journalPath, { force: true });
            await syncDirectory(this.#journalRoot);
          }
        }
      } finally {
        this.#controller = null;
      }
    }
  }

  async recover() {
    if (this.busy) throw new Error("Export is running");
    this.#recovering = true;
    try {
      await this.#recoverPending();
    } finally {
      this.#recovering = false;
    }
  }

  async #recoverPending() {
    this.#pendingRecovery = 0;
    let names: string[];
    try {
      const stat = await lstat(this.#journalRoot);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error("Invalid export recovery directory");
      names = await readdir(this.#journalRoot);
    } catch (error) {
      if (missing(error)) return;
      this.#pendingRecovery++;
      return;
    }
    if (names.length > 1000) {
      this.#pendingRecovery = names.length;
      return;
    }
    for (const name of names) {
      const path = join(this.#journalRoot, name);
      try {
        if (!/^export_[a-f0-9]{32}\.json$/.test(name))
          throw new Error("Invalid export recovery record");
        const journal = journalSchema.parse(
          JSON.parse((await readBoundedFile(path, 64 * 1024)).toString("utf8")),
        );
        const format = journal.receipt.format;
        if (
          name !== `${journal.receipt.id}.json` ||
          journal.libraryRoot !== this.#options.library.activeRoot ||
          !isExportFormat(format)
        )
          throw new Error("Export recovery identity mismatch");
        const { maxBytes } = TARGETS[format];
        const parent = await this.#validateTarget(journal.receipt.outputLocation, format);
        const temporary = join(parent, `.${journal.receipt.id}.tmp`);
        let targetMatches = false;
        try {
          targetMatches =
            hash(await readBoundedFile(journal.receipt.outputLocation, maxBytes)) ===
            journal.receipt.outputHash;
        } catch (error) {
          if (!missing(error)) throw error;
        }
        if (targetMatches)
          await this.#options.library.recordExportReceipt(journal.projectId, journal.receipt);
        else {
          // An existing Receipt is proof of a completed export even if the user later moved the file.
          const completed = this.receipts(journal.projectId).some(
            (receipt) => canonicalSerialize(receipt) === canonicalSerialize(journal.receipt),
          );
          if (!completed) {
            try {
              await lstat(temporary);
            } catch {
              throw new Error("Published export needs manual recovery");
            }
          }
        }
        try {
          if (hash(await readBoundedFile(temporary, maxBytes)) !== journal.receipt.outputHash)
            throw new Error("Unverified export staging file");
          await rm(temporary);
          await syncDirectory(parent);
        } catch (error) {
          if (!missing(error)) throw error;
        }
        await rm(path);
        await syncDirectory(this.#journalRoot);
      } catch {
        this.#pendingRecovery++;
      }
    }
  }

  async #validateTarget(target: string, format: ExportFormat) {
    if (
      !isAbsolute(target) ||
      !target.toLowerCase().endsWith(TARGETS[format].extension) ||
      basename(target).length > 240
    )
      throw new Error("Export requires an absolute target with the profile extension");
    const parent = dirname(resolve(target));
    // Reject symlinks/junctions in every component; never write through a replaced Locator.
    let current = parse(parent).root;
    for (const component of relative(current, parent).split(sep).filter(Boolean)) {
      current = join(current, component);
      const stat = await lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error("Export destination is not a regular directory");
    }
    const canonicalParent = await realpath(parent);
    for (const root of [
      this.#options.stateRoot,
      this.#options.library.activeRoot,
      ...(this.#options.protectedRoots ?? []),
    ]) {
      if (nested(await realpath(root), join(canonicalParent, basename(target))))
        throw new Error("Protected export target");
    }
    try {
      const stat = await lstat(target);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
        throw new Error("Export target is not a regular independent file");
    } catch (error) {
      if (!missing(error)) throw error;
    }
    return parent;
  }
}

function isExportFormat(format: string): format is ExportFormat {
  return Object.hasOwn(TARGETS, format);
}

async function writeDurable(path: string, content: Buffer | string) {
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(content);
    await file.sync();
  } finally {
    await file.close();
  }
}

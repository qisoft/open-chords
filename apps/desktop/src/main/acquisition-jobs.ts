import { randomUUID } from "node:crypto";
import { mkdir, open, opendir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { AcquisitionJobSummarySchema } from "@open-chords/contracts";
import { canonicalSerialize } from "@open-chords/domain";
import { z } from "zod";

import { createAcquiredSnapshot, AcquisitionPublicationUncertain } from "./acquired-snapshots.ts";
import { type AcquisitionNetwork } from "./acquisition-broker.ts";
import {
  openContainedAcquisitionAttempt,
  verifyAcquisitionRuntime,
  type AcquisitionRuntimeOptions,
} from "./acquisition-runtime.ts";
import { AcquisitionSessionError } from "./acquisition-session.ts";
import { openAcquisitionValidation } from "./acquisition-validation.ts";
import { readBoundedFile } from "./bounded-file.ts";
import { withCpuWork, blockCpuWorkAfterIncompleteCleanup } from "./cpu-work.ts";
import { syncDirectory } from "./filesystem-durability.ts";
import type { NetworkMode } from "./network-mode.ts";
import { cleanupPackagedWorkspace } from "./packaged-sidecar-proof-workspace.ts";
import type { ProjectLibrary } from "./project-library.ts";
import { verifyContainmentRuntime } from "./sidecar-containment-integrity.ts";
import { verifyPackagedSidecarRuntime } from "./sidecar-runtime-integrity.ts";
import { canonicalYouTubeSource } from "./youtube-source.ts";

const RETENTION = 7 * 24 * 60 * 60 * 1000;
const Hash = z.string().regex(/^[a-f0-9]{64}$/u);
const Reason = z.enum([
  "offline",
  "runtime_unavailable",
  "cancelled",
  "interrupted",
  "bot_check",
  "unsupported_delivery",
  "provider_unavailable",
  "endpoint_denied",
  "dns_denied",
  "network_unavailable",
  "budget_exceeded",
  "deadline",
  "cleanup_failure",
  "worker_failed",
  "invalid_output",
]);
const Counters = z.strictObject({
  requests: z.number().int().min(0).max(120),
  redirects: z.number().int().min(0).max(9),
  responseBytes: z
    .number()
    .int()
    .min(0)
    .max(1024 * 1024 * 1024),
  wallTimeMs: z.number().int().min(0).max(600000),
});
const Attempt = z.strictObject({
  id: z.string().regex(/^acquisitionattempt_[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u),
  provider: z.literal("youtube"),
  videoId: z.string().regex(/^[A-Za-z0-9_-]{11}$/u),
  componentHashes: z.strictObject({ extractor: Hash, validation: Hash }),
  policyHash: Hash,
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().optional(),
  state: z.enum(["running", "succeeded", "failed", "cancelled"]),
  reason: Reason.optional(),
  counters: Counters,
});
const JobSchema = z
  .strictObject({
    id: z.string().uuid(),
    videoId: z.string().regex(/^[A-Za-z0-9_-]{11}$/u),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    state: z.enum(["blocked", "running", "succeeded", "failed", "cancelled"]),
    stage: z.enum(["acquiring", "validating", "publishing"]).optional(),
    reason: Reason.optional(),
    attempts: z.array(Attempt).max(10),
    snapshotId: z
      .string()
      .regex(/^snapshot_[a-f0-9]{64}$/u)
      .optional(),
    sourceId: z.string().max(150).optional(),
  })
  .superRefine(({ id, videoId, state, stage, reason, snapshotId, sourceId }, context) => {
    const summary = AcquisitionJobSummarySchema.safeParse({
      id,
      videoId,
      state,
      ...(stage !== undefined ? { stage } : {}),
      ...(reason !== undefined ? { reason } : {}),
      ...(snapshotId !== undefined ? { snapshotId } : {}),
    });
    if (!summary.success || (state === "succeeded" ? !sourceId : sourceId !== undefined))
      context.addIssue({ code: "custom", message: "Invalid acquisition lifecycle" });
  });
export type AcquisitionJob = z.infer<typeof JobSchema>;
export type AcquisitionJobsOptions = {
  stateRoot: string;
  network: NetworkMode;
  library?: ProjectLibrary;
  runtime?: AcquisitionRuntimeOptions;
  validation?: AcquisitionRuntimeOptions;
  policyHash?: string;
  networkTransport?: AcquisitionNetwork;
  now?: () => Date;
};
const Catalog = z.strictObject({ version: z.literal(1), jobs: z.array(JobSchema).max(1000) });
const Journal = z.strictObject({ decoderId: z.string().uuid() });

export class AcquisitionJobsOpenError extends Error {
  readonly code: "cleanup_unverified" | "state_unavailable";
  constructor(code: "cleanup_unverified" | "state_unavailable") {
    super(`acquisition_${code}`);
    this.code = code;
  }
}

async function recoverAcquisitionWorkspaces(root: string, runtime?: AcquisitionRuntimeOptions) {
  await removeTemporaryRecords(root);
  await removeTemporaryRecords(join(root, "workspaces"));
  let count = 0;
  for await (const entry of await opendir(join(root, "workspaces"))) {
    if (
      ++count > 64 ||
      !entry.isFile() ||
      !z.string().uuid().safeParse(entry.name).success ||
      !runtime ||
      (process.platform !== "darwin" && process.platform !== "win32")
    )
      throw new Error("acquisition_cleanup_unavailable");
    const journal = Journal.parse(
      JSON.parse(
        (await readBoundedFile(join(root, "workspaces", entry.name), 1024)).toString("utf8"),
      ),
    );
    const containment = verifyContainmentRuntime(
      runtime.containmentRoot,
      runtime.containmentManifestHash,
      process.platform,
      runtime.bridgePath,
    );
    cleanupPackagedWorkspace(process.platform, containment.helperPath, entry.name);
    cleanupPackagedWorkspace(process.platform, containment.helperPath, journal.decoderId);
    await rm(join(root, "workspaces", entry.name));
    await syncDirectory(join(root, "workspaces"));
  }
}

export async function openAcquisitionJobs(options: AcquisitionJobsOptions) {
  const root = join(options.stateRoot, "acquisition-jobs");
  let cleanupVerified = false;
  let manager: AcquisitionJobs | undefined;
  try {
    await mkdir(join(root, "workspaces"), { recursive: true, mode: 0o700 });
    await recoverAcquisitionWorkspaces(root, options.runtime);
    cleanupVerified = true;
    let jobs: AcquisitionJob[] = [];
    try {
      jobs = Catalog.parse(
        JSON.parse((await readBoundedFile(join(root, "state.json"), 1024 * 1024)).toString("utf8")),
      ).jobs;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    manager = new AcquisitionJobs(root, options, jobs);
    await manager.recover();
    return manager;
  } catch {
    await manager?.close().catch(() => undefined);
    // Never retain private catalog contents, native paths, or original error causes.
    throw new AcquisitionJobsOpenError(
      cleanupVerified ? "state_unavailable" : "cleanup_unverified",
    );
  }
}

export class AcquisitionJobs {
  readonly #root: string;
  readonly #options: AcquisitionJobsOptions;
  readonly #unsubscribe: () => void;
  #jobs: AcquisitionJob[];
  #closed = false;
  #poisoned = false;
  #pending = 0;
  #write: Promise<unknown> = Promise.resolve();
  #expiryTimer: ReturnType<typeof setTimeout> | undefined;
  readonly #starting = new Set<AbortController>();
  readonly #active = new Map<string, { abort: AbortController; done: Promise<AcquisitionJob> }>();
  constructor(root: string, options: AcquisitionJobsOptions, jobs: AcquisitionJob[]) {
    this.#root = root;
    this.#options = options;
    this.#jobs = jobs;
    this.#unsubscribe = options.network.subscribe(() => {
      if (options.network.offline) {
        for (const abort of this.#starting) abort.abort();
        for (const active of this.#active.values()) active.abort.abort();
      }
    });
  }
  #now() {
    return this.#options.now?.() ?? new Date();
  }
  list() {
    const retained = this.#retained();
    if (!this.#closed && retained.length !== this.#jobs.length)
      void this.#serialize(() => this.#expire()).catch(() => {
        this.#poisoned = true;
      });
    return structuredClone(retained);
  }
  #retained() {
    const cutoff = this.#now().getTime() - RETENTION;
    return this.#jobs.filter(
      (job) =>
        job.state === "running" || job.state === "succeeded" || Date.parse(job.updatedAt) > cutoff,
    );
  }
  async #expire() {
    const retained = this.#retained();
    if (retained.length === this.#jobs.length) return;
    await this.#persist(retained);
    this.#jobs = retained;
  }
  #scheduleExpiry(jobs: AcquisitionJob[]) {
    clearTimeout(this.#expiryTimer);
    if (this.#closed) return;
    const expirations = jobs
      .filter((job) => job.state !== "running" && job.state !== "succeeded")
      .map((job) => Date.parse(job.updatedAt) + RETENTION);
    if (expirations.length === 0) return;
    this.#expiryTimer = setTimeout(
      () => {
        void this.#serialize(() => this.#expire()).catch(() => {
          this.#poisoned = true;
        });
      },
      Math.max(1, Math.min(RETENTION, Math.min(...expirations) - this.#now().getTime())),
    );
    this.#expiryTimer.unref();
  }
  async recover() {
    const sources = (await this.#options.library?.listYouTubeSources()) ?? [];
    const cutoff = this.#now().getTime() - RETENTION;
    this.#jobs = this.#jobs
      .filter(
        (job) =>
          job.state === "succeeded" ||
          job.state === "running" ||
          Date.parse(job.updatedAt) > cutoff,
      )
      .map((job) => {
        if (job.state !== "running") return job;
        const attempt = job.attempts.at(-1);
        const published = sources
          .flatMap((source) => source.snapshots.map((snapshot) => ({ source, snapshot })))
          .find(
            (item) =>
              item.snapshot.provenance.kind === "youtube_acquisition" &&
              item.snapshot.provenance.acquisitionAttemptId === attempt?.id,
          );
        const state = published ? ("succeeded" as const) : ("failed" as const);
        const updatedAt = this.#now().toISOString();
        const { stage: _stage, ...rest } = job;
        return JobSchema.parse({
          ...rest,
          state,
          updatedAt,
          ...(published
            ? { snapshotId: published.snapshot.id, sourceId: published.source.id }
            : { reason: "interrupted" }),
          attempts: job.attempts.map((item) =>
            item.state === "running"
              ? {
                  ...item,
                  state,
                  finishedAt: updatedAt,
                  ...(!published ? { reason: "interrupted" } : {}),
                }
              : item,
          ),
        });
      });
    await this.#persist(this.#jobs);
  }
  async start(raw: { url: string }): Promise<AcquisitionJob> {
    let videoId: string;
    try {
      const input = z.strictObject({ url: z.string().max(4096) }).parse(raw);
      videoId = canonicalYouTubeSource(input.url).identity.videoId;
    } catch {
      throw new Error("invalid_input");
    }
    if (this.#closed) throw new Error("acquisition_closed");
    if (this.#pending >= 32) throw new Error("acquisition_busy");
    this.#pending++;
    const abort = new AbortController();
    this.#starting.add(abort);
    const operation = this.#serialize(async () => {
      if (this.#closed) throw new Error("acquisition_closed");
      if (this.#active.size) throw new Error("acquisition_busy");
      await this.#expire();
      if (this.#jobs.length >= 1000) throw new Error("acquisition_history_full");
      const { runtime, validation, library, policyHash, network } = this.#options;
      let reason: z.infer<typeof Reason> | undefined;
      if (this.#poisoned) reason = "cleanup_failure";
      else if (network.offline) reason = "offline";
      else if (!runtime || !validation || !library || !Hash.safeParse(policyHash).success)
        reason = "runtime_unavailable";
      else {
        try {
          await verifyAcquisitionRuntime(runtime.runtimeRoot, runtime.runtimeManifestHash);
          verifyPackagedSidecarRuntime(validation.runtimeRoot, validation.runtimeManifestHash);
        } catch {
          reason = "runtime_unavailable";
        }
      }
      if (network.offline) reason = "offline";
      const now = this.#now().toISOString();
      const attempt =
        reason === undefined && runtime && validation && policyHash
          ? Attempt.parse({
              id: `acquisitionattempt_${randomUUID()}`,
              provider: "youtube",
              videoId,
              componentHashes: {
                extractor: runtime.runtimeManifestHash,
                validation: validation.runtimeManifestHash,
              },
              policyHash,
              startedAt: now,
              state: "running",
              counters: { requests: 0, redirects: 0, responseBytes: 0, wallTimeMs: 0 },
            })
          : undefined;
      const job = JobSchema.parse({
        id: randomUUID(),
        videoId,
        createdAt: now,
        updatedAt: now,
        state: attempt ? "running" : "blocked",
        ...(reason ? { reason } : { stage: "acquiring" }),
        attempts: attempt ? [attempt] : [],
      });
      await this.#persist([...this.#jobs, job]);
      this.#jobs.push(job);
      if (attempt) {
        const done = this.#run(job, attempt, abort.signal).finally(() =>
          this.#active.delete(job.id),
        );
        this.#active.set(job.id, { abort, done });
        void done.catch(() => {
          this.#poisoned = true;
        });
      }
      return structuredClone(job);
    });
    try {
      return await operation;
    } finally {
      this.#starting.delete(abort);
      this.#pending--;
    }
  }
  async wait(id: string) {
    const active = this.#active.get(id);
    if (active) return active.done;
    const job = this.#jobs.find((item) => item.id === id);
    if (!job) throw new Error("acquisition_job_missing");
    return structuredClone(job);
  }
  async cancel(id: string) {
    this.#active.get(id)?.abort.abort();
    return this.wait(id);
  }
  async clearHistory() {
    await this.#serialize(async () => {
      const retained = this.#jobs.filter(
        (job) => job.state === "running" || job.state === "succeeded",
      );
      await this.#persist(retained);
      this.#jobs = retained;
    });
    return this.list();
  }
  async close() {
    this.#closed = true;
    clearTimeout(this.#expiryTimer);
    this.#unsubscribe();
    for (const abort of this.#starting) abort.abort();
    for (const active of this.#active.values()) active.abort.abort();
    // Starts paused in durable publication must hand off before we await attempts.
    await this.#write.catch(() => undefined);
    for (const active of this.#active.values()) active.abort.abort();
    await Promise.allSettled([...this.#active.values()].map((active) => active.done));
    await this.#write.catch(() => undefined);
    if (this.#poisoned) throw new Error("acquisition_cleanup_failed");
  }
  async #run(
    job: AcquisitionJob,
    attempt: z.infer<typeof Attempt>,
    signal: AbortSignal,
  ): Promise<AcquisitionJob> {
    const { runtime, validation, library, policyHash } = this.#options;
    if (!runtime || !validation || !library || !policyHash)
      throw new Error("acquisition_runtime_unavailable");
    const decoderId = randomUUID();
    const workspaceId = attempt.id.slice("acquisitionattempt_".length);
    const journal = join(this.#root, "workspaces", workspaceId);
    let extractor: Awaited<ReturnType<typeof openContainedAcquisitionAttempt>> | undefined;
    let decoder: Awaited<ReturnType<typeof openAcquisitionValidation>> | undefined;
    let counters = { requests: 0, redirects: 0, responseBytes: 0, wallTimeMs: 0 };
    const started = performance.now();
    let cleaned = false;
    let domainUnsafe = false;
    const cleanup = async () => {
      if (cleaned) return;
      if (domainUnsafe) throw new AcquisitionSessionError("cleanup_failure");
      try {
        extractor?.cleanup();
        decoder?.cleanup();
        await rm(journal, { force: true });
        await syncDirectory(join(this.#root, "workspaces"));
        cleaned = true;
      } catch {
        this.#poisoned = true;
        throw new AcquisitionSessionError("cleanup_failure");
      }
    };
    let completed: { snapshotId: string; sourceId: string } | undefined;
    let failure: z.infer<typeof Reason> | undefined;
    try {
      await withCpuWork(signal, async () => {
        try {
          await writePrivateRecord(journal, canonicalSerialize({ decoderId }));
          signal.throwIfAborted();
          extractor = await openContainedAcquisitionAttempt(runtime, workspaceId);
          const acquired = await extractor.run({
            videoId: job.videoId,
            signal,
            ...(this.#options.networkTransport ? { network: this.#options.networkTransport } : {}),
            onCounters: (value) => {
              counters = {
                requests: value.requests,
                redirects: value.redirects,
                responseBytes: value.responseBytes,
                wallTimeMs: Math.min(600000, Math.max(1, Math.round(performance.now() - started))),
              };
            },
          });
          if (acquired.proof || !acquired.format) throw new Error("invalid_acquisition_artifact");
          await this.#stage(job.id, "validating");
          signal.throwIfAborted();
          decoder = await openAcquisitionValidation(validation, decoderId);
          const canonical = await decoder.validate({
            path: join(extractor.workspace, acquired.artifact.path),
            bytes: acquired.artifact.bytes,
            sha256: acquired.artifact.sha256,
            signal,
          });
          signal.throwIfAborted();
          const expectedCodec = acquired.format.audioCodec.startsWith("mp4a.")
            ? "aac"
            : acquired.format.audioCodec;
          if (
            canonical.format.container !== acquired.format.container ||
            canonical.format.audioCodec !== expectedCodec
          )
            throw new Error("invalid_acquisition_format");
          const snapshot = createAcquiredSnapshot({
            id: "snapshot_pending",
            byteFingerprint: `sha256:${acquired.artifact.sha256}`,
            byteSize: acquired.artifact.bytes,
            canonicalAudioFingerprint: canonical.canonicalAudioFingerprint,
            durationSamples: canonical.durationSamples,
            metadataObservationIds: [],
            observedAt: this.#now().toISOString(),
            selectedFormat: { ...acquired.format, ...canonical.format },
            provenance: {
              kind: "youtube_acquisition",
              acquisitionAttemptId: attempt.id,
              provider: "youtube",
              videoId: job.videoId,
              canonicalUrl: `https://www.youtube.com/watch?v=${job.videoId}`,
              components: [
                {
                  id: "open-chords-extractor-runtime",
                  version: "1",
                  hash: `sha256:${runtime.runtimeManifestHash}`,
                },
                {
                  id: "open-chords-offline-validation-runtime",
                  version: "1",
                  hash: `sha256:${validation.runtimeManifestHash}`,
                },
              ],
              policy: {
                id: "youtube-broker-provisional",
                version: "1",
                hash: `sha256:${policyHash}`,
              },
              brokerSummary: {
                requestCount: counters.requests,
                redirectCount: counters.redirects,
                downloadedBytes: acquired.artifact.bytes,
                wallTimeMs: counters.wallTimeMs,
              },
            },
          });
          await this.#stage(job.id, "publishing");
          const source = await library.publishYouTubeSnapshot({
            snapshot,
            mediaPath: canonical.acquiredPath,
            canonicalPath: canonical.path,
            canonicalBytes: canonical.byteSize,
            canonicalHash: canonical.byteFingerprint.slice(7),
            signal,
            beforePublication: cleanup,
          });
          completed = { snapshotId: snapshot.id, sourceId: source.id };
        } catch (error) {
          if (error instanceof Error && "code" in error && error.code === "cleanup_failure") {
            domainUnsafe = true;
            this.#poisoned = true;
          }
          try {
            await cleanup();
          } catch (cleanupError) {
            blockCpuWorkAfterIncompleteCleanup();
            throw cleanupError;
          }
          throw error;
        }
      });
    } catch (error) {
      if (error instanceof AcquisitionPublicationUncertain) {
        // Keep the durable running Job as recovery intent. No further work may
        // start until reopening reconciles the catalog with this Attempt.
        this.#poisoned = true;
        blockCpuWorkAfterIncompleteCleanup();
        throw error;
      }
      const code =
        error instanceof Error && "code" in error ? Reason.safeParse(error.code) : undefined;
      if (code?.success && code.data === "cleanup_failure") {
        domainUnsafe = true;
        this.#poisoned = true;
        failure = "cleanup_failure";
      } else failure = signal.aborted ? "cancelled" : code?.success ? code.data : "invalid_output";
    }
    try {
      await cleanup();
    } catch {
      failure = "cleanup_failure";
    }
    const state = completed ? "succeeded" : failure === "cancelled" ? "cancelled" : "failed";
    return this.#serialize(async () => {
      const current = this.#jobs.find((item) => item.id === job.id)!;
      const { stage: _stage, ...retained } = current;
      const now = this.#now().toISOString();
      const terminal = JobSchema.parse({
        ...retained,
        state,
        updatedAt: now,
        ...(completed ?? { reason: failure ?? "worker_failed" }),
        attempts: [
          {
            ...attempt,
            state,
            counters,
            finishedAt: now,
            ...(!completed ? { reason: failure ?? "worker_failed" } : {}),
          },
        ],
      });
      const jobs = this.#jobs.map((item) => (item.id === job.id ? terminal : item));
      await this.#persist(jobs);
      this.#jobs = jobs;
      return structuredClone(terminal);
    });
  }
  async #stage(id: string, stage: "validating" | "publishing") {
    await this.#serialize(async () => {
      const jobs = this.#jobs.map((job) =>
        job.id === id ? { ...job, stage, updatedAt: this.#now().toISOString() } : job,
      );
      await this.#persist(jobs);
      this.#jobs = jobs;
    });
  }
  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.#write.catch(() => undefined).then(operation);
    this.#write = pending;
    return pending;
  }
  async #persist(jobs: AcquisitionJob[]) {
    const content = canonicalSerialize(Catalog.parse({ version: 1, jobs }));
    if (Buffer.byteLength(content) > 1024 * 1024) throw new Error("acquisition_history_full");
    await removeTemporaryRecords(this.#root);
    await writePrivateRecord(join(this.#root, "state.json"), content);
    this.#scheduleExpiry(jobs);
  }
}

async function removeTemporaryRecords(root: string) {
  let count = 0;
  let removed = false;
  for await (const entry of await opendir(root)) {
    if (++count > 1100) throw new Error("acquisition_state_invalid");
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.tmp$/u.test(entry.name)) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) throw new Error("acquisition_state_invalid");
    await rm(join(root, entry.name));
    removed = true;
  }
  if (removed) await syncDirectory(root);
}

async function writePrivateRecord(destination: string, content: string) {
  const root = dirname(destination);
  const temp = join(root, `${randomUUID()}.tmp`);
  try {
    const file = await open(temp, "wx", 0o600);
    try {
      await file.writeFile(content);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temp, destination);
    await syncDirectory(root);
  } finally {
    await rm(temp, { force: true });
  }
}

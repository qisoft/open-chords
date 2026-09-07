import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";

import {
  AlignmentRecipeSchema as recipeSchema,
  canonicalSerialize,
  parseProjectContract,
  resolveLyricsAnchors,
  type ProjectContract,
  type LyricsDocument,
  type LyricsAlignment,
  type AlignmentRecipe,
} from "@open-chords/domain";
import { z } from "zod";

import { alignmentFailureKind } from "./alignment-failure.ts";
import { readBoundedFile } from "./bounded-file.ts";
import { withCpuWork } from "./cpu-work.ts";
import { syncDirectory } from "./filesystem-durability.ts";
import type { AlignmentPack, ModelStore } from "./model-store.ts";
import type { ProjectLibrary } from "./project-library.ts";

const sha = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const id = z.string().min(1).max(160);
const hash = (value: unknown) =>
  `sha256:${createHash("sha256").update(canonicalSerialize(value)).digest("hex")}`;
const jobSchema = z.strictObject({
  id,
  key: sha,
  recipe: recipeSchema,
  state: z.enum([
    "blocked",
    "queued",
    "running",
    "succeeded",
    "retryable",
    "cancelled",
    "awaiting_confirmation",
  ]),
  alignmentId: id.optional(),
  startedAt: z.number().int().nonnegative().optional(),
  finishedAt: z.number().int().nonnegative().optional(),
  failure: z
    .enum(["integrity", "protocol", "cleanup", "worker", "interrupted", "storage"])
    .optional(),
  failureCount: z.number().int().nonnegative().max(3).default(0),
  circuitOpen: z.boolean().default(false),
  stage: z
    .enum([
      "waiting_for_cpu",
      "verifying_runtime",
      "staging",
      "aligning",
      "cleanup",
      "validating",
      "completed",
    ])
    .optional(),
  blockedReasons: z
    .array(z.enum(["missing_pack", "unsupported_language", "missing_runtime", "runtime_failure"]))
    .max(4),
});
type Job = z.infer<typeof jobSchema>;
type Options = {
  stateRoot: string;
  modelStore: ModelStore;
  packs: AlignmentPack[];
  runtimeManifestHash: string;
};
type Request = {
  project: ProjectContract;
  lyricsDocumentId: string;
  analysisRevisionId: string;
  canonicalAudioFingerprint: string;
};
const outputSchema = z.strictObject({
  recipeHash: sha,
  likelihood: z.number().finite(),
  words: z
    .array(
      z.union([
        z.strictObject({
          tokenId: id,
          startSample: z.number().int().nonnegative(),
          endSample: z.number().int().positive(),
        }),
        z.strictObject({
          tokenId: id,
          reason: z.enum([
            "oov",
            "absent_line",
            "annotation",
            "unsupported_language",
            "anchor_conflict",
            "alignment_mismatch",
            "melisma",
            "overlapping_vocals",
          ]),
        }),
      ]),
    )
    .max(16000),
});
export type AlignmentWorker = (input: {
  recipe: AlignmentRecipe;
  recipeHash: string;
  document: LyricsDocument;
  signal: AbortSignal;
  reportStage: (stage: NonNullable<Job["stage"]>) => Promise<void>;
}) => Promise<unknown>;

export async function openAlignmentJobs(options: Options) {
  const root = join(options.stateRoot, "alignment-jobs");
  await mkdir(root, { recursive: true });
  if (!(await lstat(root)).isDirectory()) throw new Error("Invalid Alignment Job storage");
  const path = join(root, "state.json");
  let jobs: Job[] = [];
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024)
      throw new Error("Invalid Alignment Job state");
    jobs = z
      .array(jobSchema)
      .max(1000)
      .parse(JSON.parse((await readBoundedFile(path, 4 * 1024 * 1024)).toString("utf8")));
    if (
      new Set(jobs.map((job) => job.id)).size !== jobs.length ||
      new Set(jobs.map((job) => job.key)).size !== jobs.length ||
      jobs.some((job) => hash(job.recipe) !== job.key)
    )
      throw new Error("Invalid Alignment Job identity");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  let tail = Promise.resolve();
  let queuedMutations = 0;
  const controllers = new Map<string, AbortController>();
  const workerFailures = new Map<string, number>();
  const serialize = <T>(operation: () => Promise<T>) => {
    if (queuedMutations >= 64)
      return Promise.reject<T>(new Error("Alignment mutation queue is full"));
    queuedMutations++;
    const next = tail.then(operation).finally(() => {
      queuedMutations--;
    });
    tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };
  async function persist(next: Job[]) {
    const bytes = canonicalSerialize(next);
    if (Buffer.byteLength(bytes) > 4 * 1024 * 1024)
      throw new Error("Alignment Job storage limit reached");
    const temporary = join(root, `state-${randomUUID()}.tmp`);
    try {
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, path);
      jobs = next;
      await syncDirectory(root);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  const recovered = jobs.map((job) =>
    job.circuitOpen
      ? { ...job, circuitOpen: false, failureCount: 0, state: "awaiting_confirmation" as const }
      : job.state === "running"
        ? { ...job, state: "retryable" as const }
        : job.state === "queued"
          ? { ...job, state: "awaiting_confirmation" as const }
          : job,
  );
  if (recovered.some((job, index) => job.state !== jobs[index]!.state)) await persist(recovered);
  async function blockedReasons(recipe: AlignmentRecipe): Promise<Job["blockedReasons"]> {
    if (
      jobs.some(
        (job) => job.circuitOpen && job.recipe.runtimeManifestHash === recipe.runtimeManifestHash,
      )
    )
      return ["runtime_failure"];
    if (!options.packs.some((pack) => pack.id === recipe.packId)) return ["unsupported_language"];
    if (
      recipe.runtimeManifestHash === "unavailable" ||
      recipe.runtimeManifestHash !== options.runtimeManifestHash
    )
      return ["missing_runtime"];
    return recipe.artifacts.length > 0 &&
      (
        await Promise.all(recipe.artifacts.map((artifact) => options.modelStore.resolve(artifact)))
      ).every(Boolean)
      ? []
      : ["missing_pack"];
  }
  return {
    async list(projectId: string) {
      await tail;
      return structuredClone(
        jobs
          .filter((job) => job.recipe.projectId === projectId)
          .toReversed()
          .slice(0, 100),
      );
    },
    confirm(jobId: string) {
      return serialize(async () => {
        const current = jobs.find((item) => item.id === jobId);
        if (
          !current ||
          controllers.has(jobId) ||
          current.state === "running" ||
          current.state === "succeeded"
        )
          throw new Error("Alignment Job cannot be confirmed");
        const reasons = await blockedReasons(current.recipe);
        const next = jobSchema.parse({
          ...current,
          state: reasons.length === 0 ? "queued" : "blocked",
          blockedReasons: reasons,
        });
        delete next.startedAt;
        delete next.finishedAt;
        delete next.stage;
        await persist(jobs.map((item) => (item.id === jobId ? next : item)));
        return structuredClone(next);
      });
    },
    async get(jobId: string) {
      await tail;
      return structuredClone(jobs.find((job) => job.id === jobId) ?? null);
    },
    interrupt() {
      return serialize(async () => {
        try {
          await persist(
            jobs.map((job) =>
              job.state === "running"
                ? { ...job, state: "retryable", failure: "interrupted", finishedAt: Date.now() }
                : job.state === "queued"
                  ? { ...job, state: "awaiting_confirmation" }
                  : job,
            ),
          );
        } finally {
          for (const controller of controllers.values()) controller.abort();
        }
      });
    },
    cancel(jobId: string) {
      return serialize(async () => {
        const current = jobs.find((item) => item.id === jobId);
        if (!current) throw new Error("Alignment Job unavailable");
        if (current.state === "succeeded") return;
        if (current.state === "cancelled") {
          controllers.get(jobId)?.abort();
          return;
        }
        try {
          await persist(
            jobs.map((item) =>
              item.id === jobId ? { ...item, state: "cancelled", finishedAt: Date.now() } : item,
            ),
          );
        } finally {
          controllers.get(jobId)?.abort();
        }
      });
    },
    async run(jobId: string, dependencies: { library: ProjectLibrary; worker: AlignmentWorker }) {
      const job = await serialize(async () => {
        const current = jobs.find((item) => item.id === jobId);
        if (
          !current ||
          current.state !== "queued" ||
          controllers.size > 0 ||
          jobs.some((item) => item.state === "running")
        )
          throw new Error("Alignment Job is not runnable");
        const snapshot = await dependencies.library.getSnapshot(current.recipe.projectId);
        const published = snapshot?.project.lyricsAlignments.find(
          (item) =>
            item.id === `alignment_${current.key.slice(7)}` &&
            item.provenance?.recipeHash === current.key &&
            hash(item.provenance.recipe) === current.key,
        );
        if (published) {
          const completed = {
            ...current,
            state: "succeeded" as const,
            stage: "completed" as const,
            alignmentId: published.id,
          };
          await persist(jobs.map((item) => (item.id === jobId ? completed : item)));
          return structuredClone(completed);
        }
        const reasons = await blockedReasons(current.recipe);
        if (reasons.length > 0) {
          const blocked = { ...current, state: "blocked" as const, blockedReasons: reasons };
          await persist(jobs.map((item) => (item.id === jobId ? blocked : item)));
          return structuredClone(blocked);
        }
        const running = {
          ...current,
          startedAt: Date.now(),
          state: "running" as const,
          stage: "waiting_for_cpu" as const,
        };
        await persist(jobs.map((item) => (item.id === jobId ? running : item)));
        controllers.set(jobId, new AbortController());
        return structuredClone(running);
      });
      if (job.state !== "running") return job;
      const reportStage = (stage: NonNullable<Job["stage"]>) =>
        serialize(async () => {
          if (jobs.find((item) => item.id === job.id)?.state !== "running") return;
          await persist(jobs.map((item) => (item.id === job.id ? { ...item, stage } : item)));
        });
      let phase: "storage" | "worker" | "validation" = "storage";
      try {
        const snapshot = await dependencies.library.getSnapshot(job.recipe.projectId);
        const document = snapshot?.project.lyricsDocuments.find(
          (item) => item.id === job.recipe.lyricsDocumentId,
        );
        const revision = snapshot?.project.analysisRevisions.find(
          (item) => item.id === job.recipe.analysisRevisionId,
        );
        if (
          !snapshot ||
          !document ||
          !revision ||
          hash(document) !== job.recipe.documentHash ||
          hash(revision) !== job.recipe.revisionHash
        )
          throw new Error("Alignment inputs changed");
        phase = "worker";
        const candidate = await withCpuWork(controllers.get(job.id)!.signal, async () => {
          await reportStage("verifying_runtime");
          return dependencies.worker({
            recipe: job.recipe,
            recipeHash: job.key,
            document,
            signal: controllers.get(job.id)!.signal,
            reportStage,
          });
        });
        phase = "storage";
        await reportStage("validating");
        phase = "validation";
        const output = outputSchema.parse(candidate);
        if (
          output.recipeHash !== job.key ||
          output.words.length !== document.tokens.length ||
          output.words.some((word, index) => word.tokenId !== document.tokens[index]!.id)
        )
          throw new Error("Invalid Alignment output identity");
        for (const anchor of job.recipe.anchors) {
          const first = document.tokens.findIndex((token) => token.id === anchor.firstTokenId);
          const last = document.tokens.findIndex((token) => token.id === anchor.lastTokenId);
          if (first < 0 || last < first) throw new Error("Invalid Lyrics Anchor identity");
          for (const [index, word] of output.words.entries()) {
            if ("reason" in word) continue;
            if (
              (index < first && word.endSample > anchor.startSample) ||
              (index > last && word.startSample < anchor.endSample) ||
              (index >= first &&
                index <= last &&
                (word.startSample < anchor.startSample || word.endSample > anchor.endSample))
            )
              throw new Error("Alignment output violates a Lyrics Anchor");
          }
        }
        const assertion = {
          state: "low_confidence" as const,
          reasonCodes: ["uncalibrated_alignment"],
          evidence: [
            {
              name: "mfa_utterance_likelihood",
              scale: "kaldi_log_likelihood",
              value: output.likelihood,
            },
          ],
        };
        const alignment: LyricsAlignment = {
          id: `alignment_${job.key.slice(7)}`,
          analysisRevisionId: revision.id,
          lyricsDocumentId: document.id,
          provenance: {
            recipe: job.recipe,
            recipeHash: job.key,
            resultHash: hash(output),
            qualityStatus: "benchmark_pending",
          },
          occurrences: output.words.map((word) => ({
            tokenId: word.tokenId,
            timing:
              "reason" in word
                ? { state: "unmatched", reasonCode: word.reason }
                : {
                    state: "matched",
                    startSample: word.startSample,
                    endSample: word.endSample,
                    assertion,
                  },
          })),
          lineOccurrences: [],
        };
        alignment.lineOccurrences = document.lines.map((line) => {
          const tokenIds = new Set(
            document.tokens.filter((token) => token.lineId === line.id).map((token) => token.id),
          );
          const timings = alignment.occurrences
            .filter((item) => tokenIds.has(item.tokenId))
            .map((item) => item.timing);
          const matched = timings.filter((timing) => timing.state === "matched");
          return {
            lineId: line.id,
            timing:
              matched.length === 0
                ? { state: "unmatched" as const, reasonCode: "no_aligned_words" }
                : {
                    state: "matched" as const,
                    startSample: matched[0]!.startSample,
                    endSample: matched.at(-1)!.endSample,
                    assertion: {
                      ...assertion,
                      reasonCodes:
                        matched.length === timings.length
                          ? assertion.reasonCodes
                          : ["uncalibrated_alignment", "partial_word_coverage"],
                    },
                  },
          };
        });
        parseProjectContract({
          ...snapshot.project,
          lyricsAlignments: [...snapshot.project.lyricsAlignments, alignment],
        });
        phase = "storage";
        return await serialize(async () => {
          if (
            jobs.find((item) => item.id === job.id)?.state !== "running" ||
            controllers.get(job.id)!.signal.aborted
          )
            throw new Error("Alignment Job cancelled");
          await dependencies.library.publishLyricsAlignment({
            projectId: job.recipe.projectId,
            alignment,
          });
          const completed = {
            ...job,
            finishedAt: Date.now(),
            state: "succeeded" as const,
            stage: "completed" as const,
            alignmentId: alignment.id,
          };
          await persist(jobs.map((item) => (item.id === job.id ? completed : item)));
          return structuredClone(completed);
        });
      } catch (error) {
        await serialize(async () => {
          const failure =
            phase === "validation"
              ? "integrity"
              : phase === "storage"
                ? "storage"
                : alignmentFailureKind(error);
          const current = jobs.find((item) => item.id === job.id);
          if (!current || (current.state !== "running" && failure !== "cleanup")) return;
          const failureCount = Math.min(3, job.failureCount + 1);
          const runtimeFailures =
            (workerFailures.get(job.recipe.runtimeManifestHash) ?? 0) +
            (failure === "storage" ? 0 : 1);
          if (failure !== "storage")
            workerFailures.set(job.recipe.runtimeManifestHash, runtimeFailures);
          const circuitOpen =
            failure !== "storage" && (failure !== "worker" || runtimeFailures >= 3);
          await persist(
            jobs.map((item) =>
              item.id === job.id
                ? {
                    ...item,
                    state:
                      item.state === "cancelled"
                        ? "cancelled"
                        : circuitOpen
                          ? "blocked"
                          : "retryable",
                    failure,
                    failureCount,
                    circuitOpen,
                    blockedReasons: circuitOpen ? ["runtime_failure"] : [],
                    finishedAt: Date.now(),
                  }
                : item,
            ),
          );
        });
        throw error;
      } finally {
        controllers.delete(job.id);
      }
    },
    request(raw: Request) {
      // Capture immutable caller inputs before entering the serialization queue.
      const input = structuredClone(raw);
      return serialize(async () => {
        const project = parseProjectContract(input.project);
        const document = project.lyricsDocuments.find((item) => item.id === input.lyricsDocumentId);
        const revision = project.analysisRevisions.find(
          (item) => item.id === input.analysisRevisionId,
        );
        if (!document || !revision) throw new Error("Alignment inputs are unavailable");
        const pack = options.packs.find((item) => item.language === document.language);
        const recipe = recipeSchema.parse({
          version: "1.0",
          runtimeManifestHash: options.runtimeManifestHash,
          workerProfile: "kalpy_single_primary_v1_beam10_retry40",
          projectId: project.id,
          lyricsDocumentId: document.id,
          documentHash: hash(document),
          analysisRevisionId: revision.id,
          revisionHash: hash(revision),
          canonicalAudioFingerprint: input.canonicalAudioFingerprint,
          durationSamples: project.durationSamples,
          sampleRate: project.sampleRate,
          normalization: "unicode_nfkc_lower_v1",
          anchors: resolveLyricsAnchors(project).filter(
            (anchor) =>
              anchor.lyricsDocumentId === document.id && anchor.analysisRevisionId === revision.id,
          ),
          packId: pack?.id ?? "unsupported",
          runtimeId: pack?.runtime ?? "unavailable",
          artifacts:
            pack?.artifacts.map(({ id: artifactId, version, sha256 }) => ({
              id: artifactId,
              version,
              sha256,
            })) ?? [],
        });
        const key = hash(recipe);
        const existing = jobs.find((job) => job.key === key);
        if (existing) return structuredClone(existing);
        if (jobs.length >= 1000) throw new Error("Alignment Job limit reached");
        const reasons = await blockedReasons(recipe);
        const job = jobSchema.parse({
          id: `alignment_job_${randomUUID().replaceAll("-", "")}`,
          key,
          recipe,
          state: reasons.length === 0 ? "queued" : "blocked",
          blockedReasons: reasons,
        });
        await persist([...jobs, job]);
        return structuredClone(job);
      });
    },
  };
}

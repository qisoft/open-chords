import {
  AlignmentActionSchema,
  AlignmentJobSummarySchema,
  type AlignmentAction,
} from "@open-chords/contracts";

import { openAlignmentJobs, type AlignmentWorker } from "./alignment-jobs.ts";
import type { LocalMediaService } from "./local-media.ts";
import type { ProjectLibrary } from "./project-library.ts";

type Options = Parameters<typeof openAlignmentJobs>[0] & {
  library: ProjectLibrary;
  media: LocalMediaService;
  worker: AlignmentWorker;
};
export class AlignmentServiceError extends Error {
  readonly code:
    | "busy"
    | "project_not_found"
    | "project_read_only"
    | "stale_revision"
    | "capability_unavailable";
  constructor(code: AlignmentServiceError["code"], message: string) {
    super(message);
    this.code = code;
  }
}
export async function openAlignmentService(options: Options) {
  const jobs = await openAlignmentJobs(options);
  const running = new Map<string, Promise<void>>();
  const pending = new Set<string>();
  let closed = false;
  let suspended = false;
  function launch(jobId: string) {
    if (running.has(jobId) || pending.has(jobId)) return;
    pending.add(jobId);
    pump();
  }
  function pump() {
    if (closed || suspended || running.size > 0) return;
    const jobId = pending.values().next().value;
    if (!jobId) return;
    pending.delete(jobId);
    const task = jobs
      .run(jobId, options)
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        running.delete(jobId);
        pump();
      });
    running.set(jobId, task);
  }
  async function status(projectId: string) {
    return {
      projectId,
      jobs: (await jobs.list(projectId)).map((job) =>
        AlignmentJobSummarySchema.parse({
          id: job.id,
          projectId: job.recipe.projectId,
          lyricsDocumentId: job.recipe.lyricsDocumentId,
          analysisRevisionId: job.recipe.analysisRevisionId,
          state: job.state,
          blockedReasons: job.blockedReasons,
          ...(job.alignmentId ? { alignmentId: job.alignmentId } : {}),
          ...(job.stage ? { stage: job.stage } : {}),
          cleanupPending: job.state !== "running" && running.has(job.id),
          ...(job.failure ? { failure: job.failure } : {}),
          circuitOpen: job.circuitOpen,
          elapsedMs:
            job.startedAt === undefined
              ? 0
              : Math.max(0, (job.finishedAt ?? Date.now()) - job.startedAt),
        }),
      ),
    };
  }
  return {
    async perform(raw: AlignmentAction) {
      if (suspended)
        throw new AlignmentServiceError("busy", "Alignment is interrupted by system sleep");
      if (closed)
        throw new AlignmentServiceError("capability_unavailable", "Alignment service is closed");
      const action = AlignmentActionSchema.parse(raw);
      const snapshot = await options.library.getSnapshot(action.projectId);
      if (!snapshot)
        throw new AlignmentServiceError("project_not_found", "Alignment Project is unavailable");
      if (action.type === "start") {
        if (snapshot.projectRevisionId !== action.expectedProjectRevisionId)
          throw new AlignmentServiceError(
            "stale_revision",
            "Project changed before Alignment was requested",
          );
        if ((await options.library.readProject(action.projectId)).compatibility === "read_only")
          throw new AlignmentServiceError("project_read_only", "Project is read-only");
        const active = snapshot.project.activeView;
        const document = snapshot.project.lyricsDocuments.find(
          (item) => item.id === active?.lyricsDocumentId,
        );
        if (!active || !document)
          throw new AlignmentServiceError(
            "capability_unavailable",
            "Select Reference Lyrics and an Analysis Revision first",
          );
        const source = await options.media.getAnalysisSource(action.projectId);
        let job = await jobs.request({
          project: snapshot.project,
          lyricsDocumentId: document.id,
          analysisRevisionId: active.analysisRevisionId,
          canonicalAudioFingerprint: source.canonicalAudioFingerprint,
        });
        if (
          !running.has(job.id) &&
          !pending.has(job.id) &&
          job.state !== "succeeded" &&
          job.state !== "running"
        ) {
          job = await jobs.confirm(job.id);
          if (job.state === "queued") launch(job.id);
        }
      } else if (action.type === "select") {
        const result = await options.library.selectLyricsAlignment(action);
        if ("stale" in result)
          throw new AlignmentServiceError(
            "stale_revision",
            "Project changed before Alignment selection",
          );
        if ("readOnly" in result)
          throw new AlignmentServiceError("project_read_only", "Project is read-only");
        if ("notFound" in result)
          throw new AlignmentServiceError("project_not_found", "Alignment Project is unavailable");
      } else if (action.type === "cancel" || action.type === "retry") {
        const job = await jobs.get(action.jobId);
        if (!job || job.recipe.projectId !== action.projectId)
          throw new AlignmentServiceError(
            "capability_unavailable",
            "Alignment Job does not belong to this Project",
          );
        if (action.type === "cancel") {
          pending.delete(job.id);
          await jobs.cancel(job.id);
        } else {
          if (running.has(job.id) || pending.has(job.id))
            throw new AlignmentServiceError("busy", "Alignment Job is already scheduled");
          const queued = await jobs.confirm(job.id);
          if (queued.state === "queued") launch(job.id);
        }
      }
      return status(action.projectId);
    },
    async dispose() {
      closed = true;
      pending.clear();
      try {
        await jobs.interrupt();
      } finally {
        await Promise.all(running.values());
      }
    },
    async setSuspended(value: boolean) {
      suspended = value;
      pending.clear();
      await jobs.interrupt();
    },
  };
}
export type AlignmentService = Awaited<ReturnType<typeof openAlignmentService>>;

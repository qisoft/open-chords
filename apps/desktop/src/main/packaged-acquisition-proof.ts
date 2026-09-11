import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { app } from "electron";

import {
  EXPECTED_ACQUISITION_MANIFEST_SHA256,
  EXPECTED_ACQUISITION_POLICY_SHA256,
} from "./acquisition-build-metadata.ts";
import { openAcquisitionJobs, type AcquisitionJobsOptions } from "./acquisition-jobs.ts";
import { ACQUISITION_PROOF_MEDIA, oversizedDurationFixture } from "./acquisition-proof-fixture.ts";
import { openContainedAcquisitionAttempt } from "./acquisition-runtime.ts";
import { EXPECTED_CONTAINMENT_MANIFEST_SHA256 } from "./containment-build-metadata.ts";
import { openNetworkMode } from "./network-mode.ts";
import { proveInitializationCleanupRecovery } from "./packaged-acquisition-fault-proof.ts";
import { canonicalWavFixture } from "./packaged-sidecar-proof.ts";
import { ProjectOwnedRecordsSchema } from "./project-library-records.ts";
import { openProjectLibrary } from "./project-library.ts";
import { EXPECTED_SIDECAR_MANIFEST_SHA256 } from "./sidecar-build-metadata.ts";

export async function runPackagedAcquisitionProof() {
  const mac = process.platform === "darwin";
  const runtimeOptions = {
    runtimeRoot: mac
      ? join(
          process.resourcesPath,
          "../XPCServices/OpenChordsAnalysisService.xpc/Contents/Resources/open-chords-acquisition",
        )
      : join(process.resourcesPath, "open-chords-acquisition"),
    runtimeManifestHash: EXPECTED_ACQUISITION_MANIFEST_SHA256,
    containmentRoot: mac
      ? join(process.resourcesPath, "../MacOS/containment")
      : join(process.resourcesPath, "containment"),
    containmentManifestHash: EXPECTED_CONTAINMENT_MANIFEST_SHA256,
    ...(mac
      ? { bridgePath: join(process.resourcesPath, "../MacOS/open-chords-containment-bridge") }
      : {}),
  };
  const attempt = await openContainedAcquisitionAttempt(runtimeOptions);
  const media = Buffer.alloc(50_000, 42);
  let result;
  try {
    result = await attempt.run({
      videoId: "aqz-KE-bpKQ",
      proof: true,
      network: {
        resolve: async () => ({ aliases: [], addresses: ["142.250.74.206"] }),
        request: async ({ url }) =>
          url.pathname === "/watch"
            ? new Response(
                JSON.stringify({
                  url: "https://rr1---sn-abcd.googlevideo.com/videoplayback?id=abc123&itag=140&source=youtube&mime=audio%2Fmp4",
                }),
              )
            : new Response(media, {
                headers: { "content-type": "audio/mp4", "content-length": String(media.length) },
              }),
      },
    });
    const artifact = await readFile(join(attempt.workspace, "media.bin"));
    if (
      !artifact.equals(media) ||
      result.artifact.sha256 !== createHash("sha256").update(media).digest("hex") ||
      !result.containment
    )
      throw new Error("acquisition_proof_failed");
  } finally {
    attempt.cleanup();
  }
  const removed = await lstat(attempt.workspace).then(
    () => false,
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT",
  );
  if (!removed) throw new Error("acquisition_proof_cleanup_failed");
  process.stderr.write("Acquisition proof stage: extractor_reaped\n");

  const stateRoot = app.getPath("userData");
  const library = await openProjectLibrary({ stateRoot });
  const network = await openNetworkMode(stateRoot);
  const player = {
    playabilityStatus: { status: "OK" },
    videoDetails: {
      videoId: "aqz-KE-bpKQ",
      title: "Synthetic progressive fixture",
      lengthSeconds: "1",
      isLiveContent: false,
    },
    streamingData: {
      formats: [
        {
          itag: 18,
          url: "https://rr1---sn-abcd.googlevideo.com/videoplayback?id=abc123&itag=18&source=youtube&mime=video%2Fmp4",
          mimeType: 'video/mp4; codecs="avc1.42001E, mp4a.40.2"',
          contentLength: String(ACQUISITION_PROOF_MEDIA.length),
          bitrate: 100000,
          width: 16,
          height: 16,
          quality: "small",
          audioQuality: "AUDIO_QUALITY_LOW",
          approxDurationMs: "100",
        },
      ],
    },
  };
  let botCheck = false;
  let mismatchedMedia = false;
  let oversizedDuration = false;
  let stallMedia = false;
  let mediaRequested: () => void = () => undefined;
  let streamCancelled = false;
  const jobOptions: AcquisitionJobsOptions = {
    stateRoot,
    library,
    network,
    runtime: runtimeOptions,
    validation: {
      ...runtimeOptions,
      runtimeRoot: mac
        ? join(
            process.resourcesPath,
            "../XPCServices/OpenChordsAnalysisService.xpc/Contents/Resources/open-chords-analysis",
          )
        : join(process.resourcesPath, "open-chords-analysis"),
      runtimeManifestHash: EXPECTED_SIDECAR_MANIFEST_SHA256,
    },
    policyHash: EXPECTED_ACQUISITION_POLICY_SHA256,
    networkTransport: {
      resolve: async () => ({ aliases: [], addresses: ["142.250.74.206"] }),
      request: async ({ url }) => {
        const responseMedia = mismatchedMedia
          ? canonicalWavFixture()
          : oversizedDuration
            ? oversizedDurationFixture()
            : ACQUISITION_PROOF_MEDIA;
        const currentPlayer = botCheck
          ? {
              playabilityStatus: {
                status: "LOGIN_REQUIRED",
                reason: "Sign in to confirm you're not a bot. private-provider-token",
              },
              videoDetails: {
                videoId: "aqz-KE-bpKQ",
                title: "Private fixture title",
                lengthSeconds: "1",
              },
            }
          : player;
        if (url.pathname === "/watch")
          return new Response(`var ytInitialPlayerResponse = ${JSON.stringify(currentPlayer)};`, {
            headers: { "content-type": "text/html" },
          });
        if (url.pathname === "/youtubei/v1/player")
          return new Response(JSON.stringify(currentPlayer), {
            headers: { "content-type": "application/json" },
          });
        if (url.pathname === "/videoplayback" && stallMedia)
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(ACQUISITION_PROOF_MEDIA.subarray(0, 1024));
              },
              pull() {
                mediaRequested();
                return new Promise<void>(() => undefined);
              },
              cancel() {
                streamCancelled = true;
              },
            }),
            {
              headers: {
                "content-type": "video/mp4",
                "content-length": String(ACQUISITION_PROOF_MEDIA.length),
              },
            },
          );
        if (url.pathname === "/videoplayback")
          return new Response(new Uint8Array(responseMedia), {
            headers: {
              "content-type": "video/mp4",
              "content-length": String(responseMedia.length),
            },
          });
        return new Response("var placeholder = 1;", {
          headers: { "content-type": "text/javascript" },
        });
      },
    },
  };
  const jobs = await openAcquisitionJobs(jobOptions);
  process.stderr.write("Acquisition proof stage: jobs_ready\n");
  let job;
  let botCheckNoSnapshot = false;
  let offlineCancellationClean = false;
  let mismatchedMediaNoSnapshot = false;
  let oversizedDurationNoSnapshot = false;
  try {
    const started = await jobs.start({ url: "https://youtu.be/aqz-KE-bpKQ" });
    process.stderr.write(`Acquisition proof Job: ${started.state}\n`);
    job = await jobs.wait(started.id);
    process.stderr.write(`Acquisition proof Job: ${job.state}:${job.reason ?? "none"}\n`);
    if (job.state !== "succeeded") throw new Error("acquisition_proof_failed");
    const before = JSON.stringify(await library.listYouTubeSources());
    botCheck = true;
    const rejected = await jobs.wait(
      (await jobs.start({ url: "https://youtu.be/aqz-KE-bpKQ" })).id,
    );
    botCheckNoSnapshot =
      rejected.state === "failed" &&
      rejected.reason === "bot_check" &&
      JSON.stringify(await library.listYouTubeSources()) === before &&
      !JSON.stringify(jobs.list()).includes("private-provider-token") &&
      !JSON.stringify(jobs.list()).includes("Private fixture title") &&
      (await readdir(join(stateRoot, "acquisition-jobs/workspaces"))).length === 0;
    botCheck = false;
    mismatchedMedia = true;
    const invalidMedia = await jobs.wait(
      (await jobs.start({ url: "https://youtu.be/aqz-KE-bpKQ" })).id,
    );
    mismatchedMediaNoSnapshot =
      invalidMedia.state === "failed" &&
      invalidMedia.reason === "invalid_output" &&
      JSON.stringify(await library.listYouTubeSources()) === before &&
      (await readdir(join(stateRoot, "acquisition-jobs/workspaces"))).length === 0;
    mismatchedMedia = false;
    oversizedDuration = true;
    const overlong = await jobs.wait(
      (await jobs.start({ url: "https://youtu.be/aqz-KE-bpKQ" })).id,
    );
    oversizedDurationNoSnapshot =
      overlong.state === "failed" &&
      overlong.reason === "invalid_output" &&
      JSON.stringify(await library.listYouTubeSources()) === before &&
      (await readdir(join(stateRoot, "acquisition-jobs/workspaces"))).length === 0;
    oversizedDuration = false;
    stallMedia = true;
    const requested = new Promise<void>((resolveRequest) => {
      mediaRequested = resolveRequest;
    });
    const interrupted = await jobs.start({ url: "https://youtu.be/aqz-KE-bpKQ" });
    await Promise.race([
      requested,
      jobs.wait(interrupted.id).then(() => {
        throw new Error("acquisition_proof_failed");
      }),
    ]);
    await network.setOffline(true);
    const cancelled = await jobs.wait(interrupted.id);
    const blocked = await jobs.start({ url: "https://youtu.be/aqz-KE-bpKQ" });
    offlineCancellationClean =
      cancelled.state === "cancelled" &&
      streamCancelled &&
      blocked.state === "blocked" &&
      blocked.reason === "offline" &&
      blocked.attempts.length === 0 &&
      JSON.stringify(await library.listYouTubeSources()) === before &&
      (await readdir(join(stateRoot, "acquisition-jobs/workspaces"))).length === 0;
  } finally {
    await jobs.close();
  }
  if (job.state !== "succeeded") throw new Error(`acquisition_job_${job.reason ?? "incomplete"}`);
  const snapshotPublished = (await library.listYouTubeSources()).some((source) =>
    source.snapshots.some((snapshot) => snapshot.id === job.snapshotId),
  );
  const reopened = await openProjectLibrary({ stateRoot });
  const acquiredSource = (await reopened.listYouTubeSources()).find((source) =>
    source.snapshots.some((snapshot) => snapshot.id === job.snapshotId),
  );
  const snapshotProjectCompatible =
    acquiredSource !== undefined &&
    ProjectOwnedRecordsSchema.safeParse({
      analysisManifests: [],
      exportReceipts: [],
      extensions: {},
      legacyManifestlessAnalysisRevisionIds: [],
      projectRange: {
        sourceId: acquiredSource.id,
        startSourceSample: 0,
        endSourceSample: acquiredSource.snapshots[0]!.durationSamples,
      },
      sources: [acquiredSource],
    }).success;
  const snapshotReopened = (await reopened.listYouTubeSources()).some((source) =>
    source.snapshots.some((snapshot) => snapshot.id === job.snapshotId),
  );
  await network.setOffline(false);
  const initializationCleanupRecoverable = await proveInitializationCleanupRecovery(jobOptions);
  process.stdout.write(
    JSON.stringify({
      proof: "brokered-extractor",
      ...result.containment,
      mediaBytes: media.length,
      requests: result.counters.requests,
      activeStreams: result.counters.activeStreams,
      workspaceRemoved: removed,
      snapshotPublished,
      snapshotReopened,
      snapshotProjectCompatible,
      jobState: job.state,
      botCheckNoSnapshot,
      offlineCancellationClean,
      mismatchedMediaNoSnapshot,
      oversizedDurationNoSnapshot,
      initializationCleanupRecoverable,
      temporaryMediaRemoved:
        (await readdir(join(library.activeRoot, "source-snapshots", job.snapshotId!))).join() ===
        "snapshot.json",
    }) + "\n",
  );
}

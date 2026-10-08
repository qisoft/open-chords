import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { canonicalSerialize } from "@open-chords/domain";

import {
  openAcquisitionJobs,
  type AcquisitionJob,
  type AcquisitionJobsOptions,
} from "./acquisition-jobs.ts";
import { readBoundedFile } from "./bounded-file.ts";
import { proofTreeHashes } from "./packaged-proof-tree.ts";
import { openProjectLibrary } from "./project-library.ts";

// Reopen production history after contained failures; no new worker or network request is needed.
export async function proveAcquisitionFailureHistoryReopen(
  options: AcquisitionJobsOptions,
  expected: AcquisitionJob[],
  libraryBaseline: string,
) {
  if (
    !options.library ||
    expected.length === 0 ||
    expected.some(
      (job) =>
        job.state === "running" || job.state === "succeeded" || job.snapshotId || job.sourceId,
    )
  )
    throw new Error("acquisition_history_proof_fixture_invalid");
  const jobs = await openAcquisitionJobs(options);
  try {
    for (const job of expected) {
      if (
        canonicalSerialize(jobs.list().find((candidate) => candidate.id === job.id)) !==
        canonicalSerialize(job)
      )
        throw new Error("acquisition_history_proof_not_durable");
    }
    const history = (
      await readBoundedFile(join(options.stateRoot, "acquisition-jobs", "state.json"), 1024 * 1024)
    ).toString("utf8");
    for (const privateValue of [
      "https:",
      "private-provider-token",
      "Private fixture title",
      "offline-private-token",
      "private-playlist",
      options.stateRoot,
      JSON.stringify(options.stateRoot).slice(1, -1),
    ]) {
      if (history.includes(privateValue)) throw new Error("acquisition_history_proof_not_redacted");
    }
    const library = await openProjectLibrary({ stateRoot: options.stateRoot });
    if (
      canonicalSerialize(await proofTreeHashes(library.activeRoot)) !== libraryBaseline ||
      (await readdir(join(options.stateRoot, "acquisition-jobs", "workspaces"))).length !== 0
    )
      throw new Error("acquisition_history_proof_boundary_changed");
  } finally {
    await jobs.close();
  }
  return {
    failureHistoryReopened: expected.length,
    failureHistoryRedacted: true,
    failureLibraryUnchanged: true,
  };
}

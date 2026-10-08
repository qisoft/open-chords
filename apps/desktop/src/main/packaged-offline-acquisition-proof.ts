import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { canonicalSerialize } from "@open-chords/domain";

import { openAcquisitionJobs, type AcquisitionJobsOptions } from "./acquisition-jobs.ts";
import { openNetworkMode } from "./network-mode.ts";
import { proofTreeHashes } from "./packaged-proof-tree.ts";
import { openProjectLibrary } from "./project-library.ts";

// Count calls at the production broker's injected DNS/HTTP boundary, including
// across a cold service reopen. This does not claim live-provider availability.
export async function proveOfflineAcquisitionReopen(options: AcquisitionJobsOptions) {
  if (!options.library) throw new Error("offline_proof_library_missing");
  await options.network.setOffline(true);
  const network = await openNetworkMode(options.stateRoot);
  if (!network.offline) throw new Error("offline_proof_settings_not_durable");
  const baseline = canonicalSerialize(await proofTreeHashes(options.library.activeRoot));
  let dnsCalls = 0;
  let httpCalls = 0;
  const jobs = await openAcquisitionJobs({
    ...options,
    network,
    networkTransport: {
      resolve: async () => {
        dnsCalls++;
        throw new Error("offline_proof_dns_called");
      },
      request: async () => {
        httpCalls++;
        throw new Error("offline_proof_http_called");
      },
    },
  });
  let blocked;
  try {
    blocked = await jobs.start({
      url: "https://www.youtube.com/watch?v=aqz-KE-bpKQ&token=offline-private-token&list=private-playlist",
    });
    if (blocked.state !== "blocked" || blocked.reason !== "offline" || blocked.attempts.length)
      throw new Error("offline_proof_not_blocked");
  } finally {
    await jobs.close();
  }
  const reopened = await openAcquisitionJobs({ ...options, network });
  try {
    if (
      canonicalSerialize(reopened.list().find((job) => job.id === blocked.id)) !==
      canonicalSerialize(blocked)
    )
      throw new Error("offline_proof_job_not_durable");
    const history = await readFile(
      join(options.stateRoot, "acquisition-jobs", "state.json"),
      "utf8",
    );
    for (const privateValue of [
      "https:",
      "offline-private-token",
      "private-playlist",
      options.stateRoot,
    ]) {
      if (history.includes(privateValue)) throw new Error("offline_proof_history_not_redacted");
    }
    const library = await openProjectLibrary({ stateRoot: options.stateRoot });
    if (
      dnsCalls !== 0 ||
      httpCalls !== 0 ||
      canonicalSerialize(await proofTreeHashes(library.activeRoot)) !== baseline
    )
      throw new Error("offline_proof_boundary_changed");
  } finally {
    await reopened.close();
  }
  return {
    offlineReopenDnsCalls: dnsCalls,
    offlineReopenHttpCalls: httpCalls,
    offlineReopenLibraryUnchanged: true,
    offlineHistoryRedacted: true,
  };
}

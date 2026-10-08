import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ProjectEnvelopeSchema } from "@open-chords/contracts";
import { canonicalSerialize } from "@open-chords/domain";
import { expect, it } from "vitest";

import { openAcquisitionJobs } from "../apps/desktop/src/main/acquisition-jobs.ts";
import { openNetworkMode } from "../apps/desktop/src/main/network-mode.ts";
import { proveAcquisitionFailureHistoryReopen } from "../apps/desktop/src/main/packaged-acquisition-history-proof.ts";
import { proveOfflineAcquisitionReopen } from "../apps/desktop/src/main/packaged-offline-acquisition-proof.ts";
import { proofTreeHashes } from "../apps/desktop/src/main/packaged-proof-tree.ts";
import { openProjectLibrary } from "../apps/desktop/src/main/project-library.ts";
import { goldenRecords } from "./support/editor-fixture.ts";

it("cold-opens Offline Mode, persists redacted blocked history and preserves a populated Library", async () => {
  const stateRoot = await realpath(await mkdtemp(join(tmpdir(), "oc-offline-proof-")));
  try {
    const library = await openProjectLibrary({ stateRoot });
    const envelope = ProjectEnvelopeSchema.parse(
      JSON.parse(
        await readFile("packages/testkit/contracts/v1/valid/project-envelope.json", "utf8"),
      ),
    );
    await library.createProject({ envelope, records: goldenRecords() });
    const before = await library.getSnapshot(envelope.payload.id);
    const network = await openNetworkMode(stateRoot);
    expect(network.offline).toBe(false);
    expect(await proveOfflineAcquisitionReopen({ stateRoot, library, network })).toEqual({
      offlineReopenDnsCalls: 0,
      offlineReopenHttpCalls: 0,
      offlineReopenLibraryUnchanged: true,
      offlineHistoryRedacted: true,
    });
    expect((await openNetworkMode(stateRoot)).offline).toBe(true);
    expect(await library.getSnapshot(envelope.payload.id)).toEqual(before);
    const baseline = canonicalSerialize(await proofTreeHashes(library.activeRoot));
    const options = { stateRoot, library, network };
    const jobs = await openAcquisitionJobs(options);
    let blocked;
    try {
      blocked = await jobs.start({
        url: "https://youtu.be/aqz-KE-bpKQ?token=offline-private-token",
      });
    } finally {
      await jobs.close();
    }
    expect(await proveAcquisitionFailureHistoryReopen(options, [blocked], baseline)).toEqual({
      failureHistoryReopened: 1,
      failureHistoryRedacted: true,
      failureLibraryUnchanged: true,
    });
    await expect(
      proveAcquisitionFailureHistoryReopen(options, [blocked], "different baseline"),
    ).rejects.toThrow("acquisition_history_proof_boundary_changed");
    await expect(
      proveAcquisitionFailureHistoryReopen(
        options,
        [{ ...blocked, updatedAt: "2020-01-01T00:00:00.000Z" }],
        baseline,
      ),
    ).rejects.toThrow("acquisition_history_proof_not_durable");
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

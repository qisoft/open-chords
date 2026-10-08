import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { canonicalSerialize } from "@open-chords/domain";

import { proofTreeHashes } from "./packaged-proof-tree.ts";
import { openProjectExports, type ProjectExports } from "./project-exports.ts";
import type { ProjectLibrary } from "./project-library.ts";

// Synthetic fixed targets exercise production refusal/cancellation boundaries.
// They do not simulate disk exhaustion or native Save dialog interaction.
export async function runPackagedExportFailureProof(options: {
  library: ProjectLibrary;
  stateRoot: string;
  outputRoot: string;
  initialRevisionId: string;
}) {
  const { library, stateRoot, outputRoot, initialRevisionId } = options;
  const projectId = "project_golden";
  const snapshot = await library.getSnapshot(projectId);
  if (!snapshot) throw new Error("export_failure_proof_project_missing");
  await mkdir(join(outputRoot, "directory.json"));
  const baseline = canonicalSerialize(await proofTreeHashes(stateRoot));
  const targets = canonicalSerialize(await proofTreeHashes(outputRoot));
  const unchanged = async (service: ProjectExports) => {
    if (
      service.busy ||
      service.pendingRecovery !== 0 ||
      library.listExportReceipts(projectId).length !== 5 ||
      (await library.getSnapshot(projectId))?.projectRevisionId !== snapshot.projectRevisionId ||
      canonicalSerialize(await proofTreeHashes(stateRoot)) !== baseline ||
      canonicalSerialize(await proofTreeHashes(outputRoot)) !== targets
    )
      throw new Error("export_failure_proof_state_changed");
  };
  const cases = [
    {
      name: "stale_revision",
      target: join(outputRoot, "score.json"),
      revision: initialRevisionId,
      message: "Export requires the current writable Project revision",
      calls: 0,
    },
    {
      name: "protected_target",
      target: join(stateRoot, "protected.json"),
      message: "Protected export target",
      calls: 1,
    },
    {
      name: "directory_target",
      target: join(outputRoot, "directory.json"),
      message: "Export target is not a regular independent file",
      calls: 1,
    },
    {
      name: "missing_parent",
      target: join(outputRoot, "missing-parent", "score.json"),
      code: "ENOENT",
      calls: 1,
    },
  ];
  for (const failure of cases) {
    let calls = 0;
    const service = await openProjectExports({
      library,
      stateRoot,
      pickTarget: async () => {
        calls++;
        return failure.target;
      },
    });
    let rejected = false;
    try {
      await service.saveJson({
        projectId,
        expectedProjectRevisionId: failure.revision ?? snapshot.projectRevisionId,
        presentation: "current",
      });
    } catch (error) {
      rejected =
        error instanceof Error &&
        (failure.code
          ? "code" in error && error.code === failure.code
          : error.message === failure.message);
    }
    if (!rejected || calls !== failure.calls)
      throw new Error("export_failure_proof_refusal_failed");
    await unchanged(service);
    process.stderr.write(`Export proof stage: rejected_${failure.name}\n`);
  }
  const cancelling = await openProjectExports({
    library,
    stateRoot,
    pickTarget: async () => {
      cancelling.cancel();
      return join(outputRoot, "score.json");
    },
  });
  const cancelled = await cancelling.saveJson({
    projectId,
    expectedProjectRevisionId: snapshot.projectRevisionId,
    presentation: "current",
  });
  if (cancelled.state !== "cancelled") throw new Error("export_failure_proof_cancellation_failed");
  await unchanged(cancelling);
  process.stderr.write("Export proof stage: cancelled_existing_target_unchanged\n");
  return { rejectedUnchanged: cases.length, cancelledTargetUnchanged: true };
}

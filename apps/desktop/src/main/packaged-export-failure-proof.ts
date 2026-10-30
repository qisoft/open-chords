import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { canonicalSerialize } from "@open-chords/domain";

import { proofTreeDifference } from "./packaged-proof-tree-difference.ts";
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
  const baselineTree = await proofTreeHashes(stateRoot);
  const baseline = canonicalSerialize(baselineTree);
  const targets = canonicalSerialize(await proofTreeHashes(outputRoot));
  const probe = (caseName: string, stage: string) =>
    process.stderr.write(`Export refusal probe: case=${caseName} stage=${stage}\n`);
  const unchanged = async (service: ProjectExports, caseName: string) => {
    const changed = () => {
      throw new Error("export_failure_proof_state_changed");
    };
    probe(caseName, "check_service");
    if (
      service.busy ||
      service.pendingRecovery !== 0 ||
      library.listExportReceipts(projectId).length !== 5
    )
      changed();
    probe(caseName, "check_snapshot");
    if ((await library.getSnapshot(projectId))?.projectRevisionId !== snapshot.projectRevisionId)
      changed();
    probe(caseName, "check_library_tree");
    const actualTree = await proofTreeHashes(stateRoot);
    if (canonicalSerialize(actualTree) !== baseline) {
      process.stderr.write(`${proofTreeDifference(baselineTree, actualTree, "refusal")}\n`);
      changed();
    }
    probe(caseName, "check_output_tree");
    if (canonicalSerialize(await proofTreeHashes(outputRoot)) !== targets) changed();
    probe(caseName, "unchanged");
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
    probe(failure.name, "service_open");
    const service = await openProjectExports({
      library,
      stateRoot,
      pickTarget: async () => {
        calls++;
        return failure.target;
      },
    });
    probe(failure.name, "service_ready");
    let rejected = false;
    probe(failure.name, "save_started");
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
    probe(failure.name, "save_returned");
    if (!rejected || calls !== failure.calls)
      throw new Error("export_failure_proof_refusal_failed");
    await unchanged(service, failure.name);
    process.stderr.write(`Export proof stage: rejected_${failure.name}\n`);
  }
  probe("cancel_existing", "service_open");
  const cancelling = await openProjectExports({
    library,
    stateRoot,
    pickTarget: async () => {
      cancelling.cancel();
      return join(outputRoot, "score.json");
    },
  });
  probe("cancel_existing", "service_ready");
  probe("cancel_existing", "save_started");
  const cancelled = await cancelling.saveJson({
    projectId,
    expectedProjectRevisionId: snapshot.projectRevisionId,
    presentation: "current",
  });
  probe("cancel_existing", "save_returned");
  if (cancelled.state !== "cancelled") throw new Error("export_failure_proof_cancellation_failed");
  await unchanged(cancelling, "cancel_existing");
  process.stderr.write("Export proof stage: cancelled_existing_target_unchanged\n");
  return { rejectedUnchanged: cases.length, cancelledTargetUnchanged: true };
}

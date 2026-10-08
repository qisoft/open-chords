import { createHash } from "node:crypto";
import fs from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { basename, dirname, join } from "node:path";

import { canonicalSerialize, captureJsonExport, serializeJsonExport } from "@open-chords/domain";

import { proofTreeHashes } from "./packaged-proof-tree.ts";
import { openProjectExports } from "./project-exports.ts";
import { openProjectLibrary, type ProjectLibrary } from "./project-library.ts";

// Inject ENOSPC at the filesystem boundary of the installed production service.
// This proves error handling, not actual volume exhaustion or native Save selection.
export async function runPackagedExportDiskProof(source: ProjectLibrary, stateRoot: string) {
  const started = performance.now();
  const stage = (name: string) =>
    process.stderr.write(
      `Export disk proof stage: ${name} duration_ms=${Math.round(performance.now() - started)}\n`,
    );
  try {
    return await runDiskProof(source, stateRoot, stage);
  } catch (error) {
    const known = new Set([
      "export_disk_proof_fixture_invalid",
      "export_disk_proof_content_invalid",
      "export_disk_proof_preservation_failed",
      "export_disk_proof_retry_failed",
      "export_disk_proof_retry_not_durable",
      "export_disk_proof_retry_not_recovered",
    ]);
    const osCodes = new Set(["ENOSPC", "ENOENT", "EACCES", "EPERM", "EIO", "EBUSY"]);
    const code =
      error instanceof Error && known.has(error.message)
        ? error.message
        : error instanceof Error &&
            "code" in error &&
            typeof error.code === "string" &&
            osCodes.has(error.code)
          ? error.code
          : "unknown";
    process.stderr.write(
      `Export disk proof failure: code=${code} duration_ms=${Math.round(performance.now() - started)}\n`,
    );
    throw error;
  }
}

async function runDiskProof(
  source: ProjectLibrary,
  stateRoot: string,
  stage: (name: string) => void,
) {
  stage("started");
  const projectId = "project_golden";
  const sourceBaseline = canonicalSerialize(await proofTreeHashes(stateRoot));
  const fixture = await source.readProject(projectId);
  const root = join(dirname(stateRoot), "packaged-export-disk-state");
  const output = join(dirname(stateRoot), "packaged-export-disk-output");
  const target = join(output, "existing.json");
  await mkdir(output);
  await writeFile(target, "existing external bytes\n");
  const library = await openProjectLibrary({ stateRoot: root });
  await library.createProject({
    envelope: fixture.envelope,
    records: { ...fixture.records, exportReceipts: [] },
  });
  await mkdir(join(root, "export-pending"));
  const baseline = canonicalSerialize(await proofTreeHashes(root));
  const targets = canonicalSerialize(await proofTreeHashes(output));
  const snapshot = await library.getSnapshot(projectId);
  if (!snapshot) throw new Error("export_disk_proof_fixture_invalid");
  const request = {
    projectId,
    expectedProjectRevisionId: snapshot.projectRevisionId,
    presentation: "current",
  };
  for (const phase of ["journal_write", "staging_write", "staging_sync"] as const) {
    const service = await openProjectExports({
      library,
      stateRoot: root,
      pickTarget: async () => target,
    });
    const originalOpen = fs.promises.open;
    let injected = false;
    let rejected = false;
    try {
      fs.promises.open = async (...args) => {
        const file = await originalOpen(...args);
        const path = String(args[0]);
        const selected =
          phase === "journal_write"
            ? dirname(path) === join(root, "export-pending") && path.endsWith(".json")
            : dirname(path) === output && /^\.export_[a-f0-9]{32}\.tmp$/.test(basename(path));
        if (selected && args[1] === "wx") {
          const fail = () => {
            injected = true;
            throw Object.assign(new Error("fixture_disk_full"), { code: "ENOSPC" });
          };
          if (phase === "staging_sync") file.sync = async () => fail();
          else {
            const write = file.writeFile.bind(file);
            file.writeFile = async (content) => {
              // Leave real partial bytes so cleanup assertions cannot pass vacuously.
              if (typeof content !== "string" && !(content instanceof Uint8Array))
                throw new Error("export_disk_proof_content_invalid");
              const bytes =
                typeof content === "string" ? Buffer.from(content) : Buffer.from(content);
              await write(bytes.subarray(0, 16));
              fail();
            };
          }
        }
        return file;
      };
      syncBuiltinESMExports();
      await service.saveJson(request);
    } catch (error) {
      rejected = error instanceof Error && "code" in error && error.code === "ENOSPC";
    } finally {
      fs.promises.open = originalOpen;
      syncBuiltinESMExports();
    }
    const reopened = await openProjectLibrary({ stateRoot: root });
    const recovered = await openProjectExports({
      library: reopened,
      stateRoot: root,
      pickTarget: async () => target,
    });
    if (
      !injected ||
      !rejected ||
      service.busy ||
      service.pendingRecovery !== 0 ||
      recovered.busy ||
      recovered.pendingRecovery !== 0 ||
      reopened.listExportReceipts(projectId).length !== 0 ||
      (await reopened.getSnapshot(projectId))?.projectRevisionId !== snapshot.projectRevisionId ||
      canonicalSerialize(await proofTreeHashes(root)) !== baseline ||
      canonicalSerialize(await proofTreeHashes(output)) !== targets
    )
      throw new Error("export_disk_proof_preservation_failed");
    stage(`preserved_${phase}`);
  }
  stage("retry_service_opening");
  const retry = await openProjectExports({
    library,
    stateRoot: root,
    pickTarget: async () => {
      stage("retry_target_selected");
      return target;
    },
  });
  stage("retry_saving");
  if (
    (await retry.saveJson(request)).state !== "saved" ||
    retry.busy ||
    retry.pendingRecovery !== 0
  )
    throw new Error("export_disk_proof_retry_failed");
  stage("retry_saved");
  const reopened = await openProjectLibrary({ stateRoot: root });
  stage("retry_library_reopened");
  const receipts = reopened.listExportReceipts(projectId);
  const bytes = await readFile(target);
  if (
    receipts.length !== 1 ||
    receipts[0]?.outputHash !== `sha256:${createHash("sha256").update(bytes).digest("hex")}` ||
    bytes.toString() !==
      serializeJsonExport(captureJsonExport(snapshot.project, { presentation: "current" })) ||
    (await reopened.getSnapshot(projectId))?.projectRevisionId === snapshot.projectRevisionId ||
    canonicalSerialize(await proofTreeHashes(stateRoot)) !== sourceBaseline
  )
    throw new Error("export_disk_proof_retry_not_durable");
  stage("retry_output_verified");
  const recovered = await openProjectExports({
    library: reopened,
    stateRoot: root,
    pickTarget: async () => target,
  });
  if (recovered.pendingRecovery !== 0 || recovered.busy)
    throw new Error("export_disk_proof_retry_not_recovered");
  stage("retry_recovery_verified");
  return { diskFailureRefusals: 3, diskFailureRetryDurable: true };
}

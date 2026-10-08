import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { canonicalSerialize, captureJsonExport, serializeJsonExport } from "@open-chords/domain";

import { proofTreeHashes } from "./packaged-proof-tree.ts";
import { openProjectExports } from "./project-exports.ts";
import { ExportReceiptSchema } from "./project-library-records.ts";
import { openProjectLibrary, type ProjectLibrary } from "./project-library.ts";

// Interrupt the production Library commit after publication, before the Receipt Head is replaced.
// This is an injected durable-write failure, not a process crash or physical disk exhaustion.
export async function runPackagedExportRecoveryProof(source: ProjectLibrary, stateRoot: string) {
  const started = performance.now();
  const stage = (name: string) =>
    process.stderr.write(
      `Export recovery proof stage: ${name} duration_ms=${Math.round(performance.now() - started)}\n`,
    );
  stage("started");
  const projectId = "project_golden";
  const sourceBaseline = canonicalSerialize(await proofTreeHashes(stateRoot));
  const fixture = await source.readProject(projectId);
  const root = join(dirname(stateRoot), "packaged-export-recovery-state");
  const output = join(dirname(stateRoot), "packaged-export-recovery-output");
  const target = join(output, "existing.json");
  await mkdir(output);
  await writeFile(target, "existing external bytes\n");
  let armed = false;
  let interruptions = 0;
  const library = await openProjectLibrary({
    stateRoot: root,
    faultInjector: (point) => {
      if (armed && point === "before_head_replace") {
        interruptions++;
        throw Object.assign(new Error("fixture_receipt_write_failure"), { code: "EIO" });
      }
    },
  });
  await library.createProject({
    envelope: fixture.envelope,
    records: { ...fixture.records, exportReceipts: [] },
  });
  const snapshot = await library.getSnapshot(projectId);
  if (!snapshot) throw new Error("export_recovery_proof_fixture_invalid");
  const service = await openProjectExports({
    library,
    stateRoot: root,
    pickTarget: async () => target,
  });
  armed = true;
  const result = await service.saveJson({
    projectId,
    expectedProjectRevisionId: snapshot.projectRevisionId,
    presentation: "current",
  });
  armed = false;
  const bytes = await readFile(target);
  const journalRoot = join(root, "export-pending");
  const names = await readdir(journalRoot);
  if (names.length !== 1 || !/^export_[a-f0-9]{32}\.json$/.test(names[0]!))
    throw new Error("export_recovery_proof_journal_invalid");
  const journal = JSON.parse(await readFile(join(journalRoot, names[0]!), "utf8"));
  const receipt = ExportReceiptSchema.parse(journal.receipt);
  if (
    result.state !== "receipt_pending" ||
    interruptions !== 1 ||
    service.busy ||
    service.pendingRecovery !== 1 ||
    library.listExportReceipts(projectId).length !== 0 ||
    (await library.getSnapshot(projectId))?.projectRevisionId !== snapshot.projectRevisionId ||
    journal.projectId !== projectId ||
    journal.libraryRoot !== library.activeRoot ||
    names[0] !== `${receipt.id}.json` ||
    receipt.outputLocation !== target ||
    receipt.outputHash !== `sha256:${createHash("sha256").update(bytes).digest("hex")}` ||
    bytes.toString() !==
      serializeJsonExport(captureJsonExport(snapshot.project, { presentation: "current" }))
  )
    throw new Error("export_recovery_proof_publication_invalid");

  stage("published_pending");
  const reopened = await openProjectLibrary({ stateRoot: root });
  if (
    reopened.listExportReceipts(projectId).length !== 0 ||
    (await reopened.getSnapshot(projectId))?.projectRevisionId !== snapshot.projectRevisionId
  )
    throw new Error("export_recovery_proof_pending_not_durable");
  const recovered = await openProjectExports({
    library: reopened,
    stateRoot: root,
    pickTarget: async () => null,
  });
  const head = (await reopened.getSnapshot(projectId))?.projectRevisionId;
  if (
    !head ||
    head === snapshot.projectRevisionId ||
    recovered.busy ||
    recovered.pendingRecovery !== 0 ||
    canonicalSerialize(reopened.listExportReceipts(projectId)) !== canonicalSerialize([receipt]) ||
    (await readdir(journalRoot)).length !== 0 ||
    !(await readFile(target)).equals(bytes)
  )
    throw new Error("export_recovery_proof_receipt_not_recovered");
  stage("recovered");
  const baseline = canonicalSerialize(await proofTreeHashes(root));
  const targets = canonicalSerialize(await proofTreeHashes(output));
  // Replay the same durable intent, as if interruption occurred before journal removal.
  await writeFile(join(journalRoot, names[0]), canonicalSerialize(journal), { flag: "wx" });
  await recovered.recover();
  await recovered.recover();
  const durable = await openProjectLibrary({ stateRoot: root });
  const final = await openProjectExports({
    library: durable,
    stateRoot: root,
    pickTarget: async () => null,
  });
  if (
    final.busy ||
    final.pendingRecovery !== 0 ||
    (await durable.getSnapshot(projectId))?.projectRevisionId !== head ||
    canonicalSerialize(durable.listExportReceipts(projectId)) !== canonicalSerialize([receipt]) ||
    canonicalSerialize(await proofTreeHashes(root)) !== baseline ||
    canonicalSerialize(await proofTreeHashes(output)) !== targets ||
    canonicalSerialize(await proofTreeHashes(stateRoot)) !== sourceBaseline
  )
    throw new Error("export_recovery_proof_not_idempotent");
  stage("idempotent");
  return { publishedReceiptPending: true, recoveredReceiptDurable: true, recoveryIdempotent: true };
}

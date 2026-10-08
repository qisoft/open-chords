import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ProjectEnvelopeSchema } from "@open-chords/contracts";
import { expect, it } from "vitest";

import { runPackagedExportProof } from "../apps/desktop/src/main/packaged-export-proof.ts";
import { openProjectLibrary } from "../apps/desktop/src/main/project-library.ts";
import { goldenRecords } from "./support/editor-fixture.ts";
import { leadSheetProject } from "./support/export-fixture.ts";

it("exports the synthetic fixture through the production service with cancelled and durable outcomes", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "oc-export-proof-")));
  const stateRoot = join(root, "state");
  try {
    const envelope = ProjectEnvelopeSchema.parse(
      JSON.parse(
        await readFile("packages/testkit/contracts/v1/valid/project-envelope.json", "utf8"),
      ),
    );
    envelope.payload = leadSheetProject();
    const library = await openProjectLibrary({ stateRoot });
    await library.createProject({ envelope, records: goldenRecords() });
    expect(await runPackagedExportProof(stateRoot)).toEqual({
      proof: "installed-exports",
      cancelledWithoutRevision: true,
      durableReceipts: 5,
      rejectedUnchanged: 4,
      cancelledTargetUnchanged: true,
      diskFailureRefusals: 3,
      diskFailureRetryDurable: true,
      publishedReceiptPending: true,
      recoveryRefusalsUnchanged: 2,
      recoveredReceiptDurable: true,
      recoveryIdempotent: true,
    });
    expect(await readFile(join(root, "packaged-export-output/score.cho"), "utf8")).toBe(
      await readFile("tests/fixtures/chordpro-golden.cho", "utf8"),
    );
    expect(await readFile(join(root, "packaged-export-output/score.lrc"), "utf8")).toBe(
      "[ti:project_golden]\n[00:00.41]home go\n",
    );
    expect(
      createHash("sha256")
        .update(await readFile(join(root, "packaged-export-output/score.pdf")))
        .digest("hex"),
    ).toBe("3c834d61c9f05666fac4090bb5287fa676eaef34d94c463565c076f77a86cefa");
    await expect(runPackagedExportProof(stateRoot)).rejects.toThrow("export_proof_fixture_invalid");
    expect(
      (await openProjectLibrary({ stateRoot })).listExportReceipts("project_golden"),
    ).toHaveLength(5);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30000);

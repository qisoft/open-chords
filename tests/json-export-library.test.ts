import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ProjectEnvelopeSchema } from "@open-chords/contracts";
import { expect, it } from "vitest";

import { openProjectLibrary } from "../apps/desktop/src/main/project-library.ts";
import { goldenRecords } from "./support/editor-fixture.ts";

it("records an immutable Export Receipt without changing musical contents and reopens it", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "oc-json-receipt-"));
  try {
    const library = await openProjectLibrary({ stateRoot });
    const envelope = ProjectEnvelopeSchema.parse(
      JSON.parse(readFileSync("packages/testkit/contracts/v1/valid/project-envelope.json", "utf8")),
    );
    await library.createProject({ envelope, records: goldenRecords() });
    const before = await library.getSnapshot("project_golden");
    const receipt = {
      id: "export_receipt_test",
      activeViewHash: `sha256:${"a".repeat(64)}`,
      createdAt: "2026-09-09T12:00:00Z",
      format: "open_chords_json" as const,
      omissions: [],
      outputHash: `sha256:${"b".repeat(64)}`,
      outputLocation: join(stateRoot, "outside.json"),
      profileVersion: "open_chords_json/1.0/current",
    };
    await library.recordExportReceipt("project_golden", receipt);
    await library.recordExportReceipt("project_golden", receipt);
    expect((await library.getSnapshot("project_golden"))!.project).toEqual(before!.project);
    const reopened = await openProjectLibrary({ stateRoot });
    expect(reopened.listExportReceipts("project_golden")).toEqual([receipt]);
    await expect(
      reopened.recordExportReceipt("project_golden", {
        ...receipt,
        outputHash: `sha256:${"c".repeat(64)}`,
      }),
    ).rejects.toThrow(Error);
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

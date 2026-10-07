import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ProjectEnvelopeSchema } from "@open-chords/contracts";
import { expect, it } from "vitest";

import { openProjectLibrary } from "../apps/desktop/src/main/project-library.ts";
import { goldenRecords } from "./support/editor-fixture.ts";
import { loadExportFixtureService } from "./support/export-service-loader.ts";
import { inspectPdf } from "./support/pdf-inspection.ts";

it("publishes each compatibility projection with matching durable hashes and losses", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "oc-projections-")));
  try {
    const stateRoot = join(root, "state");
    const library = await openProjectLibrary({ stateRoot });
    await library.createProject({
      envelope: ProjectEnvelopeSchema.parse(
        JSON.parse(
          readFileSync("packages/testkit/contracts/v1/valid/project-envelope.json", "utf8"),
        ),
      ),
      records: goldenRecords(),
    });
    const { exportTarget, openProjectExports } = await loadExportFixtureService();
    const service = await openProjectExports({
      library,
      stateRoot,
      pickTarget: async (format) => join(root, `score.${exportTarget(format).extension}`),
    });
    for (const type of ["save_chordpro", "save_lrc", "save_pdf"] as const) {
      const snapshot = (await library.getSnapshot("project_golden"))!;
      const request = {
        projectId: "project_golden",
        expectedProjectRevisionId: snapshot.projectRevisionId,
      };
      const response = await service.perform(
        type === "save_lrc" ? { ...request, type } : { ...request, type, presentation: "current" },
      );
      expect(response.state).toBe("saved");
      const receipt = response.receipts.at(-1)!;
      const bytes = await readFile(join(root, receipt.displayName));
      expect(receipt.outputHash).toBe(`sha256:${createHash("sha256").update(bytes).digest("hex")}`);
      expect(receipt.omissions).toContain("stable_identity_not_represented");
    }
    const pdfBytes = await readFile(join(root, "score.pdf"));
    expect(pdfBytes.subarray(0, 5).toString()).toBe("%PDF-");
    expect((await inspectPdf(pdfBytes)).pages[0]!.fonts.every(({ embedded }) => embedded)).toBe(
      true,
    );
    expect(await readFile(join(root, "score.cho"), "utf8")).toContain("{title: project_golden}");
    expect(await readFile(join(root, "score.lrc"), "utf8")).toMatch(/\[\d+:\d+\.\d+\]/);

    const reopened = await openProjectLibrary({ stateRoot });
    expect(reopened.listExportReceipts("project_golden").map(({ format }) => format)).toEqual([
      "chordpro",
      "lrc",
      "pdf",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("does not open a picker or publish a Receipt when LRC has no selected lyrics", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "oc-lrc-unavailable-")));
  try {
    const stateRoot = join(root, "state");
    const library = await openProjectLibrary({ stateRoot });
    const envelope = ProjectEnvelopeSchema.parse(
      JSON.parse(readFileSync("packages/testkit/contracts/v1/valid/project-envelope.json", "utf8")),
    );
    delete envelope.payload.activeView!.lyricsDocumentId;
    delete envelope.payload.activeView!.lyricsAlignmentId;
    await library.createProject({ envelope, records: goldenRecords() });
    let picked = false;
    const { openProjectExports } = await loadExportFixtureService();
    const service = await openProjectExports({
      library,
      stateRoot,
      pickTarget: async () => {
        picked = true;
        return join(root, "score.lrc");
      },
    });
    expect(
      await service.saveLrc({
        projectId: "project_golden",
        expectedProjectRevisionId: (await library.getSnapshot("project_golden"))!.projectRevisionId,
      }),
    ).toEqual({ state: "unavailable" });
    expect(picked).toBe(false);
    expect(library.listExportReceipts("project_golden")).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

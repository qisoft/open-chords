import { readFileSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ProjectEnvelopeSchema } from "@open-chords/contracts";
import { expect, test } from "vitest";

import { DesktopCommandGateway } from "../apps/desktop/src/main/desktop-command-gateway.ts";
import { openJsonExports } from "../apps/desktop/src/main/json-exports.ts";
import { openProjectLibrary } from "../apps/desktop/src/main/project-library.ts";
import { goldenRecords } from "./support/editor-fixture.ts";

test("only the primary named export capability can publish; renderer paths are rejected", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "oc-export-desktop-")));
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
    const service = await openJsonExports({
      library,
      stateRoot,
      pickTarget: async () => join(root, "result.json"),
    });
    const gateway = new DesktopCommandGateway(
      library,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      service,
    );
    const sender = {
      generationId: "generation_test",
      senderId: 1,
      isMainFrame: true,
      frameUrl: "open-chords://app/index.html",
      security: {
        contextIsolation: true,
        nodeIntegration: false,
        persistentSession: false,
        sandbox: true,
        webSecurity: true,
      },
    };
    const command = {
      protocol: "open-chords/desktop-ipc",
      protocolVersion: "1.0",
      requestId: "request_export",
      generationId: "generation_test",
      type: "exports.perform",
      action: {
        type: "save_json",
        projectId: "project_golden",
        expectedProjectRevisionId: (await library.getSnapshot("project_golden"))!.projectRevisionId,
        presentation: "current",
      },
    };
    expect(
      (await gateway.execute(command, { ...sender, frameUrl: "https://www.youtube.com" })).action,
    ).toBe("destroy_sender");
    expect(
      (
        await gateway.execute(
          { ...command, action: { ...command.action, path: join(root, "hostile.json") } },
          sender,
        )
      ).response,
    ).toMatchObject({ type: "desktop.error", code: "invalid_command" });
    const result = (await gateway.execute(command, sender)).response;
    expect(result).toMatchObject({
      type: "exports.result",
      state: "saved",
      receipts: [{ displayName: "result.json" }],
    });
    expect(JSON.stringify(result)).not.toContain(root);
    const originalReceipt = {
      ...library.listExportReceipts("project_golden")[0]!,
      id: "export_historical",
      omissions: Array.from({ length: 101 }, () => "x".repeat(201)),
      profileVersion: "p".repeat(101),
    };
    await library.recordExportReceipt("project_golden", originalReceipt);
    const listed = (
      await gateway.execute(
        { ...command, action: { type: "list", projectId: "project_golden" } },
        sender,
      )
    ).response;
    expect(listed.type).toBe("exports.result");
    if (listed.type !== "exports.result") throw new Error("Receipt summary unavailable");
    const summary = listed.receipts.find(({ id }) => id === "export_historical")!;
    expect(summary.detailsTruncated).toBe(true);
    expect(summary.omissions).toHaveLength(100);
    expect(summary.omissions[0]).toHaveLength(200);
    expect(summary.profileVersion).toHaveLength(100);
    expect(library.listExportReceipts("project_golden").at(-1)).toEqual(originalReceipt);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

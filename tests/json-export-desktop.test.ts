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
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

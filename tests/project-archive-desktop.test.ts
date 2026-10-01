import { readFileSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ProjectEnvelopeSchema } from "@open-chords/contracts";
import { expect, test } from "vitest";

import { DesktopCommandGateway } from "../apps/desktop/src/main/desktop-command-gateway.ts";
import { openOfflineMediaCache } from "../apps/desktop/src/main/offline-media-cache.ts";
import { ProjectArchiveImports } from "../apps/desktop/src/main/project-archive-imports.ts";
import { openProjectExports } from "../apps/desktop/src/main/project-exports.ts";
import { openProjectLibrary } from "../apps/desktop/src/main/project-library.ts";
import { goldenRecords } from "./support/editor-fixture.ts";

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
const envelope = (requestId: string) => ({
  protocol: "open-chords/desktop-ipc",
  protocolVersion: "1.0",
  requestId,
  generationId: "generation_test",
});

test("archive export and import run only through main-owned named capabilities", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "oc-archive-desktop-")));
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
    const archivePath = join(root, "shared.ocarchive");
    const pickedFormats: string[] = [];
    const exports = await openProjectExports({
      library,
      stateRoot,
      pickTarget: async (format) => {
        pickedFormats.push(format);
        return archivePath;
      },
    });
    const archives = new ProjectArchiveImports({
      cache: await openOfflineMediaCache({ stateRoot }),
      library,
      pickArchive: async () => archivePath,
    });
    const gateway = new DesktopCommandGateway(
      library,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      exports,
      archives,
    );
    const save = {
      ...envelope("request_archive_export"),
      type: "exports.perform",
      action: {
        type: "save_archive",
        projectId: "project_golden",
        expectedProjectRevisionId: (await library.getSnapshot("project_golden"))!.projectRevisionId,
        includeMedia: false,
      },
    };
    const importCommand = {
      ...envelope("request_archive_import"),
      adoptOfflineMedia: false,
      type: "archives.import",
    };

    expect(
      (await gateway.execute(importCommand, { ...sender, frameUrl: "https://www.youtube.com" }))
        .action,
    ).toBe("destroy_sender");
    expect(
      (await gateway.execute({ ...importCommand, path: join(root, "hostile.ocarchive") }, sender))
        .response,
    ).toMatchObject({ type: "desktop.error", code: "invalid_command" });
    expect(
      (
        await gateway.execute(
          { ...save, action: { ...save.action, path: join(root, "hostile.ocarchive") } },
          sender,
        )
      ).response,
    ).toMatchObject({ type: "desktop.error", code: "invalid_command" });

    const saved = (await gateway.execute(save, sender)).response;
    expect(saved).toMatchObject({
      type: "exports.result",
      state: "saved",
      receipts: [
        {
          displayName: "shared.ocarchive",
          format: "project_archive",
          profileVersion: "project_archive/1.0/no_media",
        },
      ],
    });
    expect(pickedFormats).toEqual(["project_archive"]);
    expect(JSON.stringify(saved)).not.toContain(root);

    const imported = (await gateway.execute(importCommand, sender)).response;
    expect(imported).toMatchObject({
      type: "archives.import_result",
      result: { importedCopy: true, offlineMedia: { state: "not_included" }, state: "imported" },
    });
    expect(JSON.stringify(imported)).not.toContain(root);
    expect(library.listProjects()).toHaveLength(2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a second archive import while one is choosing a file reports busy", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "oc-archive-busy-")));
  try {
    const stateRoot = join(root, "state");
    const library = await openProjectLibrary({ stateRoot });
    let release!: (path: string | null) => void;
    const archives = new ProjectArchiveImports({
      cache: await openOfflineMediaCache({ stateRoot }),
      library,
      pickArchive: () =>
        new Promise<string | null>((resolve) => {
          release = resolve;
        }),
    });
    const gateway = new DesktopCommandGateway(
      library,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      archives,
    );
    const command = (requestId: string) => ({
      ...envelope(requestId),
      adoptOfflineMedia: false,
      type: "archives.import",
    });
    const first = gateway.execute(command("request_import_first"), sender);
    expect(
      (await gateway.execute(command("request_import_second"), sender)).response,
    ).toMatchObject({ code: "busy", retryable: true, type: "desktop.error" });
    release(null);
    expect((await first).response).toMatchObject({
      result: { state: "cancelled" },
      type: "archives.import_result",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

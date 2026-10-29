import { readFileSync } from "node:fs";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
  chmod,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ProjectEnvelopeSchema } from "@open-chords/contracts";
import { expect, it } from "vitest";

import { openProjectExports } from "../apps/desktop/src/main/project-exports.ts";
import { openProjectLibrary } from "../apps/desktop/src/main/project-library.ts";
import { goldenRecords } from "./support/editor-fixture.ts";

const envelope = () =>
  ProjectEnvelopeSchema.parse(
    JSON.parse(readFileSync("packages/testkit/contracts/v1/valid/project-envelope.json", "utf8")),
  );

it("publishes the captured view after later edits and retains a matching Receipt", async () => {
  const started = performance.now();
  const probe = (
    stage:
      | "start"
      | "root_ready"
      | "library_opened"
      | "project_created"
      | "service_opened"
      | "snapshot_captured"
      | "save_requested"
      | "picker_entered"
      | "picker_observed"
      | "edit_committed"
      | "target_selected"
      | "saved"
      | "output_verified"
      | "receipt_verified"
      | "snapshot_verified"
      | "cleanup_started"
      | "cleanup_finished",
  ) => {
    process.stdout.write(
      `JSON export capture probe: stage=${stage} duration_ms=${Math.max(0, Math.min(200000, Math.floor(performance.now() - started)))}\n`,
    );
  };
  probe("start");
  const root = await realpath(await mkdtemp(join(tmpdir(), "oc-export-save-")));
  probe("root_ready");
  try {
    const stateRoot = join(root, "state");
    const library = await openProjectLibrary({ stateRoot });
    probe("library_opened");
    await library.createProject({ envelope: envelope(), records: goldenRecords() });
    probe("project_created");
    let choose!: (value: string | null) => void;
    let entered!: () => void;
    const picking = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const service = await openProjectExports({
      library,
      stateRoot,
      pickTarget: async () => {
        probe("picker_entered");
        entered();
        return new Promise<string | null>((resolve) => {
          choose = resolve;
        });
      },
    });
    probe("service_opened");
    const before = (await library.getSnapshot("project_golden"))!;
    probe("snapshot_captured");
    probe("save_requested");
    const saving = service.saveJson({
      projectId: "project_golden",
      expectedProjectRevisionId: before.projectRevisionId,
      presentation: "current",
    });
    await picking;
    probe("picker_observed");
    await library.commitEditTransaction({
      projectId: "project_golden",
      expectedProjectRevisionId: before.projectRevisionId,
      transaction: {
        id: "later_edit",
        parentTransactionId: null,
        operations: [
          { type: "replace_chord_value", eventId: "chord_g7", value: { kind: "no_chord" } },
        ],
      },
    });
    probe("edit_committed");
    choose(join(root, "export.json"));
    probe("target_selected");
    expect((await saving).state).toBe("saved");
    probe("saved");
    expect(await readFile(join(root, "export.json"), "utf8")).toBe(
      readFileSync("tests/fixtures/json-export-golden.json", "utf8"),
    );
    probe("output_verified");
    expect(library.listExportReceipts("project_golden")).toHaveLength(1);
    probe("receipt_verified");
    expect(
      (await library.getSnapshot("project_golden"))!.project.activeView!.editHistoryPosition,
    ).toBe(2);
    probe("snapshot_verified");
  } finally {
    probe("cleanup_started");
    await rm(root, { recursive: true, force: true });
    probe("cleanup_finished");
  }
});

it("retains full output and recovers its Receipt after a Library publication failure", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "oc-export-recovery-")));
  try {
    let fail = false;
    const stateRoot = join(root, "state");
    const library = await openProjectLibrary({
      stateRoot,
      faultInjector: (point) => {
        if (fail && point === "before_head_replace")
          throw new Error("simulated durable-write interruption");
      },
    });
    await library.createProject({ envelope: envelope(), records: goldenRecords() });
    const service = await openProjectExports({
      library,
      stateRoot,
      pickTarget: async () => join(root, "export.json"),
    });
    fail = true;
    expect(
      (
        await service.saveJson({
          projectId: "project_golden",
          expectedProjectRevisionId: (await library.getSnapshot("project_golden"))!
            .projectRevisionId,
          presentation: "current",
        })
      ).state,
    ).toBe("receipt_pending");
    expect(JSON.parse(await readFile(join(root, "export.json"), "utf8")).format).toBe(
      "open-chords/json-snapshot",
    );
    const reopened = await openProjectLibrary({ stateRoot });
    await openProjectExports({ library: reopened, stateRoot, pickTarget: async () => null });
    expect(reopened.listExportReceipts("project_golden")).toHaveLength(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("cancels without a Receipt and refuses a directory target without replacing it", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "oc-export-cancel-")));
  try {
    const stateRoot = join(root, "state");
    const library = await openProjectLibrary({ stateRoot });
    await library.createProject({ envelope: envelope(), records: goldenRecords() });
    let target: string | null = null;
    const service = await openProjectExports({
      library,
      stateRoot,
      pickTarget: async () => target,
    });
    const request = {
      projectId: "project_golden",
      expectedProjectRevisionId: (await library.getSnapshot("project_golden"))!.projectRevisionId,
      presentation: "current" as const,
    };
    expect((await service.saveJson(request)).state).toBe("cancelled");
    target = join(root, "directory.json");
    await mkdir(target);
    await writeFile(join(target, "keep"), "original");
    await expect(service.saveJson(request)).rejects.toThrow(Error);
    expect(await readFile(join(target, "keep"), "utf8")).toBe("original");
    expect(library.listExportReceipts("project_golden")).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("honors cancellation while the picker is open and rejects stale or protected destinations", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "oc-export-boundary-")));
  try {
    const stateRoot = join(root, "state");
    const library = await openProjectLibrary({ stateRoot });
    await library.createProject({ envelope: envelope(), records: goldenRecords() });
    let choose!: (target: string | null) => void;
    let entered!: () => void;
    const picking = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const service = await openProjectExports({
      library,
      stateRoot,
      pickTarget: async () => {
        entered();
        return new Promise<string | null>((resolve) => {
          choose = resolve;
        });
      },
    });
    const request = {
      projectId: "project_golden",
      expectedProjectRevisionId: (await library.getSnapshot("project_golden"))!.projectRevisionId,
      presentation: "current",
    };
    const target = join(root, "keep.json");
    await writeFile(target, "existing output");
    const saving = service.saveJson(request);
    await picking;
    await expect(service.saveJson(request)).rejects.toThrow("already running");
    await expect(service.recover()).rejects.toThrow("running");
    service.cancel();
    choose(target);
    expect(await saving).toEqual({ state: "cancelled" });
    expect(await readFile(target, "utf8")).toBe("existing output");
    const protectedService = await openProjectExports({
      library,
      stateRoot,
      pickTarget: async () => join(stateRoot, "forbidden.json"),
    });
    await expect(protectedService.saveJson(request)).rejects.toThrow("Protected export target");
    await expect(
      protectedService.saveJson({
        ...request,
        expectedProjectRevisionId: `projectrevision_${"0".repeat(32)}`,
      }),
    ).rejects.toThrow("current writable Project revision");
    expect(library.listExportReceipts("project_golden")).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.skipIf(process.platform === "win32")(
  "a real staging write denial preserves an existing destination and removes recovery intent",
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "oc-export-denied-")));
    const destination = join(root, "destination");
    try {
      const stateRoot = join(root, "state");
      const library = await openProjectLibrary({ stateRoot });
      await library.createProject({ envelope: envelope(), records: goldenRecords() });
      await mkdir(destination);
      const target = join(destination, "existing.json");
      await writeFile(target, "existing complete file");
      await chmod(destination, 0o500);
      const service = await openProjectExports({
        library,
        stateRoot,
        pickTarget: async () => target,
      });
      await expect(
        service.saveJson({
          projectId: "project_golden",
          expectedProjectRevisionId: (await library.getSnapshot("project_golden"))!
            .projectRevisionId,
          presentation: "current",
        }),
      ).rejects.toThrow(Error);
      expect(await readFile(target, "utf8")).toBe("existing complete file");
      expect(await readdir(destination)).toEqual(["existing.json"]);
      expect(await readdir(join(stateRoot, "export-pending"))).toEqual([]);
      expect(library.listExportReceipts("project_golden")).toEqual([]);
    } finally {
      await chmod(destination, 0o700);
      await rm(root, { recursive: true, force: true });
    }
  },
);

it("refuses output beneath the installed executable root while publishing to a sibling directory", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "oc-export-installed-boundary-")));
  try {
    const installedRoot = join(root, "installed");
    const nestedOutput = join(installedRoot, "controlled-output");
    const siblingOutput = join(root, "controlled-output");
    await mkdir(nestedOutput, { recursive: true });
    await mkdir(siblingOutput);
    const stateRoot = join(installedRoot, "state");
    const library = await openProjectLibrary({ stateRoot });
    await library.createProject({ envelope: envelope(), records: goldenRecords() });
    const before = await library.readProject("project_golden");
    const request = {
      projectId: "project_golden",
      expectedProjectRevisionId: before.projectRevisionId,
      presentation: "current",
    };
    let target = join(nestedOutput, "Open Chords.json");
    const service = await openProjectExports({
      library,
      stateRoot,
      protectedRoots: [installedRoot],
      pickTarget: async () => target,
    });
    await expect(service.saveJson(request)).rejects.toThrow("Protected export target");
    expect(await readdir(nestedOutput)).toEqual([]);
    expect(await library.readProject("project_golden")).toEqual(before);
    expect(library.listExportReceipts("project_golden")).toEqual([]);
    target = join(siblingOutput, "Open Chords.json");
    expect(await service.saveJson(request)).toEqual({ state: "saved" });
    expect(await readdir(siblingOutput)).toEqual(["Open Chords.json"]);
    expect(library.listExportReceipts("project_golden")).toHaveLength(1);
    expect(library.listExportReceipts("project_golden")[0]?.outputLocation).toBe(target);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

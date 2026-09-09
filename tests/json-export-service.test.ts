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

import { openJsonExports } from "../apps/desktop/src/main/json-exports.ts";
import { openProjectLibrary } from "../apps/desktop/src/main/project-library.ts";
import { goldenRecords } from "./support/editor-fixture.ts";

const envelope = () =>
  ProjectEnvelopeSchema.parse(
    JSON.parse(readFileSync("packages/testkit/contracts/v1/valid/project-envelope.json", "utf8")),
  );

it("publishes the captured view after later edits and retains a matching Receipt", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "oc-export-save-")));
  try {
    const stateRoot = join(root, "state");
    const library = await openProjectLibrary({ stateRoot });
    await library.createProject({ envelope: envelope(), records: goldenRecords() });
    let choose!: (value: string | null) => void;
    let entered!: () => void;
    const picking = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const service = await openJsonExports({
      library,
      stateRoot,
      pickTarget: async () => {
        entered();
        return new Promise<string | null>((resolve) => {
          choose = resolve;
        });
      },
    });
    const before = (await library.getSnapshot("project_golden"))!;
    const saving = service.saveJson({
      projectId: "project_golden",
      expectedProjectRevisionId: before.projectRevisionId,
      presentation: "current",
    });
    await picking;
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
    choose(join(root, "export.json"));
    expect((await saving).state).toBe("saved");
    expect(await readFile(join(root, "export.json"), "utf8")).toBe(
      readFileSync("tests/fixtures/json-export-golden.json", "utf8"),
    );
    expect(library.listExportReceipts("project_golden")).toHaveLength(1);
    expect(
      (await library.getSnapshot("project_golden"))!.project.activeView!.editHistoryPosition,
    ).toBe(2);
  } finally {
    await rm(root, { recursive: true, force: true });
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
    const service = await openJsonExports({
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
    await openJsonExports({ library: reopened, stateRoot, pickTarget: async () => null });
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
    const service = await openJsonExports({ library, stateRoot, pickTarget: async () => target });
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
    const service = await openJsonExports({
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
    const protectedService = await openJsonExports({
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
      const service = await openJsonExports({ library, stateRoot, pickTarget: async () => target });
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

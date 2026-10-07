import { readFileSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ProjectEnvelopeSchema, RecoveryResultSchema } from "@open-chords/contracts";
import { expect, it } from "vitest";

import { openProjectLibrary } from "../apps/desktop/src/main/project-library.ts";
import { ProjectRecovery } from "../apps/desktop/src/main/project-recovery.ts";
import { goldenRecords } from "./support/editor-fixture.ts";

const envelope = () =>
  ProjectEnvelopeSchema.parse(
    JSON.parse(readFileSync("packages/testkit/contracts/v1/valid/project-envelope.json", "utf8")),
  );

it("lists safe recovery metadata and rolls back a selected backup as a new durable revision", async () => {
  const root = await mkdtemp(join(tmpdir(), "oc-recovery-"));
  try {
    const library = await openProjectLibrary({ stateRoot: root });
    const created = await library.createProject({ envelope: envelope(), records: goldenRecords() });
    await library.changePractice({
      projectId: "project_golden",
      expectedProjectRevisionId: created.projectRevisionId,
      action: { type: "settings", speed: 0.75 },
    });
    const recovery = new ProjectRecovery(library);
    const before = RecoveryResultSchema.parse(
      await recovery.perform({ type: "inspect", projectId: "project_golden" }),
    );
    expect(before.detail?.revisions).toHaveLength(2);
    expect(JSON.stringify(before)).not.toContain(root);
    const current = before.detail!.project.projectRevisionId!;
    const request = {
      type: "rollback",
      projectId: "project_golden",
      expectedProjectRevisionId: current,
      targetProjectRevisionId: created.projectRevisionId,
      confirmedTargetProjectRevisionId: created.projectRevisionId,
    };
    await expect(
      recovery.perform({ ...request, confirmedTargetProjectRevisionId: current }),
    ).rejects.toThrow("Confirm the selected backup Revision");
    await expect(
      recovery.perform({ ...request, expectedProjectRevisionId: created.projectRevisionId }),
    ).rejects.toThrow("stale");
    expect((await library.getSnapshot("project_golden"))!.projectRevisionId).toBe(current);
    const result = RecoveryResultSchema.parse(await recovery.perform(request));
    expect(result.restoredProjectRevisionId).not.toBe(current);
    expect(result.detail?.revisions[0]?.reason).toBe("rollback");
    const reopened = await openProjectLibrary({ stateRoot: root });
    expect((await reopened.getSnapshot("project_golden"))!.projectRevisionId).toBe(
      result.restoredProjectRevisionId,
    );
    expect((await reopened.readProject("project_golden")).revisions).toHaveLength(3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("exposes failed migration as preserved read-only state without revealing private error text", async () => {
  const root = await mkdtemp(join(tmpdir(), "oc-recovery-migration-"));
  try {
    const initial = envelope();
    initial.schemaVersion = "1.0";
    initial.payload.schemaVersion = "1.0";
    const older = await openProjectLibrary({ stateRoot: root, currentSchemaVersion: "1.0" });
    await older.createProject({ envelope: initial, records: goldenRecords() });
    const head = join(older.activeRoot, "projects", "project_golden", "HEAD.json");
    const before = await readFile(head, "utf8");
    const library = await openProjectLibrary({
      stateRoot: root,
      currentSchemaVersion: "1.1",
      migrations: [
        {
          fromVersion: "1.0",
          toVersion: "1.1",
          migrate: () => {
            throw new Error("secret token /private/source.wav");
          },
        },
      ],
    });
    const result = RecoveryResultSchema.parse(
      await new ProjectRecovery(library).perform({ type: "inspect", projectId: "project_golden" }),
    );
    expect(result.detail?.project).toMatchObject({
      compatibility: "read_only",
      readOnlyReason: "migration_failed",
    });
    expect(JSON.stringify(result)).not.toMatch(/secret|private|source.wav/);
    expect(await readFile(head, "utf8")).toBe(before);
    const id = result.detail!.project.projectRevisionId!;
    await expect(
      new ProjectRecovery(library).perform({
        type: "rollback",
        projectId: "project_golden",
        expectedProjectRevisionId: id,
        targetProjectRevisionId: id,
        confirmedTargetProjectRevisionId: id,
      }),
    ).rejects.toThrow(/read.only/i);
    expect(await readFile(head, "utf8")).toBe(before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("shows newer schemas read-only and reports damaged Projects without inventing a revision", async () => {
  const root = await mkdtemp(join(tmpdir(), "oc-recovery-newer-"));
  try {
    const newer = envelope();
    newer.schemaVersion = "1.5";
    newer.payload.schemaVersion = "1.5";
    const writer = await openProjectLibrary({ stateRoot: root, currentSchemaVersion: "1.5" });
    await writer.createProject({ envelope: newer, records: goldenRecords() });
    const head = join(writer.activeRoot, "projects", "project_golden", "HEAD.json");
    const before = await readFile(head, "utf8");
    const reader = await openProjectLibrary({ stateRoot: root });
    const recovery = new ProjectRecovery(reader);
    const result = RecoveryResultSchema.parse(
      await recovery.perform({ type: "inspect", projectId: "project_golden" }),
    );
    expect(result.detail?.project).toMatchObject({
      compatibility: "read_only",
      readOnlyReason: "unsupported_schema",
    });
    const id = result.detail!.project.projectRevisionId!;
    await expect(
      recovery.perform({
        type: "rollback",
        projectId: "project_golden",
        expectedProjectRevisionId: id,
        targetProjectRevisionId: id,
        confirmedTargetProjectRevisionId: id,
      }),
    ).rejects.toThrow(/read.only/i);
    expect(await readFile(head, "utf8")).toBe(before);
    const objects = join(writer.activeRoot, "objects", "sha256");
    for (const file of await readdir(objects))
      await writeFile(join(objects, file), "invalid object");
    const damaged = await openProjectLibrary({ stateRoot: root });
    const report = RecoveryResultSchema.parse(
      await new ProjectRecovery(damaged).perform({ type: "inspect", projectId: "project_golden" }),
    );
    expect(report.detail?.project).toMatchObject({ status: "damaged", projectRevisionId: null });
    expect(report.detail?.revisions).toEqual([]);
    expect(report.restoredProjectRevisionId).toBeNull();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

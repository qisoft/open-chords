import { readFileSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ProjectEnvelopeSchema } from "@open-chords/contracts";
import { _electron as electron, expect, test } from "@playwright/test";
import axe from "axe-core";

import { openProjectLibrary } from "../../apps/desktop/src/main/project-library.ts";
import { goldenRecords } from "../support/editor-fixture.ts";

const repositoryRoot = join(import.meta.dirname, "../..");

test("backup recovery requires explicit confirmation and publishes a durable new Revision through IPC", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "oc-recovery-renderer-")));
  try {
    const library = await openProjectLibrary({ stateRoot: root });
    const created = await library.createProject({
      envelope: ProjectEnvelopeSchema.parse(
        JSON.parse(
          readFileSync("packages/testkit/contracts/v1/valid/project-envelope.json", "utf8"),
        ),
      ),
      records: goldenRecords(),
    });
    await library.changePractice({
      projectId: "project_golden",
      expectedProjectRevisionId: created.projectRevisionId,
      action: { type: "settings", speed: 0.75 },
    });
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env))
      if (key !== "ELECTRON_RUN_AS_NODE" && value !== undefined) env[key] = value;
    const app = await electron.launch({ args: [repositoryRoot, `--user-data-dir=${root}`], env });
    try {
      const page = await app.firstWindow();
      await page.getByRole("button", { name: "Project recovery", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Project recovery" });
      await dialog.getByRole("button", { name: "Inspect project_golden", exact: true }).click();
      const restore = dialog.getByRole("button", { name: "Restore selected backup", exact: true });
      await expect(restore).toBeDisabled();
      await dialog
        .getByRole("combobox", { name: "Backup Revision", exact: true })
        .selectOption(created.projectRevisionId);
      await expect(restore).toBeDisabled();
      await dialog.getByRole("checkbox").check();
      await expect(restore).toBeEnabled();
      await page.evaluate(axe.source);
      const violations = await page.evaluate(async () =>
        (await window.axe!.run(document.querySelector('[role="dialog"]')!)).violations.map(
          (v) => v.id,
        ),
      );
      expect(violations).toEqual([]);
      await restore.click();
      await expect(
        dialog.getByText(
          "Backup restored as a new Project Revision. Previous revisions remain available.",
          { exact: true },
        ),
      ).toBeVisible();
      const result = await page.evaluate(() =>
        window.openChords!.recovery.perform({ type: "inspect", projectId: "project_golden" }),
      );
      expect(result).toMatchObject({
        type: "recovery.result",
        detail: {
          revisions: [
            { reason: "rollback" },
            { reason: "edit_transaction" },
            { reason: "created" },
          ],
        },
      });
      expect(JSON.stringify(result)).not.toContain(root);
      await dialog.getByRole("button", { name: "Close", exact: true }).click();
    } finally {
      await app.close();
    }
    const reopened = await openProjectLibrary({ stateRoot: root });
    expect((await reopened.readProject("project_golden")).revisions.at(-1)?.reason).toBe(
      "rollback",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

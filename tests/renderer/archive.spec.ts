import { readFileSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ProjectEnvelopeSchema } from "@open-chords/contracts";
import { _electron as electron, expect, test } from "@playwright/test";
import axe from "axe-core";

import { openProjectLibrary } from "../../apps/desktop/src/main/project-library.ts";
import { goldenRecords } from "../support/editor-fixture.ts";

declare global {
  interface Window {
    axe?: typeof axe;
  }
}

test("the export dialog saves a Portable Project Archive and import creates a separate copy", async () => {
  test.setTimeout(90_000);
  const root = await realpath(await mkdtemp(join(tmpdir(), "oc-archive-renderer-")));
  const stateRoot = join(root, "state");
  const library = await openProjectLibrary({ stateRoot });
  await library.createProject({
    envelope: ProjectEnvelopeSchema.parse(
      JSON.parse(readFileSync("packages/testkit/contracts/v1/valid/project-envelope.json", "utf8")),
    ),
    records: goldenRecords(),
  });
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  delete env.ELECTRON_RUN_AS_NODE;
  const archivePath = join(root, "song.ocarchive");
  const hostilePath = join(root, "hostile.ocarchive");
  await writeFile(hostilePath, Buffer.from("not an archive"));
  const application = await electron.launch({
    args: [join(import.meta.dirname, "../.."), `--user-data-dir=${stateRoot}`],
    env,
  });
  try {
    // Replace only the external native-picker results; app, IPC, archive and Library code are real.
    await application.evaluate(({ dialog }, path) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, archivePath);
    const page = await application.firstWindow();
    await page.getByRole("button", { name: "Export Project", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "Portable Project Archive" })).toBeVisible();
    await expect(
      dialog.getByRole("checkbox", { name: "Include verified Project Range media" }),
    ).not.toBeChecked();
    await page.evaluate(axe.source);
    const audit = await page.evaluate(async () => {
      const engine = window.axe;
      if (!engine) throw new Error("axe did not load");
      return engine.run(document.querySelector('[role="dialog"]') ?? document, {
        runOnly: {
          type: "tag",
          values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"],
        },
      });
    });
    expect(audit.violations.map(({ id }) => id)).toEqual([]);

    await dialog.getByRole("button", { name: "Save Project Archive", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Export saved" })).toBeVisible();
    await expect(dialog.getByText("song.ocarchive", { exact: true })).toBeVisible();
    await dialog.getByText("Snapshot hashes and omissions").last().click();
    await expect(
      dialog.getByText(
        "Local file locations were omitted; the Source stays identified by its fingerprint.",
        { exact: true },
      ),
    ).toBeVisible();
    expect((await readFile(archivePath)).readUInt32LE(0)).toBe(0x04034b50);
    await dialog.getByRole("button", { name: "Close", exact: true }).click();

    await page.getByRole("button", { name: "Import Project Archive", exact: true }).click();
    await expect(
      page.getByText(
        "Imported as a separate Project copy because this Library already has a different history with the same identity.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(page.locator(".project-identity")).toHaveText(/^project_[a-f0-9]{32}$/);
    expect(
      await page.evaluate(async () => {
        const list = await window.openChords!.project.list();
        return list.type === "project.list" ? list.projects.length : -1;
      }),
    ).toBe(2);

    await application.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, hostilePath);
    await page.getByRole("button", { name: "Import Project Archive", exact: true }).click();
    await expect(
      page.getByRole("alert").filter({
        hasText:
          "Archive rejected because it is not a well-formed Open Chords archive. Nothing was imported.",
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("alert").filter({ hasText: "The verified Source is unavailable." }),
    ).toBeVisible();
    await application.evaluate(({ dialog }) => {
      dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
    });
    await page.getByRole("button", { name: "Import Project Archive", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Import cancelled" })).toBeVisible();
  } finally {
    await application.close();
    await rm(root, { recursive: true, force: true });
  }
});

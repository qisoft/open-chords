import { readFileSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ProjectEnvelopeSchema } from "@open-chords/contracts";
import { _electron as electron, expect, test } from "@playwright/test";

import { openProjectLibrary } from "../../apps/desktop/src/main/project-library.ts";
import { goldenRecords } from "../support/editor-fixture.ts";

test("the export dialog saves a committed JSON view and reopens its Receipt", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "oc-export-renderer-")));
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
  const launch = () =>
    electron.launch({
      args: [join(import.meta.dirname, "../.."), `--user-data-dir=${stateRoot}`],
      env,
    });
  let application = await launch();
  try {
    // Replace only the external native-picker result; all app/IPC/export/Library code is real.
    await application.evaluate(
      ({ dialog }, filePath) => {
        dialog.showSaveDialog = async () => ({ canceled: false, filePath });
      },
      join(root, "score.json"),
    );
    let page = await application.firstWindow();
    await page.getByRole("button", { name: "Export Project", exact: true }).click();
    await page.getByRole("button", { name: "Save JSON", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Export saved" })).toBeVisible();
    await expect(page.getByText("score.json", { exact: true })).toBeVisible();
    await page.setViewportSize({ width: 320, height: 720 });
    await page.getByText("Snapshot hashes and omissions", { exact: true }).click();
    expect(
      await page
        .getByRole("dialog")
        .evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true);
    await expect(
      page.getByText("Free-form benchmark descriptions were omitted to protect private data.", {
        exact: true,
      }),
    ).toBeVisible();
    expect(JSON.parse(await readFile(join(root, "score.json"), "utf8")).lyrics.document.text).toBe(
      "go go\nhome go",
    );
    await application.close();
    application = await launch();
    page = await application.firstWindow();
    await page.getByRole("button", { name: "Export Project", exact: true }).click();
    await expect(page.getByText("score.json", { exact: true })).toBeVisible();
    await application.evaluate(({ dialog }) => {
      dialog.showSaveDialog = async () => ({ canceled: true, filePath: "" });
    });
    await page.getByRole("button", { name: "Save JSON", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Export cancelled" })).toBeVisible();
    expect(
      await page.evaluate(() =>
        window.openChords!.exports.perform({ type: "list", projectId: "project_golden" }),
      ),
    ).toMatchObject({ receipts: [{ displayName: "score.json" }] });
  } finally {
    await application.close();
    await rm(root, { recursive: true, force: true });
  }
});

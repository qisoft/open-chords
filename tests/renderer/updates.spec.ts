import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { _electron as electron, expect, test } from "@playwright/test";
import axe from "axe-core";

import { openNetworkMode } from "../../apps/desktop/src/main/network-mode.ts";

const repositoryRoot = join(import.meta.dirname, "../..");

test("manual update controls respect persisted Offline Mode through named IPC", async () => {
  const root = await mkdtemp(join(tmpdir(), "oc-updates-renderer-"));
  await (await openNetworkMode(root)).setOffline(true);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key !== "ELECTRON_RUN_AS_NODE" && value !== undefined) env[key] = value;
  }
  const application = await electron.launch({
    args: [repositoryRoot, `--user-data-dir=${root}`],
    env,
  });
  try {
    const page = await application.firstWindow();
    await page.getByRole("button", { name: "Updates", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Manual updates" });
    await expect(
      dialog.getByText("Offline Mode is enabled. No update request is made.", { exact: true }),
    ).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "Check for updates", exact: true }),
    ).toBeDisabled();
    await expect(
      dialog.getByRole("button", { name: "Open verification instructions", exact: true }),
    ).toBeDisabled();
    const result = await page.evaluate(() => window.openChords!.updates.perform({ type: "check" }));
    expect(result).toMatchObject({
      type: "updates.result",
      state: "offline",
      offline: true,
      checkedAt: null,
      release: null,
    });
    await page.addScriptTag({ content: axe.source });
    expect(
      await page.evaluate(async () =>
        (await window.axe!.run(document.querySelector('[role="dialog"]')!)).violations.map(
          (v) => v.id,
        ),
      ),
    ).toEqual([]);
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await page.getByRole("button", { name: "Updates", exact: true }).click();
    await expect(
      dialog.getByRole("button", { name: "Check for updates", exact: true }),
    ).toBeDisabled();
  } finally {
    await application.close();
    await rm(root, { recursive: true, force: true });
  }
});

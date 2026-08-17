import { join } from "node:path";

import { _electron as electron, expect, test } from "@playwright/test";

const repositoryRoot = join(import.meta.dirname, "../..");

test("the static renderer runs inside an isolated Electron window", async () => {
  const application = await electron.launch({ args: [repositoryRoot] });

  try {
    const page = await application.firstWindow();
    await expect(page.getByRole("heading", { name: "Open Chords foundation" })).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.readyState)).toBe("complete");

    expect(
      await page.evaluate(() => ({
        nodeProcess: "process" in window,
        nodeRequire: "require" in window,
        protocol: window.location.protocol,
      })),
    ).toEqual({
      nodeProcess: false,
      nodeRequire: false,
      protocol: "file:",
    });
  } finally {
    await application.close();
  }
});

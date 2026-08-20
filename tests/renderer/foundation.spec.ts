import { join } from "node:path";

import { _electron as electron, expect, test } from "@playwright/test";

const repositoryRoot = join(import.meta.dirname, "../..");

test("the primary renderer runs only through the hardened application origin", async () => {
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (name !== "ELECTRON_RUN_AS_NODE" && value !== undefined) environment[name] = value;
  }
  const application = await electron.launch({ args: [repositoryRoot], env: environment });

  try {
    const page = await application.firstWindow();
    await expect(page.getByRole("heading", { name: "Open Chords foundation" })).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.readyState)).toBe("complete");

    expect(
      await page.evaluate(async () => ({
        externalFetchDenied: await fetch("https://example.invalid").then(
          () => false,
          () => true,
        ),
        nodeProcess: "process" in window,
        nodeRequire: "require" in window,
        notificationPermission: await Notification.requestPermission(),
        protocol: window.location.protocol,
        windowOpenDenied: window.open("https://example.invalid") === null,
      })),
    ).toEqual({
      externalFetchDenied: true,
      nodeProcess: false,
      nodeRequire: false,
      notificationPermission: "denied",
      protocol: "open-chords:",
      windowOpenDenied: true,
    });

    await page.evaluate(() => {
      window.location.href = "https://example.invalid";
    });
    await expect.poll(() => page.url()).toBe("open-chords://app/index.html");
  } finally {
    await application.close();
  }
});

import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { _electron as electron, expect, test } from "@playwright/test";

const repositoryRoot = join(import.meta.dirname, "../..");

test("the primary renderer runs only through the hardened application origin", async () => {
  const userDataDirectory = mkdtempSync(join(tmpdir(), "open-chords-renderer-profile-"));
  let requestCount = 0;
  const server = createServer((_request, response) => {
    requestCount += 1;
    response.end("unexpected");
  });
  const externalUrl = await new Promise<string>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Could not start the external request probe"));
        return;
      }
      resolve(`http://127.0.0.1:${String(address.port)}/probe`);
    });
  });
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (name !== "ELECTRON_RUN_AS_NODE" && value !== undefined) environment[name] = value;
  }
  const application = await electron.launch({
    args: [repositoryRoot, `--user-data-dir=${userDataDirectory}`],
    env: environment,
  });

  try {
    const page = await application.firstWindow();
    await expect(page.getByRole("heading", { name: "Open a local recording" })).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.readyState)).toBe("complete");

    expect(
      await page.evaluate(
        async (url) => ({
          externalFetchDenied: await fetch(url).then(
            () => false,
            () => true,
          ),
          nodeProcess: "process" in window,
          nodeRequire: "require" in window,
          notificationPermission: await Notification.requestPermission(),
          protocol: window.location.protocol,
          windowOpenDenied: window.open("https://example.invalid") === null,
        }),
        externalUrl,
      ),
    ).toEqual({
      externalFetchDenied: true,
      nodeProcess: false,
      nodeRequire: false,
      notificationPermission: "denied",
      protocol: "open-chords:",
      windowOpenDenied: true,
    });
    expect(requestCount).toBe(0);

    await page.evaluate(() => {
      window.location.href = "https://example.invalid";
    });
    await expect.poll(() => page.url()).toBe("open-chords://app/index.html");
  } finally {
    await application.close();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    rmSync(userDataDirectory, { force: true, recursive: true });
  }
});

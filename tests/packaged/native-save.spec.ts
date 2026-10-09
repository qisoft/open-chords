import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ProjectEnvelopeSchema } from "@open-chords/contracts";
import { captureJsonExport, serializeJsonExport } from "@open-chords/domain";
import { chromium, expect, test } from "@playwright/test";
import extractZip from "extract-zip";

import { openNetworkMode } from "../../apps/desktop/src/main/network-mode.ts";
import { proofTreeHashes } from "../../apps/desktop/src/main/packaged-proof-tree.ts";
import { openProjectLibrary } from "../../apps/desktop/src/main/project-library.ts";
import { goldenRecords } from "../support/editor-fixture.ts";
import { leadSheetProject } from "../support/export-fixture.ts";

test.skip(process.platform !== "win32", "Windows native Save dialog");

test("installed Windows native Save cancellation preserves Library and Save publishes a durable receipt", async () => {
  test.setTimeout(480000);
  const root = await realpath(await mkdtemp(join(tmpdir(), "oc-native-save-")));
  try {
    const stateRoot = join(root, "state");
    await (await openNetworkMode(stateRoot)).setOffline(true);
    const library = await openProjectLibrary({ stateRoot });
    const envelope = ProjectEnvelopeSchema.parse(
      JSON.parse(
        await readFile("packages/testkit/contracts/v1/valid/project-envelope.json", "utf8"),
      ),
    );
    envelope.payload = leadSheetProject();
    await library.createProject({ envelope, records: goldenRecords() });
    const preservedTarget = join(root, "preserved.json");
    await writeFile(preservedTarget, "preserve existing external file");
    const target = join(root, "native-score.json");
    await extractZip(
      join(
        process.cwd(),
        "out",
        "make",
        "zip",
        process.platform,
        process.arch,
        `Open Chords-${process.platform}-${process.arch}-0.0.0.zip`,
      ),
      { dir: join(root, "installed") },
    );
    const windows = process.env.SystemRoot ?? process.env.WINDIR;
    if (!windows) throw new Error("Windows OS directory unavailable");
    const env: NodeJS.ProcessEnv = {};
    for (const key of [
      "SystemRoot",
      "WINDIR",
      "TEMP",
      "TMP",
      "HOME",
      "USERPROFILE",
      "APPDATA",
      "LOCALAPPDATA",
    ])
      if (process.env[key]) env[key] = process.env[key];
    env.PATH = [
      join(windows, "System32", "WindowsPowerShell", "v1.0"),
      join(windows, "System32"),
      windows,
    ].join(";");
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Debug port unavailable");
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const child = spawn(
      join(root, "installed", "Open Chords.exe"),
      [`--user-data-dir=${stateRoot}`, `--remote-debugging-port=${address.port}`],
      { env, stdio: "ignore" },
    );
    let failed = false;
    child.on("error", () => {
      failed = true;
    });
    const assertAlive = () => {
      if (failed || child.exitCode !== null || child.signalCode !== null)
        throw new Error("Installed native Save application exited");
    };
    const drive = (scenario: "cancel" | "save") =>
      new Promise<unknown>((resolve, reject) => {
        execFile(
          join(windows, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
          [
            "-NoProfile",
            "-NonInteractive",
            "-File",
            join(process.cwd(), "tests", "support", "installed-save-windows.ps1"),
            "-ApplicationPid",
            String(child.pid),
            "-Scenario",
            scenario,
            "-TargetPath",
            target,
          ],
          { env, timeout: 100000, maxBuffer: 16384 },
          (error, stdout, stderr) => {
            if (error) {
              const counters = stderr.match(
                /native_save_failed stage=(?:setup|discovery|default_filename|filename_set|native_input) windows=\d+ elements=\d+ filenames=\d+ actions=\d+/,
              )?.[0];
              reject(new Error(counters ?? "Installed native Save driver failed"));
              return;
            }
            try {
              resolve(JSON.parse(stdout.trim()));
            } catch {
              reject(new Error("Installed native Save driver returned invalid evidence"));
            }
          },
        );
      });
    try {
      const endpoint = `http://127.0.0.1:${address.port}`;
      await expect
        .poll(
          () => {
            assertAlive();
            return fetch(`${endpoint}/json/version`).then(
              (response) => response.ok,
              () => false,
            );
          },
          { timeout: 120000 },
        )
        .toBe(true);
      const browser = await chromium.connectOverCDP(endpoint);
      try {
        const context = browser.contexts()[0]!;
        await expect
          .poll(
            () => {
              assertAlive();
              return context.pages().some((page) => page.url().startsWith("open-chords://"));
            },
            { timeout: 120000 },
          )
          .toBe(true);
        const page = context
          .pages()
          .find((candidate) => candidate.url().startsWith("open-chords://"))!;
        await expect(page.locator('.source-status[role="alert"]')).toBeVisible();
        const readyLibrary = await openProjectLibrary({ stateRoot });
        const initial = await readyLibrary.readProject("project_golden");
        const baseline = await proofTreeHashes(readyLibrary.activeRoot);
        await page.getByRole("button", { name: "Export Project", exact: true }).click();
        await page.getByRole("button", { name: "Save JSON", exact: true }).click();
        expect(await drive("cancel")).toEqual({
          action: "cancel",
          filenameSet: false,
          nativeClick: true,
          defaultNameValid: true,
        });
        await expect(page.getByText("Export cancelled", { exact: true })).toBeVisible();
        const cancelled = await openProjectLibrary({ stateRoot });
        expect(await cancelled.readProject("project_golden")).toEqual(initial);
        expect(await proofTreeHashes(cancelled.activeRoot)).toEqual(baseline);
        expect(await readFile(preservedTarget, "utf8")).toBe("preserve existing external file");
        await page.getByRole("button", { name: "Save JSON", exact: true }).click();
        expect(await drive("save")).toEqual({
          action: "save",
          filenameSet: true,
          nativeClick: true,
          defaultNameValid: true,
        });
        await expect(page.getByText("Export saved", { exact: true })).toBeVisible({
          timeout: 60000,
        });
        await expect(page.getByText("native-score.json", { exact: true })).toBeVisible();
        const cdp = await browser.newBrowserCDPSession();
        void cdp.send("Browser.close").catch(() => undefined);
        await expect
          .poll(() => child.exitCode !== null || child.signalCode !== null, { timeout: 15000 })
          .toBe(true);
      } finally {
        await browser.close();
      }
    } finally {
      if (!failed && child.exitCode === null && child.signalCode === null) {
        child.kill();
        await expect
          .poll(() => child.exitCode !== null || child.signalCode !== null, { timeout: 15000 })
          .toBe(true);
      }
    }
    const bytes = await readFile(target);
    expect(bytes.toString()).toBe(
      serializeJsonExport(captureJsonExport(envelope.payload, { presentation: "current" })),
    );
    const reopened = await openProjectLibrary({ stateRoot });
    expect(reopened.listExportReceipts("project_golden")).toMatchObject([
      {
        displayName: "native-score.json",
        format: "open_chords_json",
        outputHash: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      },
    ]);
    expect((await reopened.readProject("project_golden")).revisions.at(-1)?.reason).toBe(
      "edit_transaction",
    );
    expect(await readFile(preservedTarget, "utf8")).toBe("preserve existing external file");
    expect((await openNetworkMode(stateRoot)).offline).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 40, retryDelay: 250 });
  }
});

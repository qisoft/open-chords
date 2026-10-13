import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ProjectEnvelopeSchema } from "@open-chords/contracts";
import { canonicalSerialize } from "@open-chords/domain";
import { chromium, expect, test } from "@playwright/test";
import extractZip from "extract-zip";

import { openNetworkMode } from "../../apps/desktop/src/main/network-mode.ts";
import { proofTreeHashes } from "../../apps/desktop/src/main/packaged-proof-tree.ts";
import {
  archivedProjectFor,
  writePortableProjectArchive,
} from "../../apps/desktop/src/main/project-archive-format.ts";
import { openProjectLibrary } from "../../apps/desktop/src/main/project-library.ts";
import { goldenRecords } from "../support/editor-fixture.ts";
import { leadSheetProject } from "../support/export-fixture.ts";
import { installedSaveDriverDiagnostic } from "../support/installed-save-diagnostics.ts";

test.skip(process.platform !== "win32", "Windows native Open dialog");

test("installed Windows native archive Open preserves cancellation, imports once and cold-reopens the portable Project", async () => {
  test.setTimeout(480000);
  const root = await realpath(await mkdtemp(join(tmpdir(), "oc-native-open-")));
  try {
    // Controlled module-generated fixture; this journey proves native Open, not native Save.
    const source = await openProjectLibrary({ stateRoot: join(root, "fixture") });
    const envelope = ProjectEnvelopeSchema.parse(
      JSON.parse(
        await readFile("packages/testkit/contracts/v1/valid/project-envelope.json", "utf8"),
      ),
    );
    envelope.payload = leadSheetProject();
    await source.createProject({ envelope, records: goldenRecords() });
    const expected = archivedProjectFor(await source.readProject("project_golden")).document;
    const { archive } = writePortableProjectArchive({ document: expected });
    const target = join(root, "fixture.ocarchive");
    await writeFile(target, archive);
    const archiveHash = createHash("sha256").update(archive).digest("hex");
    const stateRoot = join(root, "state");
    await (await openNetworkMode(stateRoot)).setOffline(true);
    const library = await openProjectLibrary({ stateRoot });
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
        throw new Error("Installed native Open application exited");
    };
    const drive = (scenario: "cancel_open" | "open") =>
      new Promise<unknown>((resolve, reject) => {
        const started = performance.now();
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
            "-Format",
            "archive",
            "-TargetPath",
            target,
          ],
          { env, timeout: 100000, maxBuffer: 65536 },
          (error, stdout, stderr) => {
            if (error) {
              reject(
                new Error(
                  installedSaveDriverDiagnostic(error, stderr, performance.now() - started),
                ),
              );
              return;
            }
            try {
              resolve(JSON.parse(stdout.trim()));
            } catch {
              reject(new Error("Installed native Open driver returned invalid evidence"));
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
        const importButton = page.getByTestId("archives.import.button");
        const status = page.getByTestId("archives.import.status");
        await expect(importButton).toBeVisible();
        await expect(page.getByTestId("archives.import.adopt-media")).not.toBeChecked();
        const baseline = await proofTreeHashes(library.activeRoot);
        await importButton.click();
        expect(await drive("cancel_open")).toEqual({
          action: "cancel_open",
          filenameSet: false,
          nativeClick: true,
          dialogDismissed: true,
          defaultNameValid: false,
        });
        await expect(status).toHaveText("Import cancelled");
        expect(await proofTreeHashes(library.activeRoot)).toEqual(baseline);
        await importButton.click();
        expect(await drive("open")).toEqual({
          action: "open",
          filenameSet: true,
          nativeClick: true,
          dialogDismissed: true,
          defaultNameValid: false,
        });
        await expect(status).toContainText("Project imported.", { timeout: 60000 });
        await expect(page.locator('.source-status[role="alert"]')).toBeVisible();
        const importedBaseline = await proofTreeHashes(library.activeRoot);
        await importButton.click();
        expect(await drive("open")).toEqual({
          action: "open",
          filenameSet: true,
          nativeClick: true,
          dialogDismissed: true,
          defaultNameValid: false,
        });
        await expect(status).toContainText(
          "This Library already contains this exact Project history.",
          { timeout: 60000 },
        );
        expect(await proofTreeHashes(library.activeRoot)).toEqual(importedBaseline);
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
    const reopened = await openProjectLibrary({ stateRoot });
    expect(reopened.listProjects().length).toBe(1);
    expect(
      canonicalSerialize(
        archivedProjectFor(await reopened.readProject("project_golden")).document,
      ) === canonicalSerialize(expected),
      "Cold Project must match the portable envelope and records",
    ).toBe(true);
    expect(reopened.listExportReceipts("project_golden").length).toBe(0);
    expect((await openNetworkMode(stateRoot)).offline).toBe(true);
    expect(
      createHash("sha256")
        .update(await readFile(target))
        .digest("hex"),
    ).toBe(archiveHash);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 40, retryDelay: 250 });
  }
});

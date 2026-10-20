import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
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
import { prepareArchiveProofFixture } from "../support/archive-proof-fixture.ts";
import { goldenRecords } from "../support/editor-fixture.ts";
import { leadSheetProject } from "../support/export-fixture.ts";
import { installedMacPickerDriver } from "../support/installed-macos-picker-driver.ts";
import {
  installedSaveDriverDiagnostic,
  installedSaveDriverTiming,
} from "../support/installed-save-diagnostics.ts";

test.skip(!["win32", "darwin"].includes(process.platform), "Native Open dialog");

test("installed native archive Open preserves cancellation, rejects hostile input, recovers and cold-reopens both portable Projects", async () => {
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
    const recoveryEnvelope = ProjectEnvelopeSchema.parse(
      JSON.parse(JSON.stringify(envelope).replaceAll("project_golden", "project_recovery")),
    );
    await source.createProject({ envelope: recoveryEnvelope, records: goldenRecords() });
    const recoveryExpected = archivedProjectFor(
      await source.readProject("project_recovery"),
    ).document;
    const recoveryArchive = writePortableProjectArchive({ document: recoveryExpected }).archive;
    const recoveryTarget = join(root, "recovery.ocarchive");
    await writeFile(recoveryTarget, recoveryArchive);
    const recoveryHash = createHash("sha256").update(recoveryArchive).digest("hex");
    const hostileState = join(root, "hostile-fixture");
    await prepareArchiveProofFixture(hostileState);
    const hostileBaseline = await proofTreeHashes(hostileState);
    const marker = join(root, "external-marker.txt");
    await writeFile(marker, "preserved external native archive bytes");
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
    if (process.platform === "win32" && !windows)
      throw new Error("Windows OS directory unavailable");
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
    if (process.platform === "win32") {
      env.PATH = [
        join(windows!, "System32", "WindowsPowerShell", "v1.0"),
        join(windows!, "System32"),
        windows!,
      ].join(";");
    }
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Debug port unavailable");
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const child = spawn(
      process.platform === "darwin"
        ? join(root, "installed", "Open Chords.app", "Contents", "MacOS", "Open Chords")
        : join(root, "installed", "Open Chords.exe"),
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
    const nativeActionEvidence =
      process.platform === "darwin"
        ? { nativePress: true }
        : { nativeClick: true, defaultNameValid: false };
    const drive = async (scenario: "cancel_open" | "open", selectedPath = target) => {
      if (process.platform === "darwin") {
        if (child.pid === undefined) throw new Error("Installed native Open PID unavailable");
        await installedMacPickerDriver(
          scenario === "cancel_open" ? "cancel" : "open",
          scenario === "open" ? selectedPath : undefined,
          () => env,
        )(child.pid);
        return {
          action: scenario,
          filenameSet: scenario === "open",
          nativePress: true,
          dialogDismissed: true,
        };
      }
      return new Promise<unknown>((resolve, reject) => {
        const started = performance.now();
        execFile(
          join(windows!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
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
            selectedPath,
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
              console.log(installedSaveDriverTiming(stderr, performance.now() - started));
              resolve(JSON.parse(stdout.trim()));
            } catch {
              reject(new Error("Installed native Open driver returned invalid evidence"));
            }
          },
        );
      });
    };
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
          ...nativeActionEvidence,
          dialogDismissed: true,
        });
        await expect(status).toHaveText("Import cancelled");
        expect(await proofTreeHashes(library.activeRoot)).toEqual(baseline);
        await importButton.click();
        expect(await drive("open")).toEqual({
          action: "open",
          filenameSet: true,
          ...nativeActionEvidence,
          dialogDismissed: true,
        });
        await expect(status).toContainText("Project imported.", { timeout: 60000 });
        await expect(page.locator('.source-status[role="alert"]')).toBeVisible();
        const importedBaseline = await proofTreeHashes(library.activeRoot);
        await importButton.click();
        expect(await drive("open")).toEqual({
          action: "open",
          filenameSet: true,
          ...nativeActionEvidence,
          dialogDismissed: true,
        });
        await expect(status).toContainText(
          "This Library already contains this exact Project history.",
          { timeout: 60000 },
        );
        expect(await proofTreeHashes(library.activeRoot)).toEqual(importedBaseline);
        for (const [name, reason] of [
          ["traversal", "it contains unsafe file paths"],
          ["link", "it contains links or special files"],
          ["collision", "two entries have colliding names"],
          ["executable", "it contains executable or script content"],
          ["hash", "a file does not match its recorded hash"],
          ["future", "it was written by a newer or unsupported version"],
          ["size", "it exceeds the archive size limits"],
          ["encrypted", "it contains encrypted entries"],
        ] as const) {
          await test.step(`Native Open rejects ${name} without durable changes`, async () => {
            await importButton.click();
            expect(
              await drive("open", join(hostileState, "archive-proof-input", `${name}.ocarchive`)),
            ).toEqual({
              action: "open",
              filenameSet: true,
              ...nativeActionEvidence,
              dialogDismissed: true,
            });
            const alert = page.getByTestId("archives.import.alert");
            await expect(alert).toHaveText(
              `Archive rejected because ${reason}. Nothing was imported.`,
              { timeout: 60000 },
            );
            const message = await alert.textContent();
            expect(message?.includes(root)).toBe(false);
            expect(message?.includes(JSON.stringify(root).slice(1, -1))).toBe(false);
            expect(await proofTreeHashes(library.activeRoot)).toEqual(importedBaseline);
            expect(await proofTreeHashes(hostileState)).toEqual(hostileBaseline);
            expect(await readFile(marker, "utf8")).toBe("preserved external native archive bytes");
            for (const escaped of [join(root, "escape.json"), join(stateRoot, "escape.json")])
              await expect(lstat(escaped)).rejects.toMatchObject({ code: "ENOENT" });
          });
        }
        await test.step("Native Open recovers with a different valid Project after all refusals", async () => {
          await importButton.click();
          expect(await drive("open", recoveryTarget)).toEqual({
            action: "open",
            filenameSet: true,
            ...nativeActionEvidence,
            dialogDismissed: true,
          });
          await expect(status).toContainText("Project imported.", { timeout: 60000 });
          await expect(page.getByTestId("archives.import.alert")).toHaveCount(0);
          await expect(page.locator('.source-status[role="alert"]')).toBeVisible();
          expect(await proofTreeHashes(hostileState)).toEqual(hostileBaseline);
          expect(await readFile(marker, "utf8")).toBe("preserved external native archive bytes");
        });
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
    expect(reopened.listProjects().length).toBe(2);
    expect(
      canonicalSerialize(
        archivedProjectFor(await reopened.readProject("project_golden")).document,
      ) === canonicalSerialize(expected),
      "Cold Project must match the portable envelope and records",
    ).toBe(true);
    expect(reopened.listExportReceipts("project_golden").length).toBe(0);
    expect(
      canonicalSerialize(
        archivedProjectFor(await reopened.readProject("project_recovery")).document,
      ) === canonicalSerialize(recoveryExpected),
      "Cold recovery Project must match its portable envelope and records",
    ).toBe(true);
    expect(reopened.listExportReceipts("project_recovery").length).toBe(0);
    expect(
      createHash("sha256")
        .update(await readFile(recoveryTarget))
        .digest("hex"),
    ).toBe(recoveryHash);
    expect((await openNetworkMode(stateRoot)).offline).toBe(true);
    expect(await proofTreeHashes(hostileState)).toEqual(hostileBaseline);
    expect(await readFile(marker, "utf8")).toBe("preserved external native archive bytes");
    expect(
      createHash("sha256")
        .update(await readFile(target))
        .digest("hex"),
    ).toBe(archiveHash);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 40, retryDelay: 250 });
  }
});

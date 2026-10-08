import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { ProjectEnvelopeSchema } from "@open-chords/contracts";
import { captureJsonExport, serializeJsonExport } from "@open-chords/domain";
import { chromium, expect, test } from "@playwright/test";
import extractZip from "extract-zip";

import { openNetworkMode } from "../../apps/desktop/src/main/network-mode.ts";
import { inspectPortableProjectArchive } from "../../apps/desktop/src/main/project-archive-inspection.ts";
import { openProjectLibrary } from "../../apps/desktop/src/main/project-library.ts";
import { goldenRecords } from "../support/editor-fixture.ts";
import { leadSheetProject } from "../support/export-fixture.ts";
import { inspectPdf } from "../support/pdf-inspection.ts";

test.skip(
  process.platform !== "darwin" && process.platform !== "win32",
  "Installed desktop profiles",
);

test("installed application generates golden projections and reopens durable Export Receipts through the bounded capability", async () => {
  test.setTimeout(360000);
  const root = await realpath(await mkdtemp(join(tmpdir(), "oc-installed-export-")));
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
    envelope.payload.extensions = { "private.test": { path: root, token: "export-private-token" } };
    await library.createProject({ envelope, records: goldenRecords() });
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
    const executable =
      process.platform === "darwin"
        ? join(root, "installed", "Open Chords.app", "Contents", "MacOS", "Open Chords")
        : join(root, "installed", "Open Chords.exe");
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
    ]) {
      if (process.env[key]) env[key] = process.env[key];
    }
    if (process.platform === "win32") {
      const windows = process.env.SystemRoot ?? process.env.WINDIR;
      if (!windows) throw new Error("Windows OS directory unavailable");
      env.PATH = [
        join(windows, "System32", "WindowsPowerShell", "v1.0"),
        join(windows, "System32"),
        windows,
      ].join(";");
    }
    const { stdout, stderr } = await promisify(execFile)(
      executable,
      ["--open-chords-export-proof", `--user-data-dir=${stateRoot}`],
      { env, timeout: 120000, maxBuffer: 16384, windowsHide: true },
    );
    expect(JSON.parse(stdout.trim())).toEqual({
      proof: "installed-exports",
      cancelledWithoutRevision: true,
      durableReceipts: 5,
      rejectedUnchanged: 4,
      cancelledTargetUnchanged: true,
    });
    const outputRoot = join(root, "packaged-export-output");
    const outputBytes = await Promise.all(
      ["score.json", "song.ocarchive", "score.cho", "score.lrc", "score.pdf"].map((name) =>
        readFile(join(outputRoot, name)),
      ),
    );
    const receipts = (await openProjectLibrary({ stateRoot })).listExportReceipts("project_golden");
    for (const [index, receipt] of receipts.entries()) {
      expect(receipt.outputHash).toBe(
        `sha256:${createHash("sha256").update(outputBytes[index]!).digest("hex")}`,
      );
    }
    expect(outputBytes[0]!.toString()).toBe(
      serializeJsonExport(captureJsonExport(envelope.payload, { presentation: "current" })),
    );
    expect(outputBytes[2]!.toString()).toBe(
      await readFile("tests/fixtures/chordpro-golden.cho", "utf8"),
    );
    expect(outputBytes[3]!.toString()).toBe("[ti:project_golden]\n[00:00.41]home go\n");
    expect(createHash("sha256").update(outputBytes[4]!).digest("hex")).toBe(
      "3c834d61c9f05666fac4090bb5287fa676eaef34d94c463565c076f77a86cefa",
    );
    const pdf = await inspectPdf(outputBytes[4]!);
    expect(pdf.pages).toHaveLength(1);
    expect(pdf.pages[0]!.fonts.length).toBeGreaterThan(0);
    expect(pdf.pages[0]!.fonts.every((font) => font.embedded)).toBe(true);
    expect(pdf.pages[0]!.structure).toContain("H1");
    expect(pdf.info).toMatchObject({ Language: "en", Title: "project_golden" });
    const archived = inspectPortableProjectArchive(outputBytes[1]!).document;
    expect(archived.envelope.payload.id).toBe("project_golden");
    expect(archived.records.sources[0]!.locators).toEqual([]);
    expect(JSON.stringify(archived.records)).not.toContain(root);
    expect(archived.records.exportReceipts[0]!.outputLocation).toBe("score.json");
    for (const bytes of [
      outputBytes[0]!,
      outputBytes[2]!,
      outputBytes[3]!,
      outputBytes[4]!,
      Buffer.from(stdout + stderr),
    ]) {
      expect(bytes.includes(Buffer.from(root))).toBe(false);
      expect(bytes.includes(Buffer.from("export-private-token"))).toBe(false);
      expect(bytes.includes(Buffer.from("/unavailable/golden-fixture.wav"))).toBe(false);
    }
    for (const storedReceipt of receipts.filter((candidate) =>
      ["chordpro", "lrc", "pdf"].includes(candidate.format),
    )) {
      expect(storedReceipt.omissions).toContain("stable_identity_not_represented");
    }
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Debug port unavailable");
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const child = spawn(
      executable,
      [`--user-data-dir=${stateRoot}`, `--remote-debugging-port=${address.port}`],
      { stdio: "ignore", env },
    );
    let startupFailed = false;
    child.on("error", () => {
      startupFailed = true;
    });
    const assertAlive = () => {
      if (startupFailed || child.exitCode !== null || child.signalCode !== null)
        throw new Error("Installed export application exited before renderer readiness");
    };
    const endpoint = `http://127.0.0.1:${address.port}`;
    try {
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
            {
              timeout: 120000,
            },
          )
          .toBe(true);
        const page = context
          .pages()
          .find((candidate) => candidate.url().startsWith("open-chords://"))!;
        await page.getByRole("button", { name: "Export Project", exact: true }).click();
        await expect(page.getByText("score.json", { exact: true })).toBeVisible();
        await expect(page.getByText("song.ocarchive", { exact: true })).toBeVisible();
        await expect(
          page.getByRole("button", { name: "Save Project Archive", exact: true }),
        ).toBeEnabled();
        expect(await page.evaluate(() => typeof window.openChords!.archives.import)).toBe(
          "function",
        );
        const receipt = await page.evaluate(() =>
          window.openChords!.exports.perform({ type: "list", projectId: "project_golden" }),
        );
        expect(receipt).toMatchObject({
          type: "exports.result",
          receipts: [
            { displayName: "score.json", profileVersion: "open_chords_json/1.0/current" },
            { displayName: "song.ocarchive", profileVersion: "project_archive/1.0/no_media" },
            { displayName: "score.cho", profileVersion: "chordpro/1.0/current" },
            { displayName: "score.lrc", profileVersion: "lrc/1.0" },
            { displayName: "score.pdf", profileVersion: "pdf/1.0/a4/current" },
          ],
        });
        expect(JSON.stringify(receipt)).not.toContain(root);
        await page.getByRole("button", { name: "Close", exact: true }).click();
        await page.getByRole("button", { name: "Export Project", exact: true }).click();
        await expect(page.getByText("score.json", { exact: true })).toBeVisible();
        await page.getByRole("button", { name: "Close", exact: true }).click();
        await page.getByRole("button", { name: "Updates", exact: true }).click();
        const updateDialog = page.getByRole("dialog", { name: "Manual updates" });
        await expect(
          updateDialog.getByRole("button", { name: "Check for updates", exact: true }),
        ).toBeDisabled();
        expect(
          await page.evaluate(() => window.openChords!.updates.perform({ type: "check" })),
        ).toMatchObject({
          type: "updates.result",
          state: "offline",
          offline: true,
          checkedAt: null,
          release: null,
        });
        await updateDialog.getByRole("button", { name: "Close", exact: true }).click();
        const recovery = await page.evaluate(() =>
          window.openChords!.recovery.perform({ type: "inspect", projectId: "project_golden" }),
        );
        if (recovery.type !== "recovery.result" || !recovery.detail)
          throw new Error("Installed recovery metadata unavailable");
        const backupRevision = recovery.detail.revisions.at(-1)!;
        const inspectedRevisionId = recovery.detail.project.projectRevisionId!;
        expect(
          await page.evaluate(
            ({ target, expected }) =>
              window.openChords!.recovery.perform({
                type: "rollback",
                projectId: "project_golden",
                expectedProjectRevisionId: expected,
                targetProjectRevisionId: target,
                confirmedTargetProjectRevisionId: target,
              }),
            { target: backupRevision.projectRevisionId, expected: inspectedRevisionId },
          ),
        ).toMatchObject({
          type: "recovery.result",
          detail: {
            revisions: expect.arrayContaining([expect.objectContaining({ reason: "rollback" })]),
          },
        });
        expect(
          await page.evaluate(() =>
            window.openChords!.recovery.perform({ type: "inspect", projectId: "project_golden" }),
          ),
        ).toMatchObject({
          type: "recovery.result",
          detail: { project: { compatibility: "writable" } },
        });
        const cdp = await browser.newBrowserCDPSession();
        void cdp.send("Browser.close").catch(() => undefined);
        await expect
          .poll(() => child.exitCode !== null || child.signalCode !== null, { timeout: 15000 })
          .toBe(true);
        expect(
          (
            await (await openProjectLibrary({ stateRoot })).readProject("project_golden")
          ).revisions.at(-1)?.reason,
        ).toBe("rollback");
      } finally {
        await browser.close();
      }
    } finally {
      if (!startupFailed && child.exitCode === null && child.signalCode === null) {
        child.kill();
        await expect
          .poll(() => child.exitCode !== null || child.signalCode !== null, { timeout: 15000 })
          .toBe(true);
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 40, retryDelay: 250 });
  }
});

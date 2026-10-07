import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ProjectEnvelopeSchema } from "@open-chords/contracts";
import { chromium, expect, test } from "@playwright/test";
import extractZip from "extract-zip";

import { exportTarget, openProjectExports } from "../../apps/desktop/src/main/project-exports.ts";
import { openProjectLibrary } from "../../apps/desktop/src/main/project-library.ts";
import { goldenRecords } from "../support/editor-fixture.ts";

test.skip(
  process.platform !== "darwin" && process.platform !== "win32",
  "Installed desktop profiles",
);

test("installed application reopens durable JSON and archive Export Receipts through the bounded capability", async () => {
  test.setTimeout(120000);
  const root = await realpath(await mkdtemp(join(tmpdir(), "oc-installed-export-")));
  try {
    const stateRoot = join(root, "state");
    const library = await openProjectLibrary({ stateRoot });
    await library.createProject({
      envelope: ProjectEnvelopeSchema.parse(
        JSON.parse(
          readFileSync("packages/testkit/contracts/v1/valid/project-envelope.json", "utf8"),
        ),
      ),
      records: goldenRecords(),
    });
    // Prepare persisted input through the public service. This is a Receipt reopen test,
    // not evidence of an installed native save-dialog interaction.
    const service = await openProjectExports({
      library,
      stateRoot,
      pickTarget: async (format) =>
        join(
          root,
          format === "project_archive"
            ? "song.ocarchive"
            : `score.${exportTarget(format).extension}`,
        ),
    });
    expect(
      await service.saveJson({
        projectId: "project_golden",
        expectedProjectRevisionId: (await library.getSnapshot("project_golden"))!.projectRevisionId,
        presentation: "current",
      }),
    ).toEqual({ state: "saved" });
    expect(
      await service.saveArchive({
        projectId: "project_golden",
        expectedProjectRevisionId: (await library.getSnapshot("project_golden"))!.projectRevisionId,
        includeMedia: false,
      }),
    ).toEqual({ state: "saved" });
    for (const type of ["save_chordpro", "save_lrc", "save_pdf"] as const) {
      const request = {
        projectId: "project_golden",
        expectedProjectRevisionId: (await library.getSnapshot("project_golden"))!.projectRevisionId,
      };
      expect(
        (
          await service.perform(
            type === "save_lrc"
              ? { ...request, type }
              : { ...request, type, presentation: "current" },
          )
        ).state,
      ).toBe("saved");
    }
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
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Debug port unavailable");
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const child = spawn(
      executable,
      [`--user-data-dir=${stateRoot}`, `--remote-debugging-port=${address.port}`],
      { stdio: "ignore" },
    );
    const endpoint = `http://127.0.0.1:${address.port}`;
    try {
      await expect
        .poll(
          () =>
            fetch(`${endpoint}/json/version`).then(
              (response) => response.ok,
              () => false,
            ),
          { timeout: 30000 },
        )
        .toBe(true);
      const browser = await chromium.connectOverCDP(endpoint);
      try {
        const context = browser.contexts()[0]!;
        await expect
          .poll(() => context.pages().some((page) => page.url().startsWith("open-chords://")), {
            timeout: 30000,
          })
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
        const cdp = await browser.newBrowserCDPSession();
        void cdp.send("Browser.close").catch(() => undefined);
        await expect
          .poll(() => child.exitCode !== null || child.signalCode !== null, { timeout: 15000 })
          .toBe(true);
      } finally {
        await browser.close();
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
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

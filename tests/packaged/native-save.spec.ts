import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ProjectEnvelopeSchema } from "@open-chords/contracts";
import { canonicalSerialize, captureJsonExport, serializeJsonExport } from "@open-chords/domain";
import { chromium, expect, test } from "@playwright/test";
import extractZip from "extract-zip";

import { openNetworkMode } from "../../apps/desktop/src/main/network-mode.ts";
import { proofTreeHashes } from "../../apps/desktop/src/main/packaged-proof-tree.ts";
import { archivedProjectFor } from "../../apps/desktop/src/main/project-archive-format.ts";
import { inspectPortableProjectArchive } from "../../apps/desktop/src/main/project-archive-inspection.ts";
import { openProjectLibrary } from "../../apps/desktop/src/main/project-library.ts";
import { goldenRecords } from "../support/editor-fixture.ts";
import { leadSheetProject } from "../support/export-fixture.ts";
import { installedSaveDriverDiagnostic } from "../support/installed-save-diagnostics.ts";

test.skip(process.platform !== "win32", "Windows native Save dialog");

for (const format of ["json", "lrc", "chordpro", "pdf", "archive"] as const) {
  test(`installed Windows native ${format} Save cancellation preserves Library and Save publishes a durable receipt`, async () => {
    test.setTimeout(480000);
    const extension = format === "chordpro" ? "cho" : format === "archive" ? "ocarchive" : format;
    const saveButton = {
      json: "Save JSON",
      lrc: "Save LRC",
      chordpro: "Save ChordPro",
      pdf: "Save PDF",
      archive: "Save Project Archive",
    }[format];
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
      const archiveFixture =
        format === "archive"
          ? archivedProjectFor(await library.readProject("project_golden"))
          : undefined;
      const preservedTarget = join(root, `preserved.${extension}`);
      await writeFile(preservedTarget, "preserve existing external file");
      const target = join(root, `native-score.${extension}`);
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
      const drive = (scenario: "cancel" | "cancel_existing" | "save" | "open") =>
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
              format,
              "-TargetPath",
              scenario === "cancel_existing" ? preservedTarget : target,
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
          const baseline = await proofTreeHashes(library.activeRoot);
          await page.getByRole("button", { name: "Export Project", exact: true }).click();
          await page
            .getByRole("button", {
              name: saveButton,
              exact: true,
            })
            .click();
          expect(await drive("cancel")).toEqual({
            action: "cancel",
            filenameSet: false,
            nativeClick: true,
            dialogDismissed: true,
            defaultNameValid: true,
          });
          await expect(page.getByText("Export cancelled", { exact: true })).toBeVisible();
          expect(await proofTreeHashes(library.activeRoot)).toEqual(baseline);
          expect(await readFile(preservedTarget, "utf8")).toBe("preserve existing external file");
          await page
            .getByRole("button", {
              name: saveButton,
              exact: true,
            })
            .click();
          expect(await drive("cancel_existing")).toEqual({
            action: "cancel_existing",
            filenameSet: true,
            nativeClick: true,
            dialogDismissed: true,
            defaultNameValid: true,
          });
          await expect(page.getByText("Export cancelled", { exact: true })).toBeVisible();
          expect(await proofTreeHashes(library.activeRoot)).toEqual(baseline);
          expect(await readFile(preservedTarget, "utf8")).toBe("preserve existing external file");
          await page
            .getByRole("button", {
              name: saveButton,
              exact: true,
            })
            .click();
          expect(await drive("save")).toEqual({
            action: "save",
            filenameSet: true,
            nativeClick: true,
            dialogDismissed: true,
            defaultNameValid: true,
          });
          await expect(page.getByText("Export saved", { exact: true })).toBeVisible({
            timeout: 60000,
          });
          await expect(page.getByText(`native-score.${extension}`, { exact: true })).toBeVisible();
          if (format === "archive") {
            await test.step("Native Open recognizes the installed native Save archive without changes", async () => {
              const savedBaseline = await proofTreeHashes(library.activeRoot);
              const savedHash = createHash("sha256")
                .update(await readFile(target))
                .digest("hex");
              await page.getByTestId("archives.import.button").click();
              expect(await drive("open")).toEqual({
                action: "open",
                filenameSet: true,
                nativeClick: true,
                dialogDismissed: true,
                defaultNameValid: false,
              });
              await expect(page.getByTestId("archives.import.status")).toContainText(
                "This Library already contains this exact Project history.",
                { timeout: 60000 },
              );
              await expect(page.getByTestId("archives.import.alert")).toHaveCount(0);
              expect(await proofTreeHashes(library.activeRoot)).toEqual(savedBaseline);
              expect(
                createHash("sha256")
                  .update(await readFile(target))
                  .digest("hex"),
              ).toBe(savedHash);
              expect(await readFile(preservedTarget, "utf8")).toBe(
                "preserve existing external file",
              );
            });
          }
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
      const snapshot = captureJsonExport(envelope.payload, { presentation: "current" });
      if (format === "archive") {
        const inspected = inspectPortableProjectArchive(bytes);
        expect(
          canonicalSerialize(inspected.document) === canonicalSerialize(archiveFixture!.document),
          "Portable archive must preserve the expected envelope and records",
        ).toBe(true);
        expect(inspected.media === undefined, "Media must not be included").toBe(true);
      } else if (format === "pdf") {
        expect(createHash("sha256").update(bytes).digest("hex")).toBe(
          "3c834d61c9f05666fac4090bb5287fa676eaef34d94c463565c076f77a86cefa",
        );
        const { inspectPdf } = await import("../support/pdf-inspection.ts");
        const pdf = await inspectPdf(bytes);
        expect(pdf.info).toMatchObject({
          Language: "en",
          PDFFormatVersion: "1.7",
          Title: "project_golden",
        });
        expect(pdf.markInfo).toEqual(
          new Map([
            ["Marked", true],
            ["UserProperties", false],
            ["Suspects", false],
          ]),
        );
        expect(pdf.pages.length).toBeGreaterThan(0);
        expect(
          pdf.pages.every(
            (page) => page.fonts.length > 0 && page.fonts.every((font) => font.embedded),
          ),
        ).toBe(true);
      } else {
        expect(bytes.toString()).toBe(
          format === "json"
            ? serializeJsonExport(snapshot)
            : format === "lrc"
              ? "[ti:project_golden]\n[00:00.41]home go\n"
              : await readFile("tests/fixtures/chordpro-golden.cho", "utf8"),
        );
      }
      const omissions =
        format === "archive"
          ? archiveFixture!.omissions
          : format === "json"
            ? [...snapshot.omissions].sort()
            : format !== "lrc"
              ? [
                  "abstained_chord_marked_unknown",
                  "analysis_provenance_not_represented",
                  "chord_diagram_unavailable:Gm9add9add11/D",
                  "chord_symbol_not_portable:Gm9add9add11/D",
                  "confidence_not_represented",
                  "edit_history_not_represented",
                  "lyrics_mismatch_not_represented",
                  "sample_timing_not_represented",
                  "stable_identity_not_represented",
                  "support_claim_descriptions_omitted",
                  "unmetered_seconds_not_represented",
                  "unrecognized_lyrics_reference_omitted",
                ]
              : [
                  "analysis_provenance_not_represented",
                  "confidence_not_represented",
                  "edit_history_not_represented",
                  "line_end_timing_not_represented",
                  "lrc_line_coverage:1/2",
                  "lrc_line_omitted:unmatched:line_first",
                  "lyrics_mismatch_not_represented",
                  "lyrics_notices_not_represented",
                  "sample_timing_not_represented",
                  "stable_identity_not_represented",
                  "support_claim_descriptions_omitted",
                  "unrecognized_lyrics_reference_omitted",
                  "word_timing_not_represented",
                ];
      const reopened = await openProjectLibrary({ stateRoot });
      const receipts = reopened.listExportReceipts("project_golden");
      expect(receipts.length).toBe(1);
      if (format === "archive")
        expect(receipts[0]?.profileVersion).toBe("project_archive/1.0/no_media");
      expect(
        receipts[0]?.outputLocation === target,
        "Receipt must retain the exact destination",
      ).toBe(true);
      expect(
        receipts.map(({ format: receiptFormat, outputHash, omissions: receiptOmissions }) => ({
          format: receiptFormat,
          outputHash,
          omissions: receiptOmissions,
        })),
      ).toEqual([
        {
          format:
            format === "json"
              ? "open_chords_json"
              : format === "archive"
                ? "project_archive"
                : format,
          omissions,
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
}

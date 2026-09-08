import { readFileSync } from "node:fs";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ProjectEnvelopeSchema } from "@open-chords/contracts";
import { _electron as electron, expect, test, type Locator } from "@playwright/test";
import axe from "axe-core";

import { openProjectLibrary } from "../../apps/desktop/src/main/project-library.ts";
import { goldenRecords } from "../support/editor-fixture.ts";

declare global {
  interface Window {
    axe?: typeof axe;
  }
}

const repositoryRoot = join(import.meta.dirname, "../..");

for (const profile of [
  { name: "1080 CSS pixels", width: 1080, zoom: 1, spacing: false, contrast: false },
  { name: "320 CSS pixels", width: 320, zoom: 1, spacing: false, contrast: false },
  { name: "200 percent desktop zoom", width: 1080, zoom: 2, spacing: false, contrast: false },
  { name: "320 CSS pixels with text spacing", width: 320, zoom: 1, spacing: true, contrast: false },
  {
    name: "forced colors and reduced motion",
    width: 1080,
    zoom: 1,
    spacing: false,
    contrast: true,
  },
]) {
  test(`workspace controls remain accessible and reflow at ${profile.name}`, async () => {
    test.setTimeout(60_000);
    const stateRoot = await realpath(await mkdtemp(join(tmpdir(), "open-chords-accessibility-")));
    const envelope = ProjectEnvelopeSchema.parse(
      JSON.parse(
        readFileSync(
          join(repositoryRoot, "packages/testkit/contracts/v1/valid/project-envelope.json"),
          "utf8",
        ),
      ),
    );
    const library = await openProjectLibrary({ stateRoot });
    await library.createProject({ envelope, records: goldenRecords() });
    const environment: Record<string, string> = {};
    for (const [name, value] of Object.entries(process.env)) {
      if (name !== "ELECTRON_RUN_AS_NODE" && value !== undefined) environment[name] = value;
    }
    const application = await electron.launch({
      args: [repositoryRoot, `--user-data-dir=${stateRoot}`],
      env: environment,
    });
    try {
      const page = await application.firstWindow();
      const tabTo = async (target: Locator) => {
        await expect(target).toBeVisible();
        await expect(target).toBeEnabled();
        for (let attempt = 0; attempt < 160; attempt++) {
          if (await target.evaluate((element) => element === document.activeElement)) break;
          await page.keyboard.press("Tab");
        }
        await expect(target).toBeFocused();
        const bounds = await target.evaluate((element) => ({
          rect: element.getBoundingClientRect().toJSON(),
          width: innerWidth,
          height: innerHeight,
        }));
        await expect(target, JSON.stringify(bounds)).toBeInViewport({ ratio: 1 });
        expect(
          await target.evaluate((element) => {
            const rect = element.getBoundingClientRect();
            const center = document.elementFromPoint(
              rect.x + rect.width / 2,
              rect.y + rect.height / 2,
            );
            return center !== null && element.contains(center);
          }),
          "Focused control must not be covered",
        ).toBe(true);
      };
      const activate = async (target: Locator) => {
        await tabTo(target);
        await page.keyboard.press("Enter");
      };
      const selectIndex = async (target: Locator, index: number) => {
        await tabTo(target);
        const selectedIndex = () =>
          target.evaluate((element) => {
            if (!(element instanceof HTMLSelectElement)) throw new Error("Expected native select");
            return element.selectedIndex;
          });
        const initial = (await target.locator("option").nth(index).textContent())!.trim()[0]!;
        for (let attempt = 0; attempt < 20 && (await selectedIndex()) !== index; attempt++) {
          const before = await selectedIndex();
          await page.keyboard.press(initial);
          await expect.poll(selectedIndex).not.toBe(before);
        }
        expect(await selectedIndex()).toBe(index);
      };
      await page.setViewportSize({ width: profile.width, height: 900 });
      await application.evaluate(({ BrowserWindow }, zoom) => {
        BrowserWindow.getAllWindows()[0]!.webContents.setZoomFactor(zoom);
      }, profile.zoom);
      if (profile.contrast)
        await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
      await expect(page.getByRole("heading", { name: "Musical timeline" })).toBeVisible();
      const captureSession = await page.context().newCDPSession(page);
      const audit = async (name: string) => {
        if (profile.spacing)
          await page.evaluate(() => {
            for (const element of document.querySelectorAll<HTMLElement>("body *")) {
              element.style.setProperty("line-height", "1.5", "important");
              element.style.setProperty("letter-spacing", "0.12em", "important");
              element.style.setProperty("word-spacing", "0.16em", "important");
              if (element.tagName === "P")
                element.style.setProperty("margin-bottom", "2em", "important");
            }
          });
        const screenshotPath = test.info().outputPath(`${name}.png`);
        if (profile.zoom === 1) await page.screenshot({ path: screenshotPath, fullPage: true });
        else {
          // Electron zoom changes CSS pixels; CDP screenshot clips use unzoomed DIP coordinates.
          const size = await page.evaluate(() => ({
            width: document.documentElement.scrollWidth,
            height: document.documentElement.scrollHeight,
          }));
          const capture = await captureSession.send("Page.captureScreenshot", {
            format: "png",
            captureBeyondViewport: true,
            clip: {
              x: 0,
              y: 0,
              width: size.width * profile.zoom,
              height: size.height * profile.zoom,
              scale: 1,
            },
          });
          await writeFile(screenshotPath, Buffer.from(capture.data, "base64"));
        }
        await test.info().attach(`${name}.png`, { path: screenshotPath, contentType: "image/png" });
        expect(
          await page
            .locator("button, .lyric-line")
            .evaluateAll((elements) =>
              elements
                .filter(
                  (element) =>
                    !element.closest(".timeline-viewport") &&
                    element.getBoundingClientRect().width > 0 &&
                    element.scrollWidth > element.clientWidth + 1,
                )
                .map((element) => element.getAttribute("aria-label") ?? element.textContent),
            ),
          `${name} control/lyric text must not be clipped`,
        ).toEqual([]);
        const overflow = await page.evaluate(() =>
          [...document.querySelectorAll("button, input, select, fieldset, label")]
            .filter(
              (element) =>
                !element.closest(".timeline-viewport") &&
                element.getBoundingClientRect().right > innerWidth + 1,
            )
            .map((element) => ({
              tag: element.tagName,
              text: element.textContent?.slice(0, 80),
              right: element.getBoundingClientRect().right,
            })),
        );
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth),
          `${name} document reflow: ${JSON.stringify(overflow)}`,
        ).toBeLessThanOrEqual(await page.evaluate(() => innerWidth));
        await page.evaluate(axe.source);
        const result = await page.evaluate(async (forcedColors) => {
          const engine = window.axe;
          if (!engine) throw new Error("axe did not load");
          return engine.run(document, {
            // axe mixes original text-fill with forced backgrounds: dequelabs/axe-core#3978.
            // All ordinary profiles retain contrast checks; forced-color screenshots require review.
            rules: {
              "target-size": { enabled: true },
              ...(forcedColors ? { "color-contrast": { enabled: false } } : {}),
            },
            runOnly: {
              type: "tag",
              values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"],
            },
          });
        }, profile.contrast);
        const resultPath = test.info().outputPath(`${name}-axe.json`);
        await writeFile(resultPath, JSON.stringify(result, null, 2));
        await test.info().attach(`${name}-axe.json`, {
          path: resultPath,
          contentType: "application/json",
        });
        expect(
          result.violations.map(({ id, nodes }) => ({
            id,
            nodes: nodes.map(({ target, failureSummary }) => ({ target, failureSummary })),
          })),
        ).toEqual([]);
      };
      await audit("workspace");
      await activate(page.getByRole("button", { name: "Edit chords", exact: true }));
      await expect(page.getByRole("region", { name: "Chord Editor", exact: true })).toBeVisible();
      await audit("chord-editor");
      if (profile.name === "1080 CSS pixels") {
        const editor = page.getByRole("region", { name: "Chord Editor", exact: true });
        await expect(editor).toBeFocused();
        const choose = editor.getByRole("button", { name: "Choose chord", exact: true }).first();
        await activate(choose);
        await page.keyboard.press("Escape");
        await expect(choose).toBeFocused();
        await tabTo(editor.getByRole("combobox", { name: "Duration", exact: true }).first());
        await page.keyboard.press("0");
        await page.keyboard.press("Enter");
        await expect(editor.getByRole("alert")).toContainText("fill the saved span");
        await expect(
          editor.getByRole("group", { name: "Draft events", exact: true }),
        ).toHaveAccessibleDescription(/fill the saved span/);
        const duration = editor.getByRole("combobox", { name: "Duration", exact: true }).first();
        await expect(duration).toHaveAttribute("aria-invalid", "true");
        await expect(duration).toHaveAccessibleDescription(/fill the saved span/);
        await expect(editor.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
        await audit("invalid-draft");
        await activate(editor.getByRole("button", { name: "Reset draft", exact: true }));
        await expect(editor.getByRole("alert")).toHaveCount(0);
        await expect(duration).not.toHaveAttribute("aria-invalid", "true");
        await expect(duration).toHaveAccessibleDescription("");
        await expect(
          editor.getByRole("group", { name: "Draft events", exact: true }),
        ).toHaveAccessibleDescription("");
        await expect(
          editor.getByRole("button", { name: "Reset draft", exact: true }),
        ).toBeFocused();
        await page.keyboard.press("Escape");
        await expect(page.getByRole("button", { name: "Edit chords", exact: true })).toBeFocused();
        await page.keyboard.press("Enter");
        const pickup = page.getByRole("button", { name: /Pickup, 4\/4/ });
        const originalLabel = await pickup.getAttribute("aria-label");
        const moved = editor.locator('[data-event-id="chord_am7_e"]');
        await selectIndex(moved.getByRole("combobox", { name: "Move target", exact: true }), 3);
        const moveAfter = moved.getByRole("button", { name: "Move after", exact: true });
        await activate(moveAfter);
        await expect(moveAfter).toBeFocused();
        await expect(moved.getByRole("status")).toContainText("Chord moved after");
        await expect(editor.getByRole("listitem").last()).toHaveAttribute(
          "data-event-id",
          "chord_am7_e",
        );
        await audit("reordered-draft");
        await activate(editor.getByRole("button", { name: "Reset draft", exact: true }));
        await expect(editor.getByRole("listitem").first()).toHaveAttribute(
          "data-event-id",
          "chord_am7_e",
        );
        await activate(editor.getByRole("button", { name: "Mark reviewed", exact: true }));
        await expect(
          editor.getByRole("button", { name: "Reviewed in draft", exact: true }),
        ).toBeDisabled();
        await activate(choose);
        await expect(editor.getByRole("combobox", { name: "Root", exact: true })).toBeFocused();
        await page.keyboard.press("n");
        await page.keyboard.press("Enter");
        await expect(editor.getByRole("combobox", { name: "Root", exact: true })).toHaveValue("N");
        await activate(editor.getByRole("button", { name: "Done", exact: true }));
        await expect(choose).toBeFocused();
        await audit("changed-draft");
        await activate(editor.getByRole("button", { name: "Save", exact: true }));
        await expect(page.getByRole("button", { name: "Edit chords", exact: true })).toBeFocused();
        await expect(pickup).toHaveAttribute("aria-label", /Chords: N/);
        await audit("saved-edit");
        await activate(page.getByRole("button", { name: "Undo edit", exact: true }));
        await expect(pickup).toHaveAttribute("aria-label", originalLabel!);
        await selectIndex(page.getByLabel("Redo branch", { exact: true }), 2);
        await activate(page.getByRole("button", { name: "Redo edit", exact: true }));
        await expect(pickup).toHaveAttribute("aria-label", /Chords: N/);
        await activate(page.getByRole("button", { name: "Reset saved edits", exact: true }));
        await expect(pickup).toHaveAttribute("aria-label", originalLabel!);
        await activate(page.getByRole("button", { name: "Set loop from selection", exact: true }));
        await selectIndex(page.getByRole("combobox", { name: "Count-in", exact: true }), 1);
        await expect(page.getByRole("combobox", { name: "Count-in", exact: true })).toHaveValue(
          "1",
        );
        await tabTo(page.getByRole("checkbox", { name: "Metronome", exact: true }));
        await page.keyboard.press("Space");
        await expect(page.getByRole("checkbox", { name: "Metronome", exact: true })).toBeChecked();
        await audit("practice-settings");
        await activate(page.getByRole("button", { name: "Clear loop", exact: true }));
        await activate(page.getByRole("button", { name: "Edit chords", exact: true }));
      }
      await activate(page.getByRole("button", { name: "Cancel", exact: true }));
      await expect(page.getByRole("button", { name: "Edit chords", exact: true })).toBeFocused();
      await activate(page.getByRole("button", { name: "Choose lyrics", exact: true }));
      await audit("lyrics-selection");
      await activate(page.getByRole("button", { name: "Choose lyrics", exact: true }));
      await activate(page.getByRole("button", { name: "Lyrics timing", exact: true }));
      await audit("lyrics-timing");
      if (profile.name === "1080 CSS pixels") {
        const panel = page.getByRole("region", { name: "Lyrics timing correction", exact: true });
        const occurrence = panel.getByRole("combobox", { name: "Timing occurrence", exact: true });
        await selectIndex(occurrence, 1);
        await activate(panel.getByRole("button", { name: "Mark untimed", exact: true }));
        await expect(panel.getByRole("status")).toHaveText("Timing correction saved");
        await audit("timing-corrected");
        await activate(page.getByRole("button", { name: "Undo edit", exact: true }));
        await expect(occurrence.locator("option").nth(1)).not.toContainText(
          "user_marked_unmatched",
        );
        const redo = page.getByLabel("Redo branch", { exact: true });
        await selectIndex(redo, (await redo.locator("option").count()) - 1);
        await activate(page.getByRole("button", { name: "Redo edit", exact: true }));
        await expect(occurrence.locator("option").nth(1)).toContainText("user_marked_unmatched");
        const snapshot = await page.evaluate(() =>
          window.openChords!.project.getSnapshot("project_golden"),
        );
        if (snapshot.type !== "project.snapshot") throw new Error("Snapshot unavailable");
        expect(snapshot.project.lyricsDocuments).toEqual(envelope.payload.lyricsDocuments);
        expect(snapshot.project.analysisRevisions).toEqual(envelope.payload.analysisRevisions);
      }
      await activate(page.getByRole("button", { name: "Lyrics timing", exact: true }));
      await activate(page.getByRole("button", { name: "Alignment packs", exact: true }));
      await expect(page.getByRole("dialog")).toBeVisible();
      await audit("alignment-packs");
      await activate(page.getByRole("button", { name: "Close", exact: true }));
      await expect(
        page.getByRole("button", { name: "Alignment packs", exact: true }),
      ).toBeFocused();
      await activate(page.getByRole("button", { name: "Choose lyrics", exact: true }));
      await tabTo(page.getByRole("textbox", { name: "Lyrics text", exact: true }));
      await page.keyboard.press("ControlOrMeta+A");
      await page.keyboard.insertText("Привет мир");
      await tabTo(page.getByRole("textbox", { name: "Lyrics language", exact: true }));
      await page.keyboard.press("ControlOrMeta+A");
      await page.keyboard.insertText("ru");
      await activate(page.getByRole("button", { name: "Save new Lyrics Document", exact: true }));
      await expect(page.getByRole("status", { name: "Lyrics selection status" })).toHaveText(
        "Lyrics saved",
      );
      await expect(page.getByRole("group", { name: "Привет мир", exact: true })).toHaveAttribute(
        "lang",
        "ru",
      );
      await expect(page.locator("html")).toHaveAttribute("lang", "en");
    } finally {
      await application.close();
      await rm(stateRoot, { recursive: true, force: true });
    }
  });
}

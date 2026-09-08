import { readFileSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
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
        for (let attempt = 0; attempt < 160; attempt++) {
          if (await target.evaluate((element) => element === document.activeElement)) break;
          await page.keyboard.press("Tab");
        }
        await expect(target).toBeFocused();
        await expect(target).toBeInViewport();
      };
      const activate = async (target: Locator) => {
        await tabTo(target);
        await page.keyboard.press("Enter");
      };
      await page.setViewportSize({ width: profile.width, height: 900 });
      await application.evaluate(({ BrowserWindow }, zoom) => {
        BrowserWindow.getAllWindows()[0]!.webContents.setZoomFactor(zoom);
      }, profile.zoom);
      if (profile.contrast)
        await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
      await expect(page.getByRole("heading", { name: "Musical timeline" })).toBeVisible();
      const audit = async (name: string) => {
        if (profile.contrast)
          await test.info().attach(`${name}-forced-colors.png`, {
            body: await page.screenshot({ fullPage: true }),
            contentType: "image/png",
          });
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
        await test.info().attach(`${name}-axe.json`, {
          body: JSON.stringify(result),
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
        await expect(editor.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
        await audit("invalid-draft");
        await activate(editor.getByRole("button", { name: "Reset draft", exact: true }));
        await expect(editor.getByRole("alert")).toHaveCount(0);
        await expect(
          editor.getByRole("group", { name: "Draft events", exact: true }),
        ).toHaveAccessibleDescription("");
        await expect(
          editor.getByRole("button", { name: "Reset draft", exact: true }),
        ).toBeFocused();
        await page.keyboard.press("Escape");
        await expect(page.getByRole("button", { name: "Edit chords", exact: true })).toBeFocused();
        await page.keyboard.press("Enter");
      }
      await activate(page.getByRole("button", { name: "Cancel", exact: true }));
      await expect(page.getByRole("button", { name: "Edit chords", exact: true })).toBeFocused();
      await activate(page.getByRole("button", { name: "Choose lyrics", exact: true }));
      await audit("lyrics-selection");
      await activate(page.getByRole("button", { name: "Choose lyrics", exact: true }));
      await activate(page.getByRole("button", { name: "Lyrics timing", exact: true }));
      await audit("lyrics-timing");
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

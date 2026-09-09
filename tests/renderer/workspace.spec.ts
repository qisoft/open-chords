import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, realpath, rm, writeFile, readFile } from "node:fs/promises";
import { cpus, platform, release, tmpdir, totalmem } from "node:os";
import { join } from "node:path";

import {
  DESKTOP_IPC_CHANNELS,
  DesktopResponseSchema,
  ProjectEnvelopeSchema,
  type ProjectSnapshotResponse,
} from "@open-chords/contracts";
import { addLyricsDocument } from "@open-chords/domain";
import { monoPcmWav } from "@open-chords/testkit/media";
import { _electron as electron, expect, test } from "@playwright/test";

import { LocalMediaService } from "../../apps/desktop/src/main/local-media.ts";
import { openProjectLibrary } from "../../apps/desktop/src/main/project-library.ts";
import { goldenRecords } from "../support/editor-fixture.ts";

const repositoryRoot = join(import.meta.dirname, "../..");

test("an invalid Alignment cleanup journal leaves the desktop available and preserves recovery evidence", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "oc-alignment-recovery-"));
  const journal = join(stateRoot, "alignment-workspaces");
  await mkdir(journal);
  const marker = join(journal, "invalid-marker");
  await writeFile(marker, "interrupted");
  const application = await launch(stateRoot);
  try {
    const page = await application.firstWindow();
    await expect
      .poll(() => page.evaluate(async () => (await window.openChords?.project.list())?.type))
      .toBe("project.list");
    const response = await page.evaluate(() =>
      window.openChords!.alignment.perform({ type: "status", projectId: "project_missing" }),
    );
    expect(response).toMatchObject({ type: "desktop.error", code: "capability_unavailable" });
    expect(await readFile(marker, "utf8")).toBe("interrupted");
  } finally {
    await application.close();
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("a durable local-media Project reopens into the centered workspace and plays", async () => {
  const userDataDirectory = await realpath(
    await mkdtemp(join(tmpdir(), "open-chords-workspace-media-")),
  );
  const mediaPath = join(userDataDirectory, "recording.wav");
  await writeFile(mediaPath, monoPcmWav(Array.from({ length: 240_000 }, (_, index) => index % 64)));
  const library = await openProjectLibrary({ stateRoot: userDataDirectory });
  const media = new LocalMediaService({ library, pickFile: async () => mediaPath });
  media.activateGeneration("generation_seed");
  const selected = await media.pickLocalFile("generation_seed");
  if (selected.kind !== "selected") throw new Error("Local fixture selection failed");
  await media.createProject({
    capabilityId: selected.capabilityId,
    endSourceSample: 96_000,
    generationId: "generation_seed",
    startSourceSample: 48_000,
  });
  await media.dispose();

  const application = await launch(userDataDirectory);
  try {
    const page = await application.firstWindow();
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await expect(page.getByRole("heading", { name: "Local Project" })).toBeVisible();
    await expect(page).toHaveTitle(/project_.+ · Local Project · Open Chords/);
    await expect(page.getByRole("heading", { name: "Musical timeline" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Unanalyzed Project range/ })).toBeVisible();
    await expect(page.getByText("Verified local playback")).toBeVisible();
    await expect(page.getByRole("status", { name: "Current Project Time" })).toHaveText("0:00");

    const position = page.getByRole("slider", { name: "Project position", exact: true });
    await expect(position).toBeVisible();
    await position.focus();
    await position.press("End");
    await expect(position).toHaveValue("48000");
    await position.press("Home");
    await expect(position).toHaveValue("0");
    const viewport = await page.locator(".timeline-viewport").boundingBox();
    if (viewport === null) throw new Error("Timeline viewport is missing");
    const center = viewport.x + viewport.width / 2;
    await page.mouse.click(center + viewport.width / 4, viewport.y + 12);
    await expect.poll(async () => Number(await position.inputValue())).toBeCloseTo(12000, -2);
    await page.getByRole("slider", { name: "Timeline zoom" }).fill("2");
    await page.mouse.move(center, viewport.y + 12);
    await page.mouse.down();
    await page.mouse.move(center - viewport.width / 4, viewport.y + 12, { steps: 4 });
    await page.mouse.up();
    await expect.poll(async () => Number(await position.inputValue())).toBeCloseTo(18000, -2);
    await position.focus();
    await position.press("Home");

    const play = page.getByRole("button", { name: "Play" });
    await expect(play).toBeEnabled();
    await expect(page.getByRole("button", { name: "Set loop from selection" })).toBeDisabled();
    await play.hover();
    await expect(page.getByRole("tooltip", { name: "Play" })).toBeVisible();
    const playBounds = await play.boundingBox();
    const playheadBounds = await page.locator(".fixed-playhead").boundingBox();
    if (playBounds === null || playheadBounds === null) {
      throw new Error("Playback geometry is unavailable");
    }
    expect(
      Math.abs(playBounds.x + playBounds.width / 2 - (playheadBounds.x + playheadBounds.width / 2)),
    ).toBeLessThan(1);
    const before = await page.locator(".timeline-track").getAttribute("style");
    await play.click();
    await expect(page.getByRole("button", { name: "Pause" })).toBeVisible();
    await expect.poll(() => page.locator(".timeline-track").getAttribute("style")).not.toBe(before);
    await expect(page.getByRole("button", { name: "Play" })).toBeVisible({ timeout: 3_000 });
    await expect(page.getByRole("status", { name: "Current Project Time" })).toHaveText("0:01");
    const endPosition = await page.locator(".timeline-track").getAttribute("style");
    await page.getByRole("button", { name: "Play" }).click();
    await expect(page.getByRole("button", { name: "Pause" })).toBeVisible();
    await expect
      .poll(() => page.locator(".timeline-track").getAttribute("style"))
      .not.toBe(endPosition);
    await page.getByRole("button", { name: "Pause" }).click();
    await page.emulateMedia({ reducedMotion: "reduce", forcedColors: "active" });
    await position.focus();
    await position.press("Home");
    const reducedStart = await page.locator(".timeline-track").getAttribute("style");
    await page.getByRole("button", { name: "Play" }).click();
    await expect.poll(async () => Number(await position.inputValue())).toBeGreaterThan(12000);
    await expect(page.locator(".timeline-track")).toHaveAttribute("style", reducedStart!);
    await expect(position).toHaveAttribute("aria-valuetext", /of 1.00 seconds/);
    await page.getByRole("button", { name: "Pause" }).click();
    await page.emulateMedia({ reducedMotion: "no-preference", forcedColors: "none" });
    await page.evaluate(() => {
      Object.defineProperty(HTMLMediaElement.prototype, "play", {
        configurable: true,
        value: () => Promise.reject(new DOMException("Playback blocked", "NotAllowedError")),
      });
    });
    await page.getByRole("button", { name: "Play" }).click();
    await expect(page.getByRole("alert")).toContainText(
      "Playback could not start. Check the verified Source.",
    );
    await page.mouse.move(0, 0);
    await expect(page.getByRole("tooltip")).toBeHidden();

    await page.setViewportSize({ height: 720, width: 360 });
    const overflowOutsideTimeline = await page.evaluate(() =>
      [...document.querySelectorAll("*")]
        .filter(
          (element) =>
            element.closest(".timeline-viewport") === null &&
            element.getBoundingClientRect().right > window.innerWidth + 1,
        )
        .map((element) => element.getAttribute("class") ?? element.tagName),
    );
    expect(overflowOutsideTimeline).toEqual([]);
  } finally {
    await application.close();
    await rm(userDataDirectory, { force: true, recursive: true });
  }
});

test("a low-confidence chord can be reviewed without changing its value and undone", async () => {
  const stateRoot = await realpath(await mkdtemp(join(tmpdir(), "open-chords-editor-review-")));
  const library = await openProjectLibrary({ stateRoot });
  const envelope = ProjectEnvelopeSchema.parse(
    JSON.parse(
      readFileSync(
        join(repositoryRoot, "packages/testkit/contracts/v1/valid/project-envelope.json"),
        "utf8",
      ),
    ),
  );
  await library.createProject({ envelope, records: goldenRecords() });
  const application = await launch(stateRoot);
  try {
    const page = await application.firstWindow();
    await page.getByRole("button", { name: "Edit chords", exact: true }).click();
    const editor = page.getByRole("region", { name: "Chord Editor" });
    await editor
      .locator('[data-event-id="chord_g7"]')
      .getByRole("button", { name: "Mark reviewed", exact: true })
      .click();
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await expect(editor).toHaveCount(0);
    await page.getByRole("button", { name: "Edit chords", exact: true }).click();
    await expect(
      editor
        .locator('[data-event-id="chord_g7"]')
        .getByRole("button", { name: "Mark reviewed", exact: true }),
    ).toHaveCount(0);
    await editor.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.getByRole("button", { name: "Undo edit", exact: true }).click();
    await expect(page.getByRole("button", { name: "Undo edit", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "Edit chords", exact: true }).click();
    await expect(
      editor
        .locator('[data-event-id="chord_g7"]')
        .getByRole("button", { name: "Mark reviewed", exact: true }),
    ).toBeEnabled();
  } finally {
    await application.close();
    await rm(stateRoot, { force: true, recursive: true });
  }
});

test("an external committed revision invalidates an open draft even after draft Reset", async () => {
  const stateRoot = await realpath(await mkdtemp(join(tmpdir(), "open-chords-editor-stale-")));
  const library = await openProjectLibrary({ stateRoot });
  const envelope = ProjectEnvelopeSchema.parse(
    JSON.parse(
      readFileSync(
        join(repositoryRoot, "packages/testkit/contracts/v1/valid/project-envelope.json"),
        "utf8",
      ),
    ),
  );
  await library.createProject({ envelope, records: goldenRecords() });
  const application = await launch(stateRoot);
  try {
    const page = await application.firstWindow();
    await page.getByRole("button", { name: "Edit chords", exact: true }).click();
    const editor = page.getByRole("region", { name: "Chord Editor" });
    await editor.getByRole("button", { name: "Choose chord" }).first().click();
    await editor.getByLabel("Root").selectOption("N");
    await editor.getByRole("button", { name: "Done", exact: true }).click();
    const response = await page.evaluate(async () => {
      const saved = await window.openChords!.project.getSnapshot("project_golden");
      if (saved.type !== "project.snapshot") throw new Error("Snapshot unavailable");
      return window.openChords!.project.commitEditTransaction({
        projectId: saved.project.id,
        expectedProjectRevisionId: saved.projectRevisionId,
        transaction: {
          id: "transaction_external",
          parentTransactionId: null,
          operations: [
            { type: "replace_chord_value", eventId: "chord_g7", value: { kind: "no_chord" } },
          ],
        },
      });
    });
    expect(response.type).toBe("project.committed");
    const staleAlert = editor.getByRole("alert").filter({ hasText: "revision changed" });
    await expect(staleAlert).toBeVisible();
    await expect(editor.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
    await editor.getByRole("button", { name: "Reset draft", exact: true }).click();
    await expect(staleAlert).toBeVisible();
    await editor.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.getByRole("button", { name: "Edit chords", exact: true }).click();
    await expect(staleAlert).toHaveCount(0);
    await expect(editor.getByRole("alert")).toBeEmpty();
    await expect(editor.locator('[data-event-id="chord_g7"] strong')).toHaveText("N");
  } finally {
    await application.close();
    await rm(stateRoot, { force: true, recursive: true });
  }
});

test("review mappings retain conflicts until every event is explicitly matched", async () => {
  const stateRoot = await realpath(await mkdtemp(join(tmpdir(), "open-chords-editor-map-")));
  const library = await openProjectLibrary({ stateRoot });
  const envelope = ProjectEnvelopeSchema.parse(
    JSON.parse(
      readFileSync(
        join(repositoryRoot, "packages/testkit/contracts/v1/valid/project-envelope.json"),
        "utf8",
      ),
    ),
  );
  envelope.payload.activeView!.editHistoryPosition = 1;
  await library.createProject({ envelope, records: goldenRecords() });
  const application = await launch(stateRoot);
  try {
    const page = await application.firstWindow();
    await page
      .getByRole("button", { name: "Review edits on another analysis", exact: true })
      .click();
    const review = page.getByRole("region", { name: "Review edit mappings" });
    await review.getByLabel("Target analysis").selectOption("revision_reviewable");
    await expect(review.getByRole("button", { name: "Apply reviewed edits" })).toBeDisabled();
    await expect(review.getByRole("alert")).toContainText("Choose a matching entity");
    await review.getByLabel("Match chord_am7_e").selectOption("chord_reviewable");
    await review.getByRole("button", { name: "Apply reviewed edits" }).click();
    await expect(review).toHaveCount(0);
    const snapshot = await page.evaluate(async () =>
      window.openChords!.project.getSnapshot("project_golden"),
    );
    if (snapshot.type !== "project.snapshot") throw new Error("Snapshot unavailable");
    expect(snapshot.project.activeView!.analysisRevisionId).toBe("revision_reviewable");
    expect(snapshot.project.analysisRevisions).toEqual(envelope.payload.analysisRevisions);
  } finally {
    await application.close();
    await rm(stateRoot, { force: true, recursive: true });
  }
});

test("editor reorders first and last events with keyboard and pointer without overflowing the page", async () => {
  const stateRoot = await realpath(await mkdtemp(join(tmpdir(), "open-chords-editor-reorder-")));
  const library = await openProjectLibrary({ stateRoot });
  const envelope = ProjectEnvelopeSchema.parse(
    JSON.parse(
      readFileSync(
        join(repositoryRoot, "packages/testkit/contracts/v1/valid/project-envelope.json"),
        "utf8",
      ),
    ),
  );
  await library.createProject({ envelope, records: goldenRecords() });
  const application = await launch(stateRoot);
  try {
    const page = await application.firstWindow();
    const opener = page.getByRole("button", { name: "Edit chords", exact: true });
    await opener.click();
    const editor = page.getByRole("region", { name: "Chord Editor" });
    const ids = () =>
      editor
        .locator("[data-event-id]")
        .evaluateAll((elements) =>
          elements.map((element) => element.getAttribute("data-event-id")),
        );
    const first = editor.locator('[data-event-id="chord_am7_e"]');
    const initialFirstWidth = (await first.boundingBox())!.width;
    const initialSecondWidth = (await editor
      .locator('[data-event-id="chord_c_sharp"]')
      .boundingBox())!.width;
    expect(initialSecondWidth / initialFirstWidth).toBeCloseTo(1.5, 2);
    await first.getByLabel("Move target").selectOption("chord_g7");
    await first.getByRole("button", { name: "Move after", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect.poll(ids).toEqual(["chord_c_sharp", "chord_n", "chord_g7", "chord_am7_e"]);
    await expect(first.getByRole("button", { name: "Move after", exact: true })).toBeFocused();
    await first.getByLabel("Move target").selectOption("chord_c_sharp");
    await first.getByRole("button", { name: "Move before", exact: true }).click();
    await expect.poll(ids).toEqual(["chord_am7_e", "chord_c_sharp", "chord_n", "chord_g7"]);
    await page.setViewportSize({ width: 1800, height: 900 });
    const source = first.getByRole("button", { name: "Drag chord", exact: true });
    const last = editor.locator('[data-event-id="chord_g7"]');
    const sourceBox = (await source.boundingBox())!;
    const targetBox = (await last.boundingBox())!;
    await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      sourceBox.x + sourceBox.width / 2 + 10,
      sourceBox.y + sourceBox.height / 2,
      { steps: 3 },
    );
    await page.mouse.move(targetBox.x + targetBox.width - 20, targetBox.y + 30, { steps: 6 });
    await page.mouse.move(targetBox.x + targetBox.width - 19, targetBox.y + 30);
    await expect(last).toHaveAttribute("data-drop-side", "after");
    await expect(last.locator(".drop-indicator")).toHaveText("Insert after");
    await page.mouse.up();
    await expect.poll(ids).toEqual(["chord_c_sharp", "chord_n", "chord_g7", "chord_am7_e"]);
    await page.setViewportSize({ width: 1400, height: 1100 });
    await first.getByRole("button", { name: "Choose chord" }).click();
    await editor.getByLabel("Root").selectOption("D");
    await page.keyboard.press("Escape");
    await expect(first.getByRole("button", { name: "Choose chord" })).toBeFocused();
    await expect(editor.getByRole("group", { name: "Chord picker" })).toHaveCount(0);
    await page.setViewportSize({ width: 360, height: 720 });
    const overflow = await page.evaluate(() => ({
      page: document.documentElement.scrollWidth > innerWidth,
      rail:
        document.querySelector(".editor-rail")!.scrollWidth >
        document.querySelector(".editor-rail")!.clientWidth,
    }));
    expect(overflow).toEqual({ page: false, rail: true });
    await page.keyboard.press("Escape");
    await expect(editor).toHaveCount(0);
    await expect(opener).toBeFocused();
  } finally {
    await application.close();
    await rm(stateRoot, { force: true, recursive: true });
  }
});

test("editor Save, Cancel, draft Reset and durable history stay separate", async () => {
  const stateRoot = await realpath(await mkdtemp(join(tmpdir(), "open-chords-editor-")));
  const library = await openProjectLibrary({ stateRoot });
  const envelope = ProjectEnvelopeSchema.parse(
    JSON.parse(
      readFileSync(
        join(repositoryRoot, "packages/testkit/contracts/v1/valid/project-envelope.json"),
        "utf8",
      ),
    ),
  );
  await library.createProject({ envelope, records: goldenRecords() });
  const application = await launch(stateRoot);
  try {
    const page = await application.firstWindow();
    await page.setViewportSize({ width: 1400, height: 1100 });
    const opener = page.getByRole("button", { name: "Edit chords", exact: true });
    await expect(opener).toBeVisible();
    await expect(page.getByRole("region", { name: "Chord Editor" })).toHaveCount(0);
    const pickup = page.getByRole("button", { name: /Pickup, 4\/4/ });
    const before = await pickup.getAttribute("aria-label");
    await opener.click();
    const editor = page.getByRole("region", { name: "Chord Editor" });
    const first = editor.locator('[data-event-id="chord_am7_e"]');
    await first.getByRole("button", { name: "Choose chord" }).click();
    await expect(editor.getByLabel("Root")).toBeFocused();
    const pickerBounds = (await editor.getByRole("group", { name: "Chord picker" }).boundingBox())!;
    const transportBounds = (await page.locator(".transport").boundingBox())!;
    expect(
      pickerBounds.y + pickerBounds.height <= transportBounds.y ||
        pickerBounds.y >= transportBounds.y + transportBounds.height,
    ).toBe(true);
    await editor.getByLabel("Root").selectOption("N");
    await editor.getByRole("button", { name: "Done", exact: true }).click();
    await expect(pickup).toHaveAttribute("aria-label", before!);
    await editor.getByRole("button", { name: "Reset draft", exact: true }).click();
    await expect(editor.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
    await first.getByRole("button", { name: "Choose chord" }).click();
    await editor.getByLabel("Root").selectOption("N");
    await editor.getByRole("button", { name: "Done", exact: true }).click();
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await expect(editor).toHaveCount(0);
    await expect(opener).toBeFocused();
    await expect(pickup).toHaveAttribute("aria-label", /Chords: N/);
    await page.getByRole("button", { name: "Undo edit", exact: true }).click();
    await expect(pickup).toHaveAttribute("aria-label", before!);
    await page.getByLabel("Redo branch").selectOption({ index: 2 });
    await page.getByRole("button", { name: "Redo edit", exact: true }).click();
    await expect(pickup).toHaveAttribute("aria-label", /Chords: N/);
    await opener.click();
    await first.getByLabel("Duration").selectOption("4000");
    await expect(editor.getByRole("alert")).toContainText("Durations");
    await expect(editor.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
    await editor.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(opener).toBeFocused();
    await expect(pickup).toHaveAttribute("aria-label", /Chords: N/);
    await page.getByRole("button", { name: "Reset saved edits", exact: true }).click();
    await expect(pickup).toHaveAttribute("aria-label", before!);
  } finally {
    await application.close();
    await rm(stateRoot, { force: true, recursive: true });
  }
});

test("selection and persistent loop remain independent in the deterministic fixture", async () => {
  const userDataDirectory = await realpath(
    await mkdtemp(join(tmpdir(), "open-chords-workspace-golden-")),
  );
  const library = await openProjectLibrary({ stateRoot: userDataDirectory });
  const fixture = ProjectEnvelopeSchema.parse(
    JSON.parse(
      readFileSync(
        join(repositoryRoot, "packages/testkit/contracts/v1/valid/project-envelope.json"),
        "utf8",
      ),
    ),
  );
  await library.createProject({ envelope: fixture, records: goldenRecords() });

  const application = await launch(userDataDirectory);
  try {
    const page = await application.firstWindow();
    const pickup = page.getByRole("button", { name: /Pickup, 4\/4/ });
    const complete = page.getByRole("button", { name: /Complete, 3\/4/ });
    await expect(pickup).toBeVisible();
    await expect(page.getByRole("group", { name: "go go", exact: true })).toBeVisible();
    await expect(page.getByRole("group", { name: "home go", exact: true })).toBeVisible();
    const follow = page.getByRole("button", { name: "Follow lyrics" });
    await expect(follow).toHaveAttribute("aria-pressed", "true");
    const lyrics = page.getByRole("region", { name: "Lyrics viewport" });
    await lyrics.hover();
    await page.mouse.wheel(0, 100);
    await expect(follow).toHaveAttribute("aria-pressed", "false");
    await follow.click();
    await expect(follow).toHaveAttribute("aria-pressed", "true");
    const chord = page.getByRole("button", {
      name: "Chord Am7(9, add11, add9)/E. asserted",
      exact: true,
    });
    await expect(chord).toBeVisible();
    await chord.focus();
    await chord.press("Enter");
    await expect(page.getByRole("status", { name: "Selected chord" })).toHaveText(
      "Am7(9, add11, add9)/E · asserted",
    );
    const position = page.getByRole("slider", { name: "Project position", exact: true });
    await position.focus();
    await position.press("End");
    await expect(position).toHaveValue("48000");
    await position.press("Home");
    await expect(position).toHaveValue("0");
    await position.fill("2000");
    await expect(page.locator(".lyric-block[data-current=true]")).toContainText("go");
    await expect(page.getByRole("group", { name: "go go", exact: true })).toContainText(
      "Am7(9, add11, add9)/E",
    );
    await position.fill("0");
    await page.setViewportSize({ height: 720, width: 320 });
    const pickupBounds = await pickup.boundingBox();
    const completeBounds = await complete.boundingBox();
    if (pickupBounds === null || completeBounds === null) {
      throw new Error("Timeline region geometry is unavailable");
    }
    expect(pickupBounds.width / completeBounds.width).toBeCloseTo(1 / 3, 2);
    await expect(pickup).toHaveAttribute("tabindex", "0");
    await expect(complete).toHaveAttribute("tabindex", "-1");
    await pickup.focus();
    await pickup.press("ArrowRight");
    await expect(complete).toHaveAttribute("aria-pressed", "true");
    await expect(complete).toBeFocused();
    await expect(pickup).toHaveAttribute("tabindex", "-1");
    await expect(complete).toHaveAttribute("tabindex", "0");
    await page.getByRole("button", { name: "Set loop from selection" }).click();
    await pickup.click();

    await expect(pickup).toHaveAttribute("aria-pressed", "true");
    await expect(complete).toHaveAttribute("data-looped", "true");
    await expect(page.locator(".loop-status")).toContainText("Loop: Complete, 3/4");
    await position.fill("40000");
    await expect(position).toHaveValue("40000");
    await position.fill("0");

    const projectId = (await page.locator(".project-identity").textContent())?.trim();
    if (projectId === undefined || projectId.length === 0) throw new Error("Project ID is missing");
    const currentSnapshot = await page.evaluate(
      async (id) => window.openChords?.project.getSnapshot(id),
      projectId,
    );
    if (currentSnapshot?.type !== "project.snapshot") {
      throw new Error("Committed Project snapshot is unavailable");
    }

    const setLoop = page.getByRole("button", { name: "Set loop from selection" });
    await setLoop.focus();
    await expect(setLoop).toBeFocused();
    await pickup.evaluate((element) => element.setAttribute("data-stale-region", "true"));
    const secondSnapshot = revisedSnapshot(currentSnapshot, "second", 2);
    await installSnapshotResponse(application, secondSnapshot);
    await publishProjectChange(application, secondSnapshot);
    await expect(pickup).not.toHaveAttribute("data-stale-region", "true");
    await expect(setLoop).toBeFocused();

    await pickup.focus();
    await expect(pickup).toBeFocused();
    await pickup.evaluate((element) => element.setAttribute("data-stale-region", "true"));
    const thirdSnapshot = revisedSnapshot(secondSnapshot, "third", 3);
    await installSnapshotResponse(application, thirdSnapshot);
    await publishProjectChange(application, thirdSnapshot);
    await expect(pickup).not.toHaveAttribute("data-stale-region", "true");
    await expect(pickup).toBeFocused();

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByRole("slider", { name: "Timeline zoom" }).fill("2");
    await position.fill("2000");
    await page.screenshot({ path: test.info().outputPath("workspace.png"), fullPage: true });
    await chord.focus();
    const fourthSnapshot = revisedSnapshot(thirdSnapshot, "fourth", 4);
    fourthSnapshot.project.activeView = {
      ...fourthSnapshot.project.activeView!,
      analysisRevisionId: "revision_reviewable",
      editLayerId: "edit_reviewable",
      editHistoryPosition: 0,
    };
    delete fourthSnapshot.project.activeView.lyricsDocumentId;
    delete fourthSnapshot.project.activeView.lyricsAlignmentId;
    await installSnapshotResponse(application, fourthSnapshot);
    await publishProjectChange(application, fourthSnapshot);
    await expect(
      page.getByRole("button", { name: "Chord N. asserted", exact: true }),
    ).toBeFocused();

    await rejectPlaybackRequests(application);
    await page.reload();
    await expect(page.getByRole("alert")).toContainText(
      "Could not prepare the verified Source for playback.",
    );

    await page.emulateMedia({ reducedMotion: "reduce" });
    const playheadBounds = await page.locator(".fixed-playhead").boundingBox();
    const viewportBounds = await page.locator(".timeline-viewport").boundingBox();
    if (playheadBounds === null || viewportBounds === null) {
      throw new Error("Timeline geometry is unavailable");
    }
    expect(
      Math.abs(
        playheadBounds.x + playheadBounds.width / 2 - (viewportBounds.x + viewportBounds.width / 2),
      ),
    ).toBeLessThan(1);
  } finally {
    await application.close();
    await rm(userDataDirectory, { force: true, recursive: true });
  }
});

async function launch(userDataDirectory: string) {
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (name !== "ELECTRON_RUN_AS_NODE" && value !== undefined) environment[name] = value;
  }
  return electron.launch({
    args: [repositoryRoot, `--user-data-dir=${userDataDirectory}`],
    env: environment,
  });
}

function revisedSnapshot(
  snapshot: ProjectSnapshotResponse,
  suffix: string,
  eventSequence: number,
): ProjectSnapshotResponse {
  const project = structuredClone(snapshot.project);
  if (project.practice?.loop) project.practice.loop.status = "needs_review";
  const activeAnalysis = project.analysisRevisions.find(
    ({ id }) => id === project.activeView?.analysisRevisionId,
  );
  if (activeAnalysis === undefined) throw new Error("Active Analysis Revision is missing");
  activeAnalysis.timeline.bars = activeAnalysis.timeline.bars.map((bar) => ({
    ...bar,
    id: `${bar.id}_${suffix}`,
  }));
  activeAnalysis.timeline.unmeteredRegions = activeAnalysis.timeline.unmeteredRegions.map(
    (region) => ({ ...region, id: `${region.id}_${suffix}` }),
  );
  const response = DesktopResponseSchema.parse({
    ...snapshot,
    eventSequence: Math.max(eventSequence, snapshot.eventSequence + 1),
    project,
    projectRevisionId: `projectrevision_${eventSequence.toString(16).padStart(32, "0")}`,
  });
  if (response.type !== "project.snapshot") throw new Error("Revised snapshot is invalid");
  return response;
}

async function installSnapshotResponse(
  application: Awaited<ReturnType<typeof launch>>,
  snapshot: ProjectSnapshotResponse,
) {
  await application.evaluate(
    ({ ipcMain }, input) => {
      ipcMain.removeHandler(input.channel);
      ipcMain.handle(input.channel, (_event, rawCommand: unknown) => {
        if (
          typeof rawCommand !== "object" ||
          rawCommand === null ||
          !("generationId" in rawCommand) ||
          typeof rawCommand.generationId !== "string" ||
          !("requestId" in rawCommand) ||
          typeof rawCommand.requestId !== "string"
        ) {
          throw new Error("Snapshot command envelope is invalid");
        }
        return {
          ...input.snapshot,
          generationId: rawCommand.generationId,
          requestId: rawCommand.requestId,
        };
      });
    },
    { channel: DESKTOP_IPC_CHANNELS.projectGetSnapshot, snapshot },
  );
}

async function publishProjectChange(
  application: Awaited<ReturnType<typeof launch>>,
  snapshot: ProjectSnapshotResponse,
) {
  await application.evaluate(
    ({ BrowserWindow }, input) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send(input.channel, input.event);
    },
    {
      channel: DESKTOP_IPC_CHANNELS.projectChanged,
      event: {
        generationId: snapshot.generationId,
        projectId: snapshot.project.id,
        projectRevisionId: snapshot.projectRevisionId,
        protocol: snapshot.protocol,
        protocolVersion: snapshot.protocolVersion,
        sequence: snapshot.eventSequence,
        type: "project.changed" as const,
      },
    },
  );
}

async function rejectPlaybackRequests(application: Awaited<ReturnType<typeof launch>>) {
  await application.evaluate(({ ipcMain }, channel) => {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, () => Promise.reject(new Error("forced playback IPC rejection")));
  }, DESKTOP_IPC_CHANNELS.mediaOpenPlayback);
}

test("profile committed timeline density before choosing virtualization", async () => {
  test.skip(process.env.OPEN_CHORDS_PROFILE_WORKSPACE !== "1", "Opt-in measured workspace profile");
  test.setTimeout(120_000);
  for (const fixture of [
    { name: "short", count: 120, step: 12_000, lyrics: false },
    { name: "many-events", count: 1200, step: 12_000, lyrics: false },
    { name: "dense-events", count: 4800, step: 12_000, lyrics: false },
    { name: "long-song", count: 1200, step: 108_000, lyrics: false },
    { name: "dense-lyrics", count: 4800, step: 12_000, lyrics: true },
  ]) {
    const { count, step } = fixture;
    const stateRoot = await realpath(await mkdtemp(join(tmpdir(), "open-chords-profile-")));
    const envelope = ProjectEnvelopeSchema.parse(
      JSON.parse(
        readFileSync(
          join(repositoryRoot, "packages/testkit/contracts/v1/valid/project-envelope.json"),
          "utf8",
        ),
      ),
    );
    const project = envelope.payload;
    const original = project.analysisRevisions[0]!;
    const duration = count * step;
    project.durationSamples = duration;
    project.analysisRevisions = [
      {
        ...original,
        timeline: {
          bars: Array.from({ length: count / 4 }, (_, index) => ({
            id: `profile_bar_${index}`,
            startSample: index * step * 4,
            endSample: (index + 1) * step * 4,
            status: "complete" as const,
            meter: { numerator: 4, denominator: 4 },
            beats: Array.from({ length: 4 }, (_unused, beat) => ({
              id: `profile_beat_${index}_${beat}`,
              atSample: (index * 4 + beat) * step,
              role: beat === 0 ? ("downbeat" as const) : ("beat" as const),
            })),
          })),
          chordEvents: Array.from({ length: count }, (_, index) => ({
            ...original.timeline.chordEvents[0]!,
            id: `profile_chord_${index}`,
            startSample: index * step,
            endSample: (index + 1) * step,
          })),
          sectionRegions: [
            { ...original.timeline.sectionRegions[0]!, endSample: duration, label: "neutral" },
          ],
          keyRegions: [{ ...original.timeline.keyRegions[0]!, endSample: duration }],
          unmeteredRegions: [],
        },
      },
    ];
    project.editLayers = [{ ...project.editLayers[0]!, transactions: [] }];
    project.activeView = { ...project.activeView!, editHistoryPosition: 0 };
    delete project.activeView.lyricsAlignmentId;
    delete project.activeView.lyricsDocumentId;
    project.lyricsDocuments = [];
    project.lyricsAlignments = [];
    if (fixture.lyrics) {
      envelope.payload = addLyricsDocument(
        project,
        {
          text: Array.from({ length: count / 8 }, () => "go home go home go home go home").join(
            "\n",
          ),
          language: "en",
          format: "text",
        },
        "lyrics_profile",
      );
      const document = envelope.payload.lyricsDocuments[0]!;
      const alignment = envelope.payload.lyricsAlignments[0]!;
      alignment.lineOccurrences = document.lines.map((line, index) => ({
        lineId: line.id,
        timing: {
          state: "matched",
          startSample: index * step * 8,
          endSample: (index + 1) * step * 8,
          assertion: { state: "asserted", evidence: [], reasonCodes: [] },
        },
      }));
      alignment.occurrences = document.tokens.map((token, index) => ({
        tokenId: token.id,
        timing: {
          state: "matched",
          startSample: index * step,
          endSample: (index + 1) * step,
          assertion: { state: "asserted", evidence: [], reasonCodes: [] },
        },
      }));
    }
    const records = goldenRecords();
    records.projectRange.endSourceSample = duration;
    records.sources[0]!.snapshots[0]!.durationSamples = duration;
    records.legacyManifestlessAnalysisRevisionIds = [original.id];
    const library = await openProjectLibrary({ stateRoot });
    await library.createProject({ envelope, records });
    const start = performance.now();
    const application = await launch(stateRoot);
    try {
      const page = await application.firstWindow();
      await expect(
        page.getByRole("slider", { name: "Project position", exact: true }),
      ).toBeVisible();
      const readyMs = performance.now() - start;
      const session = await page.context().newCDPSession(page);
      await session.send("Accessibility.enable");
      const accessibility = await session.send("Accessibility.getFullAXTree");
      const versions = await application.evaluate(() => process.versions);
      const geometry = await page.locator(".timeline-viewport").evaluate((viewport) => ({
        width: viewport.clientWidth,
        bar: viewport.querySelector(".timeline-region")!.getBoundingClientRect().width,
        chord: viewport.querySelector(".timeline-chord")!.getBoundingClientRect().width,
      }));
      expect(geometry.bar).toBeCloseTo(geometry.width / (count / 4), 1);
      expect(geometry.chord).toBeCloseTo(geometry.width / count, 1);
      const measurement = await page.evaluate(async () => {
        const input = document.querySelector<HTMLInputElement>('[aria-label="Project position"]')!;
        const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!;
        const samples: number[] = [];
        for (let i = 1; i <= 20; i++) {
          const seekStart = performance.now();
          descriptor.set!.call(input, String(Math.round((Number(input.max) * i) / 21)));
          input.dispatchEvent(new Event("input", { bubbles: true }));
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          );
          samples.push(performance.now() - seekStart);
        }
        return { samples, elements: document.querySelectorAll("*").length };
      });
      const ordered = measurement.samples.toSorted((a, b) => a - b);
      const result = {
        profile: "workspace-density",
        fixture: fixture.name,
        environment: {
          platform: platform(),
          release: release(),
          arch: process.arch,
          cpu: cpus()[0]?.model,
          logicalCpus: cpus().length,
          memoryBytes: totalmem(),
          versions,
        },
        conditions:
          "Production renderer; synthetic unavailable Source; AX enabled after ready; 20 DOM-input seeks to two animation frames; no native screen reader",
        count,
        durationSeconds: duration / project.sampleRate,
        lyricLines: envelope.payload.lyricsDocuments[0]?.lines.length ?? 0,
        lyricTokens: envelope.payload.lyricsDocuments[0]?.tokens.length ?? 0,
        axNodes: accessibility.nodes.length,
        exposedAxNodes: accessibility.nodes.filter((node) => !node.ignored).length,
        readyMs,
        elements: measurement.elements,
        seekPaintSamplesMs: measurement.samples,
        seekPaintMedianMs: (ordered[9]! + ordered[10]!) / 2,
        seekPaintP95Ms: ordered[18],
      };
      console.log(JSON.stringify(result));
      const resultPath = test.info().outputPath(`${fixture.name}-performance.json`);
      await writeFile(resultPath, JSON.stringify(result, null, 2));
      await test.info().attach(`${fixture.name}-performance.json`, {
        path: resultPath,
        contentType: "application/json",
      });
    } finally {
      await application.close();
      await rm(stateRoot, { recursive: true, force: true });
    }
  }
});

test("lyrics follow stays inside its viewport and manual scrolling retains focus and position", async () => {
  const stateRoot = await realpath(await mkdtemp(join(tmpdir(), "open-chords-lyrics-follow-")));
  const envelope = ProjectEnvelopeSchema.parse(
    JSON.parse(
      readFileSync(
        join(repositoryRoot, "packages/testkit/contracts/v1/valid/project-envelope.json"),
        "utf8",
      ),
    ),
  );
  const document = envelope.payload.lyricsDocuments[0]!;
  const alignment = envelope.payload.lyricsAlignments[0]!;
  document.text = "";
  document.lines = [];
  document.tokens = [];
  document.suppliedTimingKind = "line";
  alignment.lineOccurrences = [];
  alignment.occurrences = [];
  for (let index = 0; index < 60; index++) {
    const id = `follow_line_${index}`;
    const startOffset = document.text.length;
    document.text += `Verse ${index + 1}\n`;
    document.lines.push({ id, startOffset, endOffset: document.text.length - 1 });
    alignment.lineOccurrences.push({
      lineId: id,
      timing: {
        state: "matched",
        startSample: index * 800,
        endSample: index * 800 + 600,
        assertion: { state: "asserted", evidence: [], reasonCodes: [] },
      },
    });
  }
  const library = await openProjectLibrary({ stateRoot });
  await library.createProject({ envelope, records: goldenRecords() });
  const application = await launch(stateRoot);
  try {
    const page = await application.firstWindow();
    await page.emulateMedia({ reducedMotion: "reduce" });
    const viewport = page.getByRole("region", { name: "Lyrics viewport" });
    const position = page.getByRole("slider", { name: "Project position", exact: true });
    await expect(viewport).toBeVisible();
    await position.fill("47200");
    const lastLine = page.getByRole("group", { name: "Verse 60", exact: true });
    await expect
      .poll(async () => {
        const line = await lastLine.boundingBox();
        const outer = await viewport.boundingBox();
        return (
          line !== null &&
          outer !== null &&
          line.y >= outer.y &&
          line.y + line.height <= outer.y + outer.height
        );
      })
      .toBe(true);
    await viewport.focus();
    await viewport.press("Home");
    await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBe(0);
    await expect(page.getByRole("button", { name: "Follow lyrics" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await expect(viewport).toBeFocused();
    await expect(position).toHaveValue("47200");
    // Explicitly moving the lyrics scrollbar must not seek or scroll the document.
    await viewport.evaluate((element) => {
      element.scrollTop = 200;
    });
    await position.fill("800");
    expect(Math.abs((await viewport.evaluate((element) => element.scrollTop)) - 200)).toBeLessThan(
      2,
    );
    await page.getByRole("button", { name: "Follow lyrics" }).click();
    await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBeLessThan(100);
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(2),
    );
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            window.document.documentElement.scrollWidth <=
            window.document.documentElement.clientWidth,
        ),
      )
      .toBe(true);
    await page.emulateMedia({ forcedColors: "active" });
    await position.focus();
    await position.press("End");
    await expect(position).toHaveValue("48000");
    await expect(position).toHaveAttribute("aria-valuetext", "1.00 of 1.00 seconds");
  } finally {
    await application.close();
    await rm(stateRoot, { force: true, recursive: true });
  }
});

test("practice settings and explicit loops survive reopening without following selection", async () => {
  const stateRoot = await realpath(await mkdtemp(join(tmpdir(), "open-chords-practice-")));
  const library = await openProjectLibrary({ stateRoot });
  const envelope = ProjectEnvelopeSchema.parse(
    JSON.parse(
      readFileSync(
        join(repositoryRoot, "packages/testkit/contracts/v1/valid/project-envelope.json"),
        "utf8",
      ),
    ),
  );
  await library.createProject({ envelope, records: goldenRecords() });
  let application = await launch(stateRoot);
  try {
    let page = await application.firstWindow();
    await expect(page.getByRole("heading", { name: "Musical timeline" })).toBeVisible();
    await page.getByRole("button", { name: "Set loop from selection" }).click();
    await expect(page.locator(".loop-status")).toContainText("Pickup");
    await page.getByRole("combobox", { name: "Loop end Bar" }).selectOption("bar_three_four");
    await page.getByRole("button", { name: "Set loop from selection" }).click();
    await expect(page.locator(".loop-status")).toContainText("through Complete");
    await page.locator('[data-region-id="bar_three_four"]').focus();
    await page.locator('[data-region-id="bar_three_four"]').press("Enter");
    await expect(page.locator(".loop-status")).toContainText("Pickup");
    await page.getByRole("combobox", { name: "Playback speed" }).selectOption("0.75");
    await expect(page.getByRole("combobox", { name: "Playback speed" })).toHaveValue("0.75");
    await expect(page.getByRole("status", { name: "Practice settings status" })).toHaveText(
      "Practice saved",
    );
    await application.close();
    application = await launch(stateRoot);
    page = await application.firstWindow();
    await expect(page.locator(".loop-status")).toContainText("Pickup");
    await expect(page.getByRole("combobox", { name: "Playback speed" })).toHaveValue("0.75");
    await page.getByRole("combobox", { name: "Transpose" }).selectOption("-2");
    await expect(page.getByRole("combobox", { name: "Transpose" })).toHaveValue("-2");
    await page.getByRole("checkbox", { name: "Beginner View" }).click();
    await expect(page.getByRole("checkbox", { name: "Beginner View" })).toBeChecked();
    await expect(page.locator('[data-region-id="bar_pickup"]')).toContainText("Gm/D");
    await page.getByRole("combobox", { name: "Instrument" }).selectOption("piano");
    await expect(page.getByRole("img", { name: /Piano diagram/ })).toBeVisible();
  } finally {
    await application.close();
    await rm(stateRoot, { force: true, recursive: true });
  }
});

test("practice Play starts at the loop boundary and count-in is cancellable by keyboard", async () => {
  const stateRoot = await realpath(await mkdtemp(join(tmpdir(), "open-chords-practice-play-")));
  const library = await openProjectLibrary({ stateRoot });
  const mediaPath = join(stateRoot, "practice.wav");
  await writeFile(
    mediaPath,
    monoPcmWav(
      Array.from({ length: 576000 }, (_, i) =>
        Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / 48000)),
      ),
    ),
  );
  const media = new LocalMediaService({ library, pickFile: async () => mediaPath });
  media.activateGeneration("generation_practice_seed");
  const picked = await media.pickLocalFile("generation_practice_seed");
  if (picked.kind !== "selected") throw new Error("Fixture media is unavailable");
  const created = await media.createProject({
    capabilityId: picked.capabilityId,
    startSourceSample: 0,
    endSourceSample: 576000,
    generationId: "generation_practice_seed",
  });
  const sourceProject = await library.readProject(created.projectId);
  const raw = JSON.parse(
    readFileSync(
      join(repositoryRoot, "packages/testkit/contracts/v1/valid/project-envelope.json"),
      "utf8",
    ),
  );
  const scale = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(scale);
    if (typeof value !== "object" || value === null) return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        ["atSample", "startSample", "endSample", "durationSamples"].includes(key) &&
        typeof child === "number"
          ? child * 12
          : scale(child),
      ]),
    );
  };
  const envelope = ProjectEnvelopeSchema.parse(scale(raw));
  const records = sourceProject.records;
  records.legacyManifestlessAnalysisRevisionIds = envelope.payload.analysisRevisions.map(
    ({ id }) => id,
  );
  await library.createProject({ envelope, records });
  await media.dispose();
  // The fixture Project sorts first in the workspace's Project list.
  await library.trashProject(created.projectId);
  const application = await launch(stateRoot);
  try {
    const page = await application.firstWindow();
    await expect(page.getByText("Verified local playback", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "YouTube source", exact: true }).click();
    const sourceDialog = page.getByRole("dialog", { name: "YouTube source", exact: true });
    await sourceDialog.focus();
    await sourceDialog.press("Space");
    await page.keyboard.press("Escape");
    expect(
      await page
        .locator("main.workspace audio")
        .evaluate((element) => element instanceof HTMLAudioElement && element.paused),
    ).toBe(true);
    await page.locator('[data-region-id="bar_three_four"]').focus();
    await page.locator('[data-region-id="bar_three_four"]').press("Enter");
    await page.getByRole("button", { name: "Set loop from selection" }).click();
    await expect(page.locator(".loop-status")).toContainText("Complete");
    await page.getByRole("combobox", { name: "Count-in" }).selectOption("1");
    await expect(page.getByRole("combobox", { name: "Count-in" })).toHaveValue("1");
    await page.getByRole("checkbox", { name: "Metronome", exact: true }).click();
    await expect(page.getByRole("checkbox", { name: "Metronome", exact: true })).toBeChecked();
    await page.evaluate(() => {
      const stops: number[] = [];
      Object.defineProperty(window, "practiceAudioStops", { value: stops, configurable: true });
      // oxlint-disable-next-line typescript/unbound-method -- The native prototype method is deliberately rebound with call(this) below.
      const create = AudioContext.prototype.createOscillator;
      AudioContext.prototype.createOscillator = function () {
        const node = create.call(this);
        const index = stops.length;
        stops.push(0);
        const stop = node.stop.bind(node);
        node.stop = (when?: number) => {
          stops[index] = (stops[index] ?? 0) + 1;
          stop(when);
        };
        return node;
      };
    });
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await expect(page.getByRole("button", { name: "Cancel count-in" })).toBeVisible();
    const scheduledStops = await page.evaluate(async () => {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      return Object.getOwnPropertyDescriptor(window, "practiceAudioStops")?.value;
    });
    expect(scheduledStops).toEqual([1, 1, 1]);
    await page.locator("main.workspace").focus();
    await page.locator("main.workspace").press("Space");
    await expect(page.getByRole("button", { name: "Play", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await expect(page.getByRole("button", { name: "Cancel count-in" })).toBeVisible();
    await page.getByRole("combobox", { name: "Playback speed" }).selectOption("0.75");
    await expect(page.getByRole("button", { name: "Play", exact: true })).toBeVisible();
    await page.getByRole("combobox", { name: "Playback speed" }).selectOption("1");
    await expect(page.getByRole("combobox", { name: "Playback speed" })).toHaveValue("1");
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await expect(page.getByRole("button", { name: "Cancel count-in" })).toBeVisible();
    expect(await page.locator("audio").evaluate((audio: HTMLAudioElement) => audio.paused)).toBe(
      true,
    );
    await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible({
      timeout: 10000,
    });
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    await page.getByRole("combobox", { name: "Count-in" }).selectOption("0");
    await expect(page.getByRole("combobox", { name: "Count-in" })).toHaveValue("0");
    const position = page.getByRole("slider", { name: "Project position", exact: true });
    await position.fill("240000");
    await page.locator("main.workspace").focus();
    await page.locator("main.workspace").press("Space");
    await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    expect(Number(await position.inputValue())).toBeGreaterThanOrEqual(96000);
    expect(Number(await position.inputValue())).toBeLessThan(144000);
    await page.getByRole("button", { name: "Next chord", exact: true }).click();
    await expect(position).toHaveValue("240000");
    await page.getByRole("checkbox", { name: "Timeline autoscroll" }).click();
    await expect(page.getByRole("checkbox", { name: "Timeline autoscroll" })).not.toBeChecked();
    await position.fill("96000");
    const trackStyle = await page.locator(".timeline-track").getAttribute("style");
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await expect.poll(async () => Number(await position.inputValue())).toBeGreaterThan(100000);
    expect(await page.locator(".timeline-track").getAttribute("style")).toBe(trackStyle);
    await page.getByRole("button", { name: "Next chord", exact: true }).click();
    await expect(page.locator(".timeline-track")).not.toHaveAttribute("style", trackStyle!);
    const navigatedStyle = await page.locator(".timeline-track").getAttribute("style");
    await position.fill("192000");
    await expect(page.locator(".timeline-track")).not.toHaveAttribute("style", navigatedStyle!);
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    await page.getByRole("combobox", { name: "Playback speed" }).selectOption("0.75");
    await expect(page.getByRole("combobox", { name: "Playback speed" })).toHaveValue("0.75");
    await page.getByRole("button", { name: "Play", exact: true }).click();
    const renderedAudio = await page.evaluate(async () => {
      const source = document.querySelector("audio");
      if (source === null) throw new Error("Workspace media element is missing");
      const context = new AudioContext();
      const analyser = context.createAnalyser();
      analyser.fftSize = 8192;
      context.createMediaElementSource(source).connect(analyser).connect(context.destination);
      await context.resume();
      await new Promise((resolve) => setTimeout(resolve, 500));
      const spectrum = new Float32Array(analyser.frequencyBinCount);
      analyser.getFloatFrequencyData(spectrum);
      let peak = 1;
      for (let bin = 2; bin < spectrum.length; bin += 1)
        if (spectrum[bin]! > spectrum[peak]!) peak = bin;
      const result = {
        rate: source.playbackRate,
        preservesPitch: source.preservesPitch,
        frequency: (peak * context.sampleRate) / analyser.fftSize,
        level: spectrum[peak],
      };
      await context.close();
      return result;
    });
    expect(renderedAudio.rate).toBe(0.75);
    expect(renderedAudio.preservesPitch).toBe(true);
    expect(renderedAudio.frequency).toBeGreaterThan(432);
    expect(renderedAudio.frequency).toBeLessThan(448);
    expect(renderedAudio.level).toBeGreaterThan(-60);
  } finally {
    await application.close();
    await rm(stateRoot, { force: true, recursive: true });
  }
});

test("lyrics text selection and correction persist through the actual desktop capability", async () => {
  const stateRoot = await realpath(await mkdtemp(join(tmpdir(), "open-chords-lyrics-ui-")));
  const library = await openProjectLibrary({ stateRoot });
  const envelope = ProjectEnvelopeSchema.parse(
    JSON.parse(
      readFileSync(
        join(repositoryRoot, "packages/testkit/contracts/v1/valid/project-envelope.json"),
        "utf8",
      ),
    ),
  );
  await library.createProject({ envelope, records: goldenRecords() });
  let application = await launch(stateRoot);
  try {
    let page = await application.firstWindow();
    await page.getByRole("button", { name: "Choose lyrics" }).click();
    await page.getByRole("checkbox", { name: "Offline Mode" }).check();
    await expect(page.getByRole("button", { name: "Search LRCLIB" })).toBeDisabled();
    await page
      .getByRole("textbox", { name: "Lyrics text" })
      .fill("Only these words\nOnly these words");
    await page.getByRole("button", { name: "Save new Lyrics Document" }).click();
    await expect(page.getByRole("status", { name: "Lyrics selection status" })).toHaveText(
      "Lyrics saved",
    );
    await expect(page.locator(".lyrics-viewport")).toContainText("Only these words");
    await application.close();
    application = await launch(stateRoot);
    page = await application.firstWindow();
    await expect(page.locator(".lyrics-viewport")).toContainText("Only these words");
    await expect(page.getByRole("checkbox", { name: "Offline Mode" })).toBeChecked();
    await page.getByRole("button", { name: "Choose lyrics" }).click();
    await page.getByRole("textbox", { name: "Lyrics text" }).fill("Corrected words");
    await page.getByRole("button", { name: "Save new Lyrics Document" }).click();
    await expect(page.getByRole("status", { name: "Lyrics selection status" })).toHaveText(
      "Lyrics saved",
    );
    const response = await page.evaluate(() =>
      window.openChords!.project.getSnapshot("project_golden"),
    );
    expect(response.type).toBe("project.snapshot");
    if (response.type === "project.snapshot") {
      expect(response.project.lyricsDocuments.slice(-2).map(({ text }) => text)).toEqual([
        "Only these words\nOnly these words",
        "Corrected words",
      ]);
    }
  } finally {
    await application.close();
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("lyric timing corrections use distinct occurrences and durable Undo/Redo without changing raw lyrics", async () => {
  const stateRoot = await realpath(await mkdtemp(join(tmpdir(), "open-chords-timing-ui-")));
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
  let application = await launch(stateRoot);
  try {
    let page = await application.firstWindow();
    await page.getByRole("button", { name: "Lyrics timing" }).click();
    const panel = page.getByRole("region", { name: "Lyrics timing correction" });
    await expect(panel.getByText(/^Word coverage: \d+\/\d+$/)).toBeVisible();
    await expect(panel.getByText(/^Line coverage: \d+\/\d+$/)).toBeVisible();
    await panel.getByLabel("Timing occurrence").selectOption({ index: 1 });
    await panel.getByRole("button", { name: "Mark untimed" }).click();
    await expect(panel.getByRole("status")).toHaveText("Timing correction saved");
    await expect(panel.getByLabel("Timing occurrence").locator("option").nth(1)).toContainText(
      "user_marked_unmatched",
    );
    await page.getByRole("button", { name: "Undo edit", exact: true }).click();
    await expect(panel.getByLabel("Timing occurrence").locator("option").nth(1)).not.toContainText(
      "user_marked_unmatched",
    );
    await panel.getByLabel("Start seconds").fill("0.05");
    await expect(panel.getByRole("button", { name: "Save timing", exact: true })).toBeDisabled();
    await expect(panel.getByRole("button", { name: "Mark untimed", exact: true })).toBeDisabled();
    await panel.getByRole("button", { name: "Reset timing draft" }).click();
    await expect(panel.getByLabel("Start seconds")).toHaveValue("");
    await expect(panel.getByLabel("End seconds")).toHaveValue("");
    const redoBranch = page.getByLabel("Redo branch", { exact: true });
    await redoBranch.selectOption({ index: (await redoBranch.locator("option").count()) - 1 });
    await page.getByRole("button", { name: "Redo edit", exact: true }).click();
    await expect(panel.getByLabel("Timing occurrence").locator("option").nth(1)).toContainText(
      "user_marked_unmatched",
    );
    await application.close();
    application = await launch(stateRoot);
    page = await application.firstWindow();
    const saved = await page.evaluate(() =>
      window.openChords!.project.getSnapshot("project_golden"),
    );
    expect(saved.type).toBe("project.snapshot");
    if (saved.type === "project.snapshot") {
      expect(saved.project.lyricsDocuments).toEqual(envelope.payload.lyricsDocuments);
      expect(saved.project.lyricsAlignments).toEqual(envelope.payload.lyricsAlignments);
      expect(saved.project.editLayers[0]!.transactions.at(-1)!.operations[0]).toMatchObject({
        type: "set_lyrics_timing",
        timing: { state: "unmatched" },
      });
    }
  } finally {
    await application.close();
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("untimed lyric anchor drafts reset when the Analysis Revision changes", async () => {
  const stateRoot = await realpath(await mkdtemp(join(tmpdir(), "open-chords-anchor-draft-")));
  const envelope = ProjectEnvelopeSchema.parse(
    JSON.parse(
      readFileSync(
        join(repositoryRoot, "packages/testkit/contracts/v1/valid/project-envelope.json"),
        "utf8",
      ),
    ),
  );
  const untimed = envelope.payload.lyricsAlignments.find(
    (item) => item.id === envelope.payload.activeView!.lyricsAlignmentId,
  )!;
  for (const occurrence of [...untimed.occurrences, ...untimed.lineOccurrences])
    occurrence.timing = { state: "unmatched", reasonCode: "fixture_untimed" };
  envelope.payload.activeView!.editHistoryPosition = 0;
  const library = await openProjectLibrary({ stateRoot });
  await library.createProject({ envelope, records: goldenRecords() });
  const application = await launch(stateRoot);
  try {
    const page = await application.firstWindow();
    await page.getByRole("button", { name: "Lyrics timing", exact: true }).click();
    const panel = page.getByRole("region", { name: "Lyrics timing correction" });
    await panel.getByLabel("First anchor word").selectOption({ index: 1 });
    await panel.getByLabel("Last anchor word").selectOption({ index: 2 });
    await panel.getByLabel("Start seconds").fill("0");
    await panel.getByLabel("End seconds").fill("0.5");
    await expect(panel.getByRole("button", { name: "Save anchor", exact: true })).toBeEnabled();
    const snapshot = await page.evaluate(() =>
      window.openChords!.project.getSnapshot("project_golden"),
    );
    if (snapshot.type !== "project.snapshot") throw new Error("Snapshot unavailable");
    const changed = revisedSnapshot(snapshot, "anchor_revision", snapshot.eventSequence + 1);
    changed.project.activeView = {
      ...changed.project.activeView!,
      analysisRevisionId: "revision_reviewable",
      editLayerId: "edit_reviewable",
      editHistoryPosition: 0,
      lyricsAlignmentId: "alignment_anchor_reviewable",
    };
    changed.project.lyricsAlignments.push({
      ...structuredClone(untimed),
      id: "alignment_anchor_reviewable",
      analysisRevisionId: "revision_reviewable",
    });
    await installSnapshotResponse(application, changed);
    await publishProjectChange(application, changed);
    await expect(panel.getByLabel("First anchor word")).toHaveValue("");
    await expect(panel.getByLabel("Last anchor word")).toHaveValue("");
    await expect(panel.getByLabel("Start seconds")).toHaveValue("");
    await expect(panel.getByLabel("End seconds")).toHaveValue("");
    await expect(panel.getByRole("button", { name: "Save anchor", exact: true })).toBeDisabled();
  } finally {
    await application.close();
    await rm(stateRoot, { recursive: true, force: true });
  }
});

for (const failure of ["response", "rejection"] as const) {
  test(`lyrics status ${failure} is visible while local document selection remains available`, async () => {
    const stateRoot = await realpath(await mkdtemp(join(tmpdir(), "open-chords-lyrics-status-")));
    const library = await openProjectLibrary({ stateRoot });
    const envelope = ProjectEnvelopeSchema.parse(
      JSON.parse(
        readFileSync(
          join(repositoryRoot, "packages/testkit/contracts/v1/valid/project-envelope.json"),
          "utf8",
        ),
      ),
    );
    await library.createProject({ envelope, records: goldenRecords() });
    const application = await launch(stateRoot);
    try {
      const page = await application.firstWindow();
      await expect(page.getByRole("heading", { name: "Musical timeline" })).toBeVisible();
      // Inject the response at the native IPC boundary; local Project mutations retain real main ownership.
      await application.evaluate(({ ipcMain }, mode) => {
        const channel = "open-chords:lyrics:perform";
        ipcMain.removeHandler(channel);
        ipcMain.handle(channel, (_event, command: Record<string, unknown>) => {
          if (mode === "rejection") throw new Error("Synthetic lyrics status failure");
          return {
            protocol: command.protocol,
            protocolVersion: command.protocolVersion,
            generationId: command.generationId,
            requestId: command.requestId,
            type: "desktop.error",
            code: "capability_unavailable",
            message: "Lyrics discovery is unavailable",
            retryable: true,
          };
        });
      }, failure);
      await application.evaluate(async ({ BrowserWindow }) => {
        await BrowserWindow.getAllWindows()[0]!.loadURL("open-chords://app/index.html");
      });
      await expect(page.getByRole("status", { name: "Lyrics selection status" })).toContainText(
        "Lyrics discovery is unavailable",
      );
      await expect(page.getByRole("checkbox", { name: "Offline Mode" })).toBeDisabled();
      await page.getByRole("button", { name: "Choose lyrics" }).click();
      await page.getByRole("textbox", { name: "Lyrics text" }).fill("Local words still work");
      await page.getByRole("button", { name: "Save new Lyrics Document" }).click();
      await expect(page.getByRole("status", { name: "Lyrics selection status" })).toHaveText(
        "Lyrics saved",
      );
      await expect(page.locator(".lyrics-viewport")).toContainText("Local words still work");
    } finally {
      await application.close();
      await rm(stateRoot, { force: true, recursive: true });
    }
  });
}

test("alignment packs disclose exact EN/RU sizes and share Offline Mode without starting transfers", async () => {
  const userDataDirectory = await realpath(await mkdtemp(join(tmpdir(), "open-chords-model-ui-")));
  const application = await launch(userDataDirectory);
  try {
    const page = await application.firstWindow();
    await page.getByRole("button", { name: "Alignment packs", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Alignment language packs" })).toBeVisible();
    await expect(
      page.getByText("88.93 MiB download · 97.79 MiB installed", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("111.45 MiB download · 120.31 MiB installed", { exact: true }),
    ).toBeVisible();
    await page.getByRole("checkbox", { name: "Offline Mode for all network operations" }).click();
    await expect(
      page.getByRole("checkbox", { name: "Offline Mode for all network operations" }),
    ).toBeChecked();
    await expect(page.getByRole("button", { name: "Install English" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Install Russian" })).toBeDisabled();
  } finally {
    await application.close();
    await rm(userDataDirectory, { recursive: true, force: true });
  }
});

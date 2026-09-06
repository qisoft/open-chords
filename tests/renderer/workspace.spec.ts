import { readFileSync } from "node:fs";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DESKTOP_IPC_CHANNELS,
  DesktopResponseSchema,
  ProjectEnvelopeSchema,
  type ProjectSnapshotResponse,
} from "@open-chords/contracts";
import { monoPcmWav } from "@open-chords/testkit/media";
import { _electron as electron, expect, test } from "@playwright/test";

import { LocalMediaService } from "../../apps/desktop/src/main/local-media.ts";
import type { ProjectOwnedRecords } from "../../apps/desktop/src/main/project-library-records.ts";
import { openProjectLibrary } from "../../apps/desktop/src/main/project-library.ts";

const repositoryRoot = join(import.meta.dirname, "../..");

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

function goldenRecords(): ProjectOwnedRecords {
  const fingerprint = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
  return {
    analysisManifests: [],
    exportReceipts: [],
    extensions: {},
    legacyManifestlessAnalysisRevisionIds: ["revision_original", "revision_reviewable"],
    projectRange: { endSourceSample: 48_000, sourceId: "source_fixture", startSourceSample: 0 },
    sources: [
      {
        id: "source_fixture",
        identity: { fingerprint, kind: "local_file" },
        locators: [
          {
            fingerprint,
            id: "locator_fixture",
            kind: "local_file",
            path: "/unavailable/golden-fixture.wav",
            status: "unavailable",
            verifiedAt: "2026-08-21T08:00:00Z",
          },
        ],
        metadataObservations: [],
        snapshots: [
          {
            byteFingerprint: fingerprint,
            byteSize: 96_044,
            canonicalAudioFingerprint:
              "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
            durationSamples: 48_000,
            id: "snapshot_fixture",
            metadataObservationIds: [],
            observedAt: "2026-08-21T08:00:00Z",
            provenance: {
              components: [
                {
                  hash: "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
                  id: "media-probe",
                  version: "1.0.0",
                },
              ],
              kind: "local_file",
            },
            selectedFormat: {
              audioCodec: "pcm_s16le",
              container: "wav",
              mimeType: "audio/wav",
            },
          },
        ],
      },
    ],
  };
}

function revisedSnapshot(
  snapshot: ProjectSnapshotResponse,
  suffix: string,
  eventSequence: number,
): ProjectSnapshotResponse {
  const project = structuredClone(snapshot.project);
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
    eventSequence,
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
  for (const count of [120, 1200, 4800]) {
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
    const duration = count * 12_000;
    project.durationSamples = duration;
    project.analysisRevisions = [
      {
        ...original,
        timeline: {
          bars: Array.from({ length: count / 4 }, (_, index) => ({
            id: `profile_bar_${index}`,
            startSample: index * 48_000,
            endSample: (index + 1) * 48_000,
            status: "complete" as const,
            meter: { numerator: 4, denominator: 4 },
            beats: Array.from({ length: 4 }, (_unused, beat) => ({
              id: `profile_beat_${index}_${beat}`,
              atSample: index * 48_000 + beat * 12_000,
              role: beat === 0 ? ("downbeat" as const) : ("beat" as const),
            })),
          })),
          chordEvents: Array.from({ length: count }, (_, index) => ({
            ...original.timeline.chordEvents[0]!,
            id: `profile_chord_${index}`,
            startSample: index * 12_000,
            endSample: (index + 1) * 12_000,
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
      console.log(
        JSON.stringify({
          profile: "workspace-density",
          count,
          readyMs,
          elements: measurement.elements,
          seekPaintMedianMs: ordered[10],
          seekPaintP95Ms: ordered[18],
        }),
      );
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

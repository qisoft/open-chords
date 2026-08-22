import { readFileSync } from "node:fs";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ProjectEnvelopeSchema } from "@open-chords/contracts";
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
    endSourceSample: selected.durationSamples,
    generationId: "generation_seed",
    startSourceSample: 0,
  });
  await media.dispose();

  const application = await launch(userDataDirectory);
  try {
    const page = await application.firstWindow();
    await expect(page.getByRole("heading", { name: "Local Project" })).toBeVisible();
    await expect(page).toHaveTitle(/project_.+ · Local Project · Open Chords/);
    await expect(page.getByRole("heading", { name: "Musical timeline" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Unanalyzed Project range/ })).toBeVisible();
    await expect(page.getByText("Verified local playback")).toBeVisible();
    await expect(page.getByRole("status", { name: "Current Project Time" })).toHaveText("0:00");

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
    await page.getByRole("button", { name: "Pause" }).click();

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
    await expect(page.getByText("go go", { exact: true })).toBeVisible();
    await expect(page.getByText("home go", { exact: true })).toBeVisible();
    await pickup.focus();
    await pickup.press("ArrowRight");
    await expect(complete).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "Set loop from selection" }).click();
    await pickup.click();

    await expect(pickup).toHaveAttribute("aria-pressed", "true");
    await expect(complete).toHaveAttribute("data-looped", "true");
    await expect(page.locator(".loop-status")).toContainText("Loop: Complete, 3/4");

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
    exportReceipts: [],
    extensions: {},
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

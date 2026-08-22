import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parseProjectContract } from "@open-chords/domain";
import { describe, expect, it } from "vitest";

import {
  buildWorkspaceTimeline,
  reconcileWorkspaceRegionState,
  shouldRestoreRegionFocus,
} from "../apps/desktop/src/renderer/workspace-timeline.ts";

describe("workspace timeline projection", () => {
  it("projects the committed Active View into deterministic semantic regions", () => {
    const fixture: unknown = JSON.parse(
      readFileSync(
        join(import.meta.dirname, "../packages/testkit/contracts/v1/valid/project-envelope.json"),
        "utf8",
      ),
    );
    if (typeof fixture !== "object" || fixture === null || !("payload" in fixture)) {
      throw new Error("Golden fixture payload is missing");
    }

    const timeline = buildWorkspaceTimeline(parseProjectContract(fixture.payload));

    expect(timeline.regions.map(({ id, kind }) => [id, kind])).toEqual([
      ["bar_pickup", "bar"],
      ["bar_three_four", "bar"],
      ["unmetered_bridge", "unmetered"],
      ["bar_truncated", "bar"],
    ]);
    expect(timeline.regions[0]).toMatchObject({
      chordLabels: ["Am7(9, add11, add9)/E"],
      endSample: 8_000,
      label: "Pickup, 4/4",
      startSample: 0,
    });
    expect(timeline.durationSamples).toBe(48_000);
  });

  it("shows an unanalyzed Project range without fabricating musical assertions", () => {
    const project = parseProjectContract({
      activeView: null,
      analysisRevisions: [],
      durationSamples: 48_000,
      editLayers: [],
      extensions: {},
      format: "open-chords/project",
      id: "project_unanalyzed",
      lyricsAlignments: [],
      lyricsDocuments: [],
      sampleRate: 48_000,
      schemaVersion: "1.0",
      supportClaims: [],
    });

    expect(buildWorkspaceTimeline(project).regions).toEqual([
      {
        chordLabels: [],
        endSample: 48_000,
        id: "project_unanalyzed_range",
        kind: "unmetered",
        label: "Unanalyzed Project range",
        startSample: 0,
      },
    ]);
  });

  it("reconciles stale selection and loop identities after a committed revision changes", () => {
    const regions = [
      {
        chordLabels: [],
        endSample: 24_000,
        id: "bar_reanalyzed",
        kind: "bar" as const,
        label: "Complete, 4/4",
        startSample: 0,
      },
    ];

    expect(
      reconcileWorkspaceRegionState(regions, {
        loopRegionId: "bar_previous_revision",
        selectedRegionId: "bar_previous_revision",
      }),
    ).toEqual({ loopRegionId: null, selectedRegionId: "bar_reanalyzed" });
  });

  it("restores focus only when a disappearing timeline region owned it", () => {
    expect(shouldRestoreRegionFocus(true, "bar_previous", "bar_reanalyzed")).toBe(true);
    expect(shouldRestoreRegionFocus(false, "bar_previous", "bar_reanalyzed")).toBe(false);
    expect(shouldRestoreRegionFocus(true, "bar_stable", "bar_stable")).toBe(false);
    expect(shouldRestoreRegionFocus(true, "bar_previous", null)).toBe(false);
  });
});

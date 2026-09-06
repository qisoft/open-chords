import { describe, expect, it } from "vitest";

import { createTimelineGeometry } from "../apps/desktop/src/renderer/workspace-geometry.ts";

describe("workspace geometry", () => {
  it("moves content one pointer pixel at both zoom levels and bounds Project Time", () => {
    const normal = createTimelineGeometry(480_000, 1_000, 1);
    expect(normal.xAt(0, 0)).toBe(500);
    expect(normal.xAt(480_000, 480_000)).toBe(500);
    expect(normal.sampleAt(750, 0)).toBe(120_000);
    expect(normal.scrub(240_000, 100)).toBe(192_000);
    expect(normal.scrub(0, 100)).toBe(0);
    expect(normal.scrub(480_000, -100)).toBe(480_000);
    const zoomed = createTimelineGeometry(480_000, 1_000, 2);
    expect(zoomed.scrub(240_000, 100)).toBe(216_000);
    expect(zoomed.xAt(240_000, 216_000)).toBe(600);
    expect(zoomed.widthOf(0, 240)).toBe(1);
  });
});

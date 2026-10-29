import { runInNewContext } from "node:vm";

import { expect, it, vi } from "vitest";

import {
  readWorkspaceProfileReadiness,
  workspaceProfileReadinessDiagnostic,
} from "./support/workspace-profile-readiness.ts";

function observe(api?: object) {
  const value: unknown = runInNewContext(
    `(${readWorkspaceProfileReadiness.toString()})("expected")`,
    {
      window: { openChords: api ? { project: api } : undefined },
      document: {
        querySelector: (selector: string) => (selector === "#empty-heading" ? {} : null),
      },
      Date,
      setTimeout,
      clearTimeout,
    },
  );
  return Promise.resolve(value);
}
it("distinguishes a ready API returning no Projects from an absent API without raw values", async () => {
  const missing = workspaceProfileReadinessDiagnostic("dense-lyrics", await observe());
  expect(missing).toContain("apiExposed=false");
  const empty = workspaceProfileReadinessDiagnostic(
    "dense-lyrics",
    await observe({ list: async () => ({ type: "project.list", projects: [] }) }),
  );
  expect(empty).toContain("listType=list listCount=0 expectedListed=false");
});
it("retains only fixture identity booleans and bounded lyric counts from a snapshot", async () => {
  const value = await observe({
    list: async () => ({
      type: "project.list",
      projects: [{ projectId: "expected", private: "/private" }],
    }),
    getSnapshot: async () => ({
      type: "project.snapshot",
      project: {
        id: "expected",
        lyricsDocuments: [{ lines: Array(10001).fill("secret"), tokens: ["token"] }],
        private: "/private",
      },
    }),
  });
  const line = workspaceProfileReadinessDiagnostic("dense-lyrics", value);
  expect(line).toContain(
    "snapshotType=snapshot snapshotMatches=true lyricLines=10000 lyricTokens=1",
  );
  expect(line).not.toMatch(/private|secret|token/);
});
it("does not expose read rejection details", async () => {
  const line = workspaceProfileReadinessDiagnostic(
    "dense-lyrics",
    await observe({
      list: async () => {
        throw new Error("/private");
      },
    }),
  );
  expect(line).toContain("status=error");
  expect(line).not.toContain("/private");
});
it("stops at the deadline and never requests a snapshot after a late listing", async () => {
  vi.useFakeTimers();
  try {
    let resolve!: (value: object) => void;
    const getSnapshot = vi.fn<() => Promise<unknown>>();
    const pending = observe({
      list: () =>
        new Promise<object>((done) => {
          resolve = done;
        }),
      getSnapshot,
    });
    await vi.advanceTimersByTimeAsync(750);
    expect(workspaceProfileReadinessDiagnostic("dense-lyrics", await pending)).toContain(
      "status=deadline",
    );
    resolve({ type: "project.list", projects: [{ projectId: "expected" }] });
    await Promise.resolve();
    expect(getSnapshot).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});
it("refuses private or malformed diagnostic objects and fixture names", async () => {
  const value = await observe();
  expect(workspaceProfileReadinessDiagnostic("/private", value)).toBe(
    "Workspace profile readiness: invalid_evidence",
  );
  if (typeof value !== "object" || value === null) throw new Error("Fixture missing");
  expect(workspaceProfileReadinessDiagnostic("dense-lyrics", { ...value, path: "/private" })).toBe(
    "Workspace profile readiness: invalid_evidence",
  );
});

it("retains only a fixed refusal code rather than the private API message", async () => {
  const value = await observe({
    list: async () => ({ type: "desktop.error", code: "project_read_only", message: "/private" }),
  });
  const line = workspaceProfileReadinessDiagnostic("dense-lyrics", value);
  expect(line).toContain("refusalCode=project_read_only");
  expect(line).not.toContain("/private");
});

it("distinguishes the outer host timeout from malformed evidence", () => {
  expect(workspaceProfileReadinessDiagnostic("dense-lyrics", null)).toBe(
    "Workspace profile readiness: fixture=dense-lyrics status=host_timeout",
  );
});

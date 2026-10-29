import { z } from "zod";

const schema = z.strictObject({
  status: z.enum(["complete", "deadline", "error"]),
  apiExposed: z.boolean(),
  refusalCode: z.enum([
    "none",
    "busy",
    "capability_unavailable",
    "internal_error",
    "invalid_media",
    "invalid_command",
    "invalid_generation",
    "project_not_found",
    "project_read_only",
    "source_unavailable",
    "stale_revision",
    "unauthorized_sender",
  ]),
  emptyBefore: z.boolean(),
  emptyAfter: z.boolean(),
  sliderBefore: z.boolean(),
  sliderAfter: z.boolean(),
  alertPresent: z.boolean(),
  listType: z.enum(["not_checked", "list", "error"]),
  listCount: z.number().int().min(0).max(2),
  expectedListed: z.boolean(),
  snapshotType: z.enum(["not_checked", "snapshot", "error"]),
  snapshotMatches: z.boolean(),
  lyricLines: z.number().int().min(0).max(10000),
  lyricTokens: z.number().int().min(0).max(10000),
});

// Self-contained for page.evaluate; reads only after the original readiness assertion fails.
export async function readWorkspaceProfileReadiness(expectedProjectId: string) {
  const empty = () => document.querySelector("#empty-heading") !== null;
  const slider = () => document.querySelector('[aria-label="Project position"]') !== null;
  const api = window.openChords?.project;
  const state = {
    status: "complete" as "complete" | "deadline" | "error",
    apiExposed: api !== undefined,
    refusalCode: "none",
    emptyBefore: empty(),
    emptyAfter: empty(),
    sliderBefore: slider(),
    sliderAfter: slider(),
    alertPresent: document.querySelector('[role="alert"]') !== null,
    listType: "not_checked" as "not_checked" | "list" | "error",
    listCount: 0,
    expectedListed: false,
    snapshotType: "not_checked" as "not_checked" | "snapshot" | "error",
    snapshotMatches: false,
    lyricLines: 0,
    lyricTokens: 0,
  };
  const deadline = Date.now() + 750;
  let active = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<typeof state>((resolve) => {
    timer = setTimeout(() => {
      active = false;
      resolve({ ...state, status: "deadline" });
    }, 750);
  });
  const read = async () => {
    if (!api) return state;
    try {
      const listed = await api.list();
      if (!active || Date.now() >= deadline) return { ...state, status: "deadline" as const };
      state.listType = listed.type === "project.list" ? "list" : "error";
      if (listed.type === "desktop.error") state.refusalCode = listed.code;
      if (listed.type === "project.list") {
        state.listCount = Math.min(2, listed.projects.length);
        state.expectedListed = listed.projects.some(
          (entry) => entry.projectId === expectedProjectId,
        );
        if (state.expectedListed) {
          const snapshot = await api.getSnapshot(expectedProjectId);
          if (!active || Date.now() >= deadline) return { ...state, status: "deadline" as const };
          state.snapshotType = snapshot.type === "project.snapshot" ? "snapshot" : "error";
          if (snapshot.type === "desktop.error") state.refusalCode = snapshot.code;
          if (snapshot.type === "project.snapshot") {
            state.snapshotMatches = snapshot.project.id === expectedProjectId;
            state.lyricLines = Math.min(
              10000,
              snapshot.project.lyricsDocuments.reduce((sum, item) => sum + item.lines.length, 0),
            );
            state.lyricTokens = Math.min(
              10000,
              snapshot.project.lyricsDocuments.reduce((sum, item) => sum + item.tokens.length, 0),
            );
          }
        }
      }
      state.emptyAfter = empty();
      state.sliderAfter = slider();
      return state;
    } catch {
      return { ...state, status: "error" as const };
    }
  };
  try {
    return await Promise.race([read(), expiry]);
  } finally {
    active = false;
    clearTimeout(timer);
  }
}

export function workspaceProfileReadinessDiagnostic(fixture: string, value: unknown) {
  if (!["short", "many-events", "dense-events", "long-song", "dense-lyrics"].includes(fixture))
    return "Workspace profile readiness: invalid_evidence";
  if (value === null) return `Workspace profile readiness: fixture=${fixture} status=host_timeout`;
  const parsed = schema.safeParse(value);
  if (!parsed.success) return "Workspace profile readiness: invalid_evidence";
  return (
    `Workspace profile readiness: fixture=${fixture} ` +
    Object.entries(parsed.data)
      .map(([key, item]) => `${key}=${item}`)
      .join(" ")
  );
}

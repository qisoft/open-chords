import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test } from "vitest";

import {
  inspectDataCleanup,
  performDataCleanup,
  runDataCleanup,
} from "../apps/desktop/src/main/data-cleanup.ts";
import { openProjectLibrary } from "../apps/desktop/src/main/project-library.ts";

const roots: string[] = [];
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "oc-cleanup-")));
  roots.push(root);
  const state = join(root, "state");
  await mkdir(state);
  await openProjectLibrary({ stateRoot: state });
  for (const name of ["models", "offline-media-cache", "Cache"]) {
    await mkdir(join(state, name));
    await writeFile(join(state, name, "fixture"), name);
  }
  await writeFile(join(state, "network-mode.json"), '{"offline":true}');
  await writeFile(join(state, "user-recording.wav"), "preserve unknown data");
  await writeFile(join(root, "export.pdf"), "preserve export");
  return { root, state };
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

test("inspection is read-only and separately enumerates irreplaceable Projects, models, offline copies, settings and application caches", async () => {
  const { state } = await fixture();
  const before = await readdir(state);
  const plan = await inspectDataCleanup(state);
  expect(plan.groups.map((group) => group.category)).toEqual([
    "projects",
    "models",
    "offline_media",
    "settings",
    "application_state",
  ]);
  expect(plan.groups.find((group) => group.category === "projects")!.paths).toContain(
    join(state, "project-library", "objects"),
  );
  expect(plan.preserved).toContain(join(state, "user-recording.wav"));
  expect(await readdir(state)).toEqual(before);
  expect((await inspectDataCleanup(state)).id).toBe(plan.id);
});

test("only confirmed categories are removed; Library data, unselected settings, unknown files and external exports survive", async () => {
  const { root, state } = await fixture();
  const plan = await inspectDataCleanup(state);
  const result = await performDataCleanup(state, plan.id, ["models", "offline_media"]);
  expect(result.failed).toEqual([]);
  expect(result.removed).toEqual([join(state, "models"), join(state, "offline-media-cache")]);
  expect(await readFile(join(state, "project-library", "project-index.json"), "utf8")).toContain(
    "rebuildable-project-index",
  );
  expect(await readFile(join(state, "network-mode.json"), "utf8")).toContain("offline");
  expect(await readFile(join(state, "user-recording.wav"), "utf8")).toBe("preserve unknown data");
  expect(await readFile(join(root, "export.pdf"), "utf8")).toBe("preserve export");
});

test("changed inventories and invalid or empty confirmations refuse every deletion", async () => {
  const { state } = await fixture();
  const plan = await inspectDataCleanup(state);
  await expect(performDataCleanup(state, plan.id, [])).rejects.toThrow("Confirm");
  await expect(performDataCleanup(state, plan.id, ["models", "models"])).rejects.toThrow("Confirm");
  await writeFile(join(state, "models", "new-pack"), "changed");
  await expect(performDataCleanup(state, plan.id, ["projects", "models"])).rejects.toThrow(
    "changed",
  );
  expect(await readFile(join(state, "models", "fixture"), "utf8")).toBe("models");
  expect(await readdir(join(state, "project-library"))).toContain("objects");
});

test("final cancellation preserves even categories selected in earlier prompts", async () => {
  const { state } = await fixture();
  const prompts: string[] = [];
  await runDataCleanup(state, async (request) => {
    prompts.push(request.kind);
    return request.kind === "category";
  });
  expect(prompts).toEqual(["category", "category", "category", "category", "category", "final"]);
  expect(await readFile(join(state, "models", "fixture"), "utf8")).toBe("models");
});

test("selecting every category removes all enumerated data and reports preserved unknown files", async () => {
  const { state } = await fixture();
  let report = "";
  await runDataCleanup(state, async (request) => {
    if (request.kind === "result") report = request.detail;
    return true;
  });
  expect(await readdir(state)).toEqual(["project-library", "user-recording.wav"]);
  expect(await readdir(join(state, "project-library"))).toEqual([]);
  expect(report).toContain(join(state, "user-recording.wav"));
  expect(report).toContain("None");
});

test.each(["export-pending", "alignment-workspaces", "acquisition-jobs/workspaces"])(
  "interrupted %s must be recovered before any cleanup",
  async (name) => {
    const { state } = await fixture();
    await mkdir(join(state, name), { recursive: true });
    await writeFile(join(state, name, "pending"), "preserve recovery journal");
    await expect(inspectDataCleanup(state)).rejects.toThrow("Interrupted work");
    expect(await readFile(join(state, "models", "fixture"), "utf8")).toBe("models");
  },
);

test("pending Library relocation blocks cleanup", async () => {
  const { state } = await fixture();
  await writeFile(join(state, "project-library-relocation.json"), "{}");
  await expect(inspectDataCleanup(state)).rejects.toThrow("Interrupted work");
});

test("real relocated Library is enumerated with the retained default copy; external source/export remains untouched", async () => {
  const { root, state } = await fixture();
  const library = await openProjectLibrary({ stateRoot: state });
  const target = join(root, "relocated");
  await library.relocate(target);
  const plan = await inspectDataCleanup(state);
  const paths = plan.groups.find((group) => group.category === "projects")!.paths;
  expect(paths).toContain(join(target, "objects"));
  expect(paths).toContain(join(state, "project-library", "objects"));
  const result = await performDataCleanup(state, plan.id, ["projects"]);
  expect(result.failed).toEqual([]);
  expect(await readdir(target)).toEqual([]);
  expect(await readdir(join(state, "project-library"))).toEqual([]);
  expect(await readFile(join(root, "export.pdf"), "utf8")).toBe("preserve export");
});

test("an arbitrary or overlapping external location never authorizes deletion", async () => {
  const { root, state } = await fixture();
  const location = (activeRoot: string) =>
    JSON.stringify({
      activeRoot,
      format: "open-chords/project-library-location",
      schemaVersion: "1.0",
    });
  await writeFile(join(state, "project-library-location.json"), location(root));
  await expect(inspectDataCleanup(state)).rejects.toThrow("Unsafe Library");
  const unrelated = join(root, "unrelated");
  await mkdir(unrelated);
  await writeFile(join(unrelated, "objects"), "user data");
  await writeFile(join(state, "project-library-location.json"), location(unrelated));
  await expect(inspectDataCleanup(state)).rejects.toThrow(/ENOENT/);
  expect(await readFile(join(unrelated, "objects"), "utf8")).toBe("user data");
});

test("a nested symbolic link is refused without touching its target", async () => {
  const { root, state } = await fixture();
  await symlink(join(root, "export.pdf"), join(state, "models", "escape"), "file");
  await expect(inspectDataCleanup(state)).rejects.toThrow("symbolic links");
  expect(await readFile(join(root, "export.pdf"), "utf8")).toBe("preserve export");
});

import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, readdir, realpath, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { z } from "zod";

import { syncDirectory } from "./filesystem-durability.ts";

export const CLEANUP_ARGUMENT = "--open-chords-cleanup";
const LOCATION = "project-library-location.json";
const libraryNames = [
  "objects",
  "projects",
  "quarantine",
  "reports",
  "staging",
  "trash",
  "project-index.json",
  "source-catalog.json",
  "source-catalog.backup.json",
  "youtube-sources.json",
  "source-snapshots",
];
const categories = {
  projects: {
    label: "Projects, revisions, Library Trash and Source records (irreplaceable)",
    names: [LOCATION],
  },
  models: {
    label: "Installed language packs and models (can be downloaded again)",
    names: ["models"],
  },
  offline_media: {
    label: "Offline Media Cache (offline playback copies will be lost)",
    names: ["offline-media-cache"],
  },
  settings: {
    label: "Settings and completed acquisition history",
    names: ["network-mode.json", "acquisition-jobs"],
  },
  application_state: {
    label: "Application caches, logs and browser state",
    names: [
      "Cache",
      "Code Cache",
      "GPUCache",
      "DawnGraphiteCache",
      "DawnWebGPUCache",
      "Local Storage",
      "Session Storage",
      "Preferences",
      "Local State",
      "Network",
      "blob_storage",
      "Crashpad",
      "logs",
      "Dictionaries",
      "alignment-workspaces",
      "export-pending",
    ],
  },
} as const;
export type CleanupCategory = keyof typeof categories;
export type CleanupPlan = {
  id: string;
  stateRoot: string;
  groups: { category: CleanupCategory; label: string; paths: string[] }[];
  preserved: string[];
};
const LocationSchema = z.strictObject({
  activeRoot: z.string().min(1),
  format: z.literal("open-chords/project-library-location"),
  schemaVersion: z.literal("1.0"),
});

function missing(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
async function exists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
}
async function canonicalDirectory(path: string) {
  if (
    !isAbsolute(path) ||
    resolve(path) !== path ||
    (await realpath(path)) !== path ||
    !(await lstat(path)).isDirectory()
  )
    throw new Error("Cleanup requires a real, canonical directory");
}
async function readRecord(path: string) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.size > 64 * 1024) throw new Error("Invalid cleanup metadata");
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}
function nested(parent: string, child: string) {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

/** Inspect fixed application-owned locations without opening, migrating or scavenging a Library. */
export async function inspectDataCleanup(stateRoot: string): Promise<CleanupPlan> {
  await canonicalDirectory(stateRoot);
  for (const name of [
    "project-library-relocation.json",
    "export-pending",
    "alignment-workspaces",
    "acquisition-jobs/workspaces",
  ]) {
    const path = join(stateRoot, name);
    if (!(await exists(path))) continue;
    const stat = await lstat(path);
    if (!stat.isDirectory() || (await readdir(path)).length > 0)
      throw new Error("Interrupted work requires normal application recovery before cleanup");
  }
  const groups: CleanupPlan["groups"] = [];
  const recognized = new Set<string>();
  for (const category of [
    "projects",
    "models",
    "offline_media",
    "settings",
    "application_state",
  ] as const) {
    const definition = categories[category];
    const paths: string[] = [];
    for (const name of definition.names) {
      recognized.add(name);
      const path = join(stateRoot, name);
      if (await exists(path)) paths.push(path);
    }
    groups.push({ category, label: definition.label, paths });
  }
  const preserved = (await readdir(stateRoot))
    .filter((name) => !recognized.has(name) && name !== "project-library")
    .map((name) => join(stateRoot, name));
  const roots = new Set([join(stateRoot, "project-library")]);
  if (await exists(join(stateRoot, LOCATION))) {
    const location = LocationSchema.parse(await readRecord(join(stateRoot, LOCATION)));
    if (!isAbsolute(location.activeRoot)) throw new Error("Invalid Library location");
    roots.add(location.activeRoot);
  }
  const projectGroup = groups.find((group) => group.category === "projects")!;
  for (const root of roots) {
    if (!(await exists(root))) continue;
    await canonicalDirectory(root);
    if (
      nested(root, stateRoot) ||
      (nested(stateRoot, root) && root !== join(stateRoot, "project-library"))
    )
      throw new Error("Unsafe Library location for cleanup");
    const names = (await readdir(root)).sort();
    if (root !== join(stateRoot, "project-library")) {
      const index = z
        .object({
          format: z.literal("open-chords/rebuildable-project-index"),
          schemaVersion: z.literal("1.0"),
        })
        .parse(await readRecord(join(root, "project-index.json")));
      if (!index || names.some((name) => !libraryNames.includes(name)))
        throw new Error("External Library needs manual inspection before cleanup");
    }
    for (const name of names) {
      if (libraryNames.includes(name)) projectGroup.paths.push(join(root, name));
      else preserved.push(join(root, name));
    }
  }
  const hash = createHash("sha256");
  let entries = 0;
  async function inventory(path: string, depth = 0): Promise<void> {
    if (++entries > 100_000 || depth > 64)
      throw new Error("Cleanup inventory exceeds its inspection limit");
    const stat = await lstat(path, { bigint: true });
    if (!stat.isFile() && !stat.isDirectory())
      throw new Error("Cleanup refuses symbolic links and special files");
    hash.update(
      JSON.stringify([
        path,
        String(stat.dev),
        String(stat.ino),
        String(stat.mode),
        String(stat.size),
        String(stat.mtimeNs),
        String(stat.ctimeNs),
      ]),
    );
    if (stat.isDirectory())
      for (const name of (await readdir(path)).sort()) await inventory(join(path, name), depth + 1);
  }
  hash.update(JSON.stringify({ stateRoot, groups, preserved }));
  // Include directory identity and location bytes, so replacing a parent or retargeting the Library invalidates confirmation.
  for (const parent of new Set([stateRoot, ...projectGroup.paths.map(dirname)])) {
    const stat = await lstat(parent, { bigint: true });
    hash.update(JSON.stringify([parent, String(stat.dev), String(stat.ino)]));
  }
  if (await exists(join(stateRoot, LOCATION)))
    hash.update(await readFile(join(stateRoot, LOCATION)));
  for (const group of groups) for (const path of group.paths) await inventory(path);
  return { id: hash.digest("hex"), stateRoot, groups, preserved };
}

/** Delete only independently confirmed categories from an unchanged, freshly derived inventory. */
export async function performDataCleanup(
  stateRoot: string,
  expectedPlanId: string,
  confirmed: CleanupCategory[],
) {
  if (
    confirmed.length === 0 ||
    new Set(confirmed).size !== confirmed.length ||
    confirmed.some((category) => !Object.hasOwn(categories, category))
  )
    throw new Error("Confirm at least one distinct cleanup category");
  const plan = await inspectDataCleanup(stateRoot);
  if (plan.id !== expectedPlanId)
    throw new Error("Cleanup inventory changed; inspect and confirm again");
  const removed: string[] = [];
  const failed: string[] = [];
  for (const group of plan.groups) {
    if (!confirmed.includes(group.category)) continue;
    // Keep the active Library pointer until its enumerated contents have been removed.
    for (const path of group.paths.toSorted(
      (a, b) => Number(a.endsWith(LOCATION)) - Number(b.endsWith(LOCATION)),
    )) {
      if (failed.length > 0) break;
      const claim = join(dirname(path), `.open-chords-cleanup-${randomUUID()}`);
      try {
        await canonicalDirectory(dirname(path));
        const before = await lstat(path, { bigint: true });
        await rename(path, claim);
        const after = await lstat(claim, { bigint: true });
        if (before.dev !== after.dev || before.ino !== after.ino || before.mode !== after.mode)
          throw new Error("Cleanup claim changed");
        await rm(claim, { recursive: true });
        await syncDirectory(dirname(path));
        removed.push(path);
      } catch {
        failed.push((await exists(claim)) ? claim : path);
      }
    }
  }
  return { removed, failed, preserved: plan.preserved };
}

export type CleanupPrompt = (request: {
  kind: "category" | "final" | "result";
  message: string;
  detail: string;
}) => Promise<boolean>;

/** Cold-start workflow: category selection never deletes, and final cancellation preserves everything. */
export async function runDataCleanup(stateRoot: string, prompt: CleanupPrompt) {
  const plan = await inspectDataCleanup(stateRoot);
  const confirmed: CleanupCategory[] = [];
  for (const group of plan.groups) {
    if (group.paths.length === 0) continue;
    if (
      await prompt({
        kind: "category",
        message: group.label,
        detail: `Permanently delete this category?\n\n${group.paths.join("\n")}\n\nSkipping preserves this category. Source media, exported files and Portable Project Archives outside these locations are preserved.`,
      })
    )
      confirmed.push(group.category);
  }
  if (confirmed.length === 0) return undefined;
  const selected = plan.groups.filter((group) => confirmed.includes(group.category));
  if (
    !(await prompt({
      kind: "final",
      message: "Permanently delete the selected data?",
      detail:
        selected.map((group) => `${group.label}\n${group.paths.join("\n")}`).join("\n\n") +
        "\n\nThis cannot be undone. Unknown files and previous Library copies are preserved. The application will exit afterwards.",
    }))
  )
    return undefined;
  const result = await performDataCleanup(stateRoot, plan.id, confirmed);
  await prompt({
    kind: "result",
    message: result.failed.length
      ? "Cleanup stopped after a failure"
      : "Selected cleanup completed",
    detail: `Removed:\n${result.removed.join("\n") || "None"}\n\nFailed (inspect before retrying):\n${result.failed.join("\n") || "None"}\n\nUnknown files preserved:\n${result.preserved.join("\n") || "None"}\n\nUnselected categories, Source files, external exports/archives and previous Library copies remain. Remove the application separately if desired.`,
  });
  return result;
}

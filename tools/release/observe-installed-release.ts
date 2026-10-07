import { join } from "node:path";

import { extractFile } from "@electron/asar";
import { FuseState, FuseV1Options, getCurrentFuseWire } from "@electron/fuses";
import { z } from "zod";

import {
  isMachOExecuteSlice,
  MACH_O_HEADER_BYTES,
  machOFirstSliceOffset,
  readPeFacts,
} from "./binary-headers.ts";
import { observeDarwinExecutable, readBundleIdentifier } from "./darwin-signatures.ts";
import { readFilePrefix, walkInstalledTree } from "./installed-tree.ts";
import {
  InstalledObservationSchema,
  type DarwinExecutable,
  type InstalledEntry,
  type InstalledObservation,
  type WindowsExecutable,
} from "./release-manifest.ts";
import { INSTALLED_LAYOUT, type ReleaseTarget } from "./release-target.ts";

const PackageIdentitySchema = z.object({
  name: z.string(),
  productName: z.string(),
  version: z.string(),
});

const FUSE_STATE_NAMES = new Map<unknown, string>([
  [FuseState.ENABLE, "enable"],
  [FuseState.DISABLE, "disable"],
  [FuseState.REMOVED, "removed"],
  [FuseState.INHERIT, "inherit"],
]);

async function readFuses(executable: string) {
  const { version, ...wire } = await getCurrentFuseWire(executable);
  const options = Object.fromEntries(
    Object.entries(wire).map(([index, state]: [string, unknown]) => {
      const name = FuseV1Options[Number(index)];
      const stateName = FUSE_STATE_NAMES.get(state);
      if (name === undefined || stateName === undefined) {
        throw new Error(`Installed fuse wire has an unknown fuse ${index}=${String(state)}`);
      }
      return [name, stateName];
    }),
  );
  return { version, options };
}

function files(entries: readonly InstalledEntry[]) {
  return entries.filter((entry) => entry.kind === "file");
}

async function isMachOExecutable(path: string): Promise<boolean> {
  const header = await readFilePrefix(path, 32);
  const offset = machOFirstSliceOffset(header);
  if (offset === undefined) return false;
  const slice = offset === 0 ? header : await readFilePrefix(path, MACH_O_HEADER_BYTES, offset);
  return isMachOExecuteSlice(slice);
}

async function observeDarwinExecutables(
  root: string,
  entries: readonly InstalledEntry[],
): Promise<DarwinExecutable[]> {
  const executables: DarwinExecutable[] = [];
  for (const entry of files(entries)) {
    const absolute = join(root, entry.path);
    if (await isMachOExecutable(absolute)) {
      executables.push(observeDarwinExecutable(absolute, entry.path));
    }
  }
  return executables;
}

async function observeWindowsExecutables(
  root: string,
  entries: readonly InstalledEntry[],
): Promise<WindowsExecutable[]> {
  const executables: WindowsExecutable[] = [];
  for (const entry of files(entries)) {
    if (!entry.path.toLowerCase().endsWith(".exe")) continue;
    const facts = readPeFacts(await readFilePrefix(join(root, entry.path), 64 * 1024));
    if (facts !== undefined) executables.push({ path: entry.path, ...facts });
  }
  return executables;
}

export async function observeInstalledRelease(
  root: string,
  target: ReleaseTarget,
): Promise<InstalledObservation> {
  const layout = INSTALLED_LAYOUT[target.platform];
  const entries = await walkInstalledTree(root);
  const asar = join(root, layout.resources, "app.asar");
  const packageJson = PackageIdentitySchema.parse(
    JSON.parse(extractFile(asar, "package.json").toString("utf8")),
  );
  const mainBundle = extractFile(asar, join("dist", "main", "main.cjs")).toString("utf8");
  const trustAnchors = layout.trustAnchors.map((path) => {
    const entry = files(entries).find((candidate) => candidate.path === path);
    if (entry === undefined) throw new Error(`Installed runtime manifest ${path} is missing`);
    if (!mainBundle.includes(entry.sha256)) {
      throw new Error(`Installed main bundle does not anchor ${path} (${entry.sha256})`);
    }
    return { path, sha256: entry.sha256 };
  });
  const common = {
    entries,
    identity: {
      packageName: packageJson.name,
      productName: packageJson.productName,
      version: packageJson.version,
    },
    fuses: await readFuses(join(root, layout.mainExecutable)),
    trustAnchors,
  };
  return InstalledObservationSchema.parse(
    target.platform === "darwin"
      ? {
          platform: "darwin",
          ...common,
          bundleIdentifier: readBundleIdentifier(join(root, INSTALLED_LAYOUT.darwin.infoPlist)),
          executables: await observeDarwinExecutables(root, entries),
        }
      : {
          platform: "win32",
          ...common,
          executables: await observeWindowsExecutables(root, entries),
        },
  );
}

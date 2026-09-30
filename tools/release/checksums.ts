import { readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { sha256File } from "./installed-tree.ts";
import { readReleaseManifests } from "./manifest-files.ts";

export const CHECKSUMS_FILE = "SHA256SUMS";

export async function writeChecksums(assetsDirectory: string): Promise<string> {
  const files = (await readdir(assetsDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name !== CHECKSUMS_FILE)
    .map((entry) => entry.name)
    .toSorted();
  const digests = new Map(
    await Promise.all(
      files.map(async (name) => [name, await sha256File(join(assetsDirectory, name))] as const),
    ),
  );
  for (const manifest of await readReleaseManifests(assetsDirectory)) {
    const { bytes, fileName, sha256 } = manifest.archive;
    const matches =
      digests.get(fileName) === sha256 &&
      (await stat(join(assetsDirectory, fileName))).size === bytes;
    if (!matches) {
      throw new Error(`${fileName} does not match the ${manifest.target.id} release manifest`);
    }
  }
  const content = files.map((name) => `${digests.get(name)!}  ${name}\n`).join("");
  await writeFile(join(assetsDirectory, CHECKSUMS_FILE), content);
  return content;
}

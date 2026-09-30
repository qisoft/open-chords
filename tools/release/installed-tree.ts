import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, open, readdir, readlink } from "node:fs/promises";
import { join } from "node:path";

import type { InstalledEntry } from "./release-manifest.ts";

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function readFilePrefix(path: string, bytes: number, position = 0): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, position);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

export async function walkInstalledTree(root: string): Promise<InstalledEntry[]> {
  const entries: InstalledEntry[] = [];
  const visit = async (relativeDirectory: readonly string[]) => {
    const names = await readdir(join(root, ...relativeDirectory));
    for (const name of names) {
      const segments = [...relativeDirectory, name];
      const absolute = join(root, ...segments);
      const path = segments.join("/");
      const stats = await lstat(absolute);
      if (stats.isSymbolicLink()) {
        entries.push({ path, kind: "symlink", target: await readlink(absolute) });
      } else if (stats.isDirectory()) {
        await visit(segments);
      } else if (stats.isFile()) {
        entries.push({
          path,
          kind: "file",
          bytes: stats.size,
          sha256: await sha256File(absolute),
          executable: (stats.mode & 0o111) !== 0,
        });
      } else {
        throw new Error(`Installed tree contains an unsupported file type at ${path}`);
      }
    }
  };
  await visit([]);
  return entries.toSorted((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
}

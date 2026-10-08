import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

export async function proofTreeHashes(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of (await readdir(root, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (entry.isDirectory()) {
      result[`${entry.name}/`] = "directory";
      for (const [name, hash] of Object.entries(await proofTreeHashes(join(root, entry.name))))
        result[`${entry.name}/${name}`] = hash;
    } else if (entry.isFile()) {
      result[entry.name] = createHash("sha256")
        .update(await readFile(join(root, entry.name)))
        .digest("hex");
    } else throw new Error("packaged_proof_special_file");
  }
  return result;
}

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";

import { ModelRuntimeInfoSchema } from "@open-chords/contracts";
import { z } from "zod";

const unavailable = () =>
  ModelRuntimeInfoSchema.parse({
    id: "mfa-3.4.1",
    available: false,
    placement: "bundled",
    installedBytes: 0,
    transferBytes: 0,
  });
const manifestSchema = z.strictObject({
  info: ModelRuntimeInfoSchema,
  platform: z.enum(["darwin-arm64", "win32-x64"]),
  files: z
    .array(
      z.strictObject({
        path: z
          .string()
          .max(600)
          .refine((value) =>
            value
              .split("/")
              .every(
                (part) =>
                  part.length > 0 &&
                  part !== "." &&
                  part !== ".." &&
                  !/[\\:]/.test(part) &&
                  !part.includes(String.fromCharCode(0)),
              ),
          ),
        bytes: z
          .number()
          .int()
          .nonnegative()
          .max(2 * 1024 ** 3),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    )
    .min(1)
    .max(10000),
});
export async function inspectAlignmentRuntime(root: string) {
  try {
    if (!(await lstat(root)).isDirectory()) return unavailable();
    const manifestPath = join(root, "runtime-info.json");
    const stat = await lstat(manifestPath);
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) return unavailable();
    const manifest = manifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf8")));
    if (manifest.platform !== `${process.platform}-${process.arch}` || !manifest.info.available)
      return unavailable();
    const names = manifest.files.map((file) => file.path.toLowerCase());
    if (
      new Set(names).size !== names.length ||
      !names.includes(
        process.platform === "win32" ? "open-chords-alignment.exe" : "open-chords-alignment",
      )
    )
      return unavailable();
    if (manifest.files.reduce((sum, file) => sum + file.bytes, 0) !== manifest.info.installedBytes)
      return unavailable();
    for (const file of manifest.files) {
      let path = root;
      const parts = file.path.split("/");
      for (const part of parts.slice(0, -1)) {
        path = join(path, part);
        if (!(await lstat(path)).isDirectory()) return unavailable();
      }
      path = join(path, parts.at(-1)!);
      const details = await lstat(path);
      if (!details.isFile() || details.size !== file.bytes) return unavailable();
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(path)) hash.update(chunk);
      if (hash.digest("hex") !== file.sha256) return unavailable();
    }
    return manifest.info;
  } catch {
    return unavailable();
  }
}

import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import { copyAcquiredFile } from "../apps/desktop/src/main/acquisition-files.ts";

it("rejects a parent alias, a linked artifact, and a mismatched media hash before handoff", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "open-chords-acquisition-path-")));
  try {
    const data = Buffer.from("synthetic bounded media");
    const expected = {
      bytes: data.length,
      sha256: createHash("sha256").update(data).digest("hex"),
    };
    const directory = join(root, "regular");
    await mkdir(directory);
    const source = join(directory, "media.bin");
    await writeFile(source, data);
    await symlink(directory, join(root, "alias"), "junction");
    await expect(
      copyAcquiredFile(join(root, "alias/media.bin"), join(root, "copied"), expected),
    ).rejects.toThrow("invalid_acquisition_path");
    const hardLink = join(root, "linked.bin");
    await link(source, hardLink);
    await expect(copyAcquiredFile(source, join(root, "copied"), expected)).rejects.toThrow(
      "invalid_acquisition_artifact",
    );
    await rm(hardLink);
    await expect(
      copyAcquiredFile(source, join(root, "wrong"), { ...expected, sha256: "0".repeat(64) }),
    ).rejects.toThrow("invalid_acquisition_artifact");
    await expect(copyAcquiredFile(source, join(root, "copied"), expected)).resolves.toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

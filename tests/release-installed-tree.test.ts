import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import { walkInstalledTree } from "../tools/release/installed-tree.ts";

const A_SHA256 = "87428fc522803d31065e7bce3cf03fe475096631e5e07bbd7a0fde60c4cf25c7";
const B_SHA256 = "0263829989b6fd954f72baaf2fc64bc2e2f01d692d4de72986ea808f6e99813f";
const SCRIPT_SHA256 = "a8076d3d28d21e02012b20eaf7dbf75409a6277134439025f282e368e3305abf";

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "open-chords-installed-tree-"));
  writeFileSync(join(root, "a.txt"), "a\n");
  mkdirSync(join(root, "nested", "deeper"), { recursive: true });
  writeFileSync(join(root, "nested", "deeper", "b.txt"), "b\n", { mode: 0o644 });
  return root;
}

it("lists nested files sorted by POSIX path with their size and digest", async () => {
  const root = fixtureRoot();
  chmodSync(join(root, "a.txt"), 0o644);

  expect(await walkInstalledTree(root)).toEqual([
    { path: "a.txt", kind: "file", bytes: 2, sha256: A_SHA256, executable: false },
    { path: "nested/deeper/b.txt", kind: "file", bytes: 2, sha256: B_SHA256, executable: false },
  ]);
});

it.skipIf(process.platform === "win32")(
  "records executable bits and symlinks without following them",
  async () => {
    const root = fixtureRoot();
    mkdirSync(join(root, "bin"));
    writeFileSync(join(root, "bin", "tool"), "#!/bin/sh\n", { mode: 0o755 });
    symlinkSync("a.txt", join(root, "link"));
    symlinkSync("nested", join(root, "linked-directory"));

    expect(await walkInstalledTree(root)).toEqual([
      { path: "a.txt", kind: "file", bytes: 2, sha256: A_SHA256, executable: false },
      { path: "bin/tool", kind: "file", bytes: 10, sha256: SCRIPT_SHA256, executable: true },
      { path: "link", kind: "symlink", target: "a.txt" },
      { path: "linked-directory", kind: "symlink", target: "nested" },
      { path: "nested/deeper/b.txt", kind: "file", bytes: 2, sha256: B_SHA256, executable: false },
    ]);
  },
);

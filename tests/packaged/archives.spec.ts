import { mkdtemp, readFile, realpath, rm, writeFile, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "@playwright/test";
import extractZip from "extract-zip";

import { PACKAGED_ARCHIVE_PROOF_ARGUMENT } from "../../apps/desktop/src/main/packaged-archive-proof-constants.ts";
import { openProjectLibrary } from "../../apps/desktop/src/main/project-library.ts";
import { prepareArchiveProofFixture } from "../support/archive-proof-fixture.ts";
import { runInstalledExportProcess } from "../support/installed-export-process.ts";

test.skip(
  process.platform !== "darwin" && process.platform !== "win32",
  "Installed native profiles",
);
test("installed archive round-trip, cancellation and hostile corpus preserve durable Library boundaries", async () => {
  test.setTimeout(240000);
  const root = await realpath(await mkdtemp(join(tmpdir(), "oc-installed-archives-")));
  try {
    const stateRoot = join(root, "state");
    await prepareArchiveProofFixture(stateRoot);
    const marker = join(root, "external-marker.txt");
    await writeFile(marker, "private external archive-proof bytes");
    await extractZip(
      join(
        process.cwd(),
        "out/make/zip",
        process.platform,
        process.arch,
        `Open Chords-${process.platform}-${process.arch}-0.0.0.zip`,
      ),
      { dir: join(root, "installed") },
    );
    const executable =
      process.platform === "darwin"
        ? join(root, "installed/Open Chords.app/Contents/MacOS/Open Chords")
        : join(root, "installed/Open Chords.exe");
    const env: NodeJS.ProcessEnv = {};
    for (const key of [
      "SystemRoot",
      "WINDIR",
      "TEMP",
      "TMP",
      "HOME",
      "USERPROFILE",
      "APPDATA",
      "LOCALAPPDATA",
    ]) {
      if (process.env[key]) env[key] = process.env[key];
    }
    if (process.platform === "win32") {
      const windows = process.env.SystemRoot ?? process.env.WINDIR;
      if (!windows) throw new Error("Windows OS directory unavailable");
      env.PATH = [
        join(windows, "System32/WindowsPowerShell/v1.0"),
        join(windows, "System32"),
        windows,
      ].join(";");
    }
    const { stdout, stderr } = await runInstalledExportProcess(
      executable,
      [PACKAGED_ARCHIVE_PROOF_ARGUMENT, `--user-data-dir=${stateRoot}`],
      env,
    );
    expect(JSON.parse(stdout.trim())).toEqual({
      proof: "installed-archives",
      roundtrip: true,
      duplicateUnchanged: true,
      cancellationUnchanged: true,
      rejectedUnchanged: 8,
      durableReopen: true,
    });
    for (const forbidden of [root, "/private/archive-proof", "../escape.json"])
      expect(stdout + stderr).not.toContain(forbidden);
    const imported = await openProjectLibrary({
      stateRoot: join(stateRoot, "archive-proof-import"),
    });
    expect(imported.listProjects()).toHaveLength(1);
    const original = await (await openProjectLibrary({ stateRoot })).readProject("project_golden");
    const reopened = await imported.readProject("project_golden");
    expect(reopened.envelope).toEqual(original.envelope);
    expect(reopened.records.sources[0]!.locators).toEqual([]);
    expect(await readFile(marker, "utf8")).toBe("private external archive-proof bytes");
    for (const escaped of [join(root, "escape.json"), join(stateRoot, "escape.json")])
      await expect(lstat(escaped)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 40, retryDelay: 250 });
  }
});

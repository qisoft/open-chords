import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { expect, test } from "@playwright/test";
import extractZip from "extract-zip";

test.skip(
  process.platform !== "darwin" && process.platform !== "win32",
  "Installed native profiles",
);
test("installed Extractor Worker streams only through the broker with native network denial", async () => {
  // Windows prepares a fresh AppContainer/runtime for each independent scenario.
  const proofTimeout = process.platform === "win32" ? 450000 : 150000;
  test.setTimeout(proofTimeout + 60000);
  const root = await mkdtemp(join(tmpdir(), "open-chords-installed-acquisition-"));
  try {
    await extractZip(
      join(
        process.cwd(),
        "out/make/zip",
        process.platform,
        process.arch,
        `Open Chords-${process.platform}-${process.arch}-0.0.0.zip`,
      ),
      { dir: root },
    );
    const runtime =
      process.platform === "darwin"
        ? join(
            root,
            "Open Chords.app/Contents/XPCServices/OpenChordsAnalysisService.xpc/Contents/Resources/open-chords-acquisition",
          )
        : join(root, "resources/open-chords-acquisition");
    expect(JSON.parse(await readFile(join(runtime, "runtime-info.json"), "utf8"))).toMatchObject({
      version: 1,
      platform: `${process.platform}-${process.arch}`,
    });
    const executable =
      process.platform === "darwin"
        ? join(root, "Open Chords.app/Contents/MacOS/Open Chords")
        : join(root, "Open Chords.exe");
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
      if (process.env[key] !== undefined) env[key] = process.env[key];
    }
    if (process.platform === "win32") {
      const windowsRoot = process.env.SystemRoot ?? process.env.WINDIR;
      if (!windowsRoot) throw new Error("installed_windows_root_missing");
      env.PATH = [
        join(windowsRoot, "System32", "WindowsPowerShell", "v1.0"),
        join(windowsRoot, "System32"),
        windowsRoot,
      ].join(";");
    }
    const { stdout, stderr } = await promisify(execFile)(
      executable,
      ["--open-chords-acquisition-proof", `--user-data-dir=${join(root, "profile")}`],
      { env, timeout: proofTimeout, maxBuffer: 1024 * 1024, windowsHide: true },
    );
    for (const privateValue of [
      root,
      "offline-private-token",
      "private-playlist",
      "private-provider-token",
      "Private fixture title",
    ]) {
      expect(stdout + stderr).not.toContain(privateValue);
    }
    const report = JSON.parse(stdout.trim());
    expect(report).toMatchObject({
      proof: "brokered-extractor",
      workerNetworkDenied: true,
      helperNetworkDenied: true,
      mediaBytes: 50000,
      requests: 2,
      activeStreams: 0,
      workspaceRemoved: true,
      snapshotPublished: true,
      snapshotReopened: true,
      snapshotProjectCompatible: true,
      temporaryMediaRemoved: true,
      jobState: "succeeded",
      botCheckNoSnapshot: true,
      offlineCancellationClean: true,
      offlineReopenDnsCalls: 0,
      offlineReopenHttpCalls: 0,
      offlineReopenLibraryUnchanged: true,
      offlineHistoryRedacted: true,
      mismatchedMediaNoSnapshot: true,
      oversizedDurationNoSnapshot: true,
      initializationCleanupRecoverable: true,
      offlineDuringStartCancelled: true,
      closeDuringStartReaped: true,
      closeFailureRedacted: true,
    });
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 40, retryDelay: 250 });
  }
});

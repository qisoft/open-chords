import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { ProjectEnvelopeSchema } from "@open-chords/contracts";
import { expect, test } from "@playwright/test";
import extractZip from "extract-zip";
import { z } from "zod";

import { openNetworkMode } from "../../apps/desktop/src/main/network-mode.ts";
import { openProjectLibrary } from "../../apps/desktop/src/main/project-library.ts";
import { goldenRecords } from "../support/editor-fixture.ts";

// UI Automation drives actual Windows OS dialogs; macOS native interaction remains a gate.
test.skip(process.platform !== "win32", "Windows installed native cleanup dialogs");
const execute = promisify(execFile);
let installation: string;

test.beforeAll(async () => {
  test.setTimeout(120000);
  installation = await realpath(await mkdtemp(join(tmpdir(), "oc-cleanup-install-")));
  await extractZip(
    join(
      process.cwd(),
      "out/make/zip/win32",
      process.arch,
      `Open Chords-win32-${process.arch}-0.0.0.zip`,
    ),
    { dir: installation },
  );
});
test.afterAll(async () => {
  if (installation)
    await rm(installation, { recursive: true, force: true, maxRetries: 40, retryDelay: 250 });
});

async function fingerprints(root: string) {
  const result: Record<string, string> = {};
  async function visit(directory: string, prefix: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const name = `${prefix}${entry.name}`;
      if (entry.isDirectory()) await visit(join(directory, entry.name), `${name}/`);
      else if (entry.isFile())
        result[name] = createHash("sha256")
          .update(await readFile(join(directory, entry.name)))
          .digest("hex");
      else throw new Error("Unexpected cleanup fixture file type");
    }
  }
  await visit(root, "");
  return result;
}

for (const scenario of ["unchecked", "cancel-final", "confirm-models"] as const) {
  test(`installed Windows cleanup native confirmation: ${scenario}`, async () => {
    test.setTimeout(180000);
    const root = await realpath(await mkdtemp(join(tmpdir(), "oc-cleanup-data-")));
    const state = join(root, "state");
    let child: ReturnType<typeof spawn> | undefined;
    try {
      await (await openNetworkMode(state)).setOffline(true);
      const library = await openProjectLibrary({ stateRoot: state });
      await library.createProject({
        envelope: ProjectEnvelopeSchema.parse(
          JSON.parse(
            await readFile("packages/testkit/contracts/v1/valid/project-envelope.json", "utf8"),
          ),
        ),
        records: goldenRecords(),
      });
      await mkdir(join(state, "models"));
      await writeFile(join(state, "models", "preserved-fixture"), "model preservation fixture");
      await writeFile(join(state, "unknown-private-file"), "unknown user data");
      await writeFile(join(root, "external-source.wav"), "external fixture bytes");
      const originalLibrary = await fingerprints(join(state, "project-library"));
      const settings = await readFile(join(state, "network-mode.json"));
      const windowsRoot = process.env.SystemRoot ?? process.env.WINDIR;
      if (!windowsRoot) throw new Error("Windows system directory unavailable");
      const env: Record<string, string> = {};
      for (const key of [
        "SystemRoot",
        "WINDIR",
        "TEMP",
        "TMP",
        "USERPROFILE",
        "APPDATA",
        "LOCALAPPDATA",
      ])
        if (process.env[key] !== undefined) env[key] = process.env[key];
      env.PATH = [
        join(windowsRoot, "System32", "WindowsPowerShell", "v1.0"),
        join(windowsRoot, "System32"),
        windowsRoot,
      ].join(";");
      child = spawn(
        join(installation, "Open Chords.exe"),
        ["--open-chords-cleanup", `--user-data-dir=${state}`],
        { env, stdio: "ignore" },
      );
      const exit = new Promise<number | null>((resolve) => {
        child!.once("error", () => resolve(null));
        child!.once("exit", resolve);
      });
      if (!child.pid) throw new Error("Installed cleanup process unavailable");
      const { stdout } = await execute(
        join(windowsRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          join(process.cwd(), "tests/support/installed-cleanup-windows.ps1"),
          "-ApplicationPid",
          String(child.pid),
          "-Scenario",
          scenario,
        ],
        { timeout: 100000, maxBuffer: 16384 },
      );
      const events = z
        .array(z.object({ category: z.string(), checked: z.boolean(), action: z.string() }))
        .parse(JSON.parse(stdout));
      expect(events.some((event) => event.category === "projects")).toBe(true);
      expect(events.find((event) => event.category === "models")).toEqual({
        category: "models",
        checked: scenario !== "unchecked",
        action: "Select for deletion",
      });
      expect(events.find((event) => event.category === "final")).toEqual(
        scenario === "unchecked"
          ? undefined
          : {
              category: "final",
              checked: scenario === "confirm-models",
              action: scenario === "confirm-models" ? "Permanently delete" : "Cancel",
            },
      );
      expect(
        events
          .filter((event) => !["models", "final", "result"].includes(event.category))
          .every((event) => !event.checked),
      ).toBe(true);
      expect(events.some((event) => event.category === "result")).toBe(
        scenario === "confirm-models",
      );
      await expect
        .poll(() => child!.exitCode !== null || child!.signalCode !== null, { timeout: 15000 })
        .toBe(true);
      expect(await exit).toBe(0);
      expect(await fingerprints(join(state, "project-library"))).toEqual(originalLibrary);
      expect(await readFile(join(state, "network-mode.json"))).toEqual(settings);
      expect(await readFile(join(state, "unknown-private-file"), "utf8")).toBe("unknown user data");
      expect(await readFile(join(root, "external-source.wav"), "utf8")).toBe(
        "external fixture bytes",
      );
      if (scenario === "confirm-models")
        await expect(readFile(join(state, "models", "preserved-fixture"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      else
        expect(await readFile(join(state, "models", "preserved-fixture"), "utf8")).toBe(
          "model preservation fixture",
        );
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill();
        await expect
          .poll(() => child!.exitCode !== null || child!.signalCode !== null, { timeout: 15000 })
          .toBe(true);
      }
      await rm(root, { force: true, recursive: true, maxRetries: 40, retryDelay: 250 });
    }
  });
}

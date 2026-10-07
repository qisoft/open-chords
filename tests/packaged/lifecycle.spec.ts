import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CONTRACT_VERSION, ProjectEnvelopeSchema } from "@open-chords/contracts";
import { chromium, expect, test } from "@playwright/test";
import extractZip from "extract-zip";

import { openNetworkMode } from "../../apps/desktop/src/main/network-mode.ts";
import { openProjectLibrary } from "../../apps/desktop/src/main/project-library.ts";
import { goldenRecords } from "../support/editor-fixture.ts";

test.skip(
  process.platform !== "darwin" && process.platform !== "win32",
  "Installed desktop profiles",
);

const archive = join(
  process.cwd(),
  "out/make/zip",
  process.platform,
  process.arch,
  `Open Chords-${process.platform}-${process.arch}-0.0.0.zip`,
);
function envelope(version: string) {
  const value = ProjectEnvelopeSchema.parse(
    JSON.parse(readFileSync("packages/testkit/contracts/v1/valid/project-envelope.json", "utf8")),
  );
  value.schemaVersion = version;
  value.payload.schemaVersion = version;
  return value;
}
async function installed(installation: string, state: string) {
  await extractZip(archive, { dir: installation });
  const executable =
    process.platform === "darwin"
      ? join(installation, "Open Chords.app/Contents/MacOS/Open Chords")
      : join(installation, "Open Chords.exe");
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Debug port unavailable");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  // No inherited developer PATH, Python/Conda/Homebrew configuration or runtime variables.
  const env: Record<string, string> = {};
  for (const key of [
    "SystemRoot",
    "WINDIR",
    "TEMP",
    "TMP",
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
  ])
    if (process.env[key] !== undefined) env[key] = process.env[key];
  if (process.platform === "win32") {
    const windowsRoot = env.SystemRoot ?? env.WINDIR;
    if (!windowsRoot) throw new Error("Windows system directory is unavailable");
    // Library path policy needs the OS PowerShell/CIM tools, not a developer runtime.
    env.PATH = [
      join(windowsRoot, "System32", "WindowsPowerShell", "v1.0"),
      join(windowsRoot, "System32"),
      windowsRoot,
    ].join(";");
  }
  const child = spawn(
    executable,
    [`--user-data-dir=${state}`, `--remote-debugging-port=${address.port}`],
    { env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let diagnostics = "";
  const capture = (chunk: Buffer) => {
    diagnostics = (diagnostics + chunk.toString("utf8")).slice(-64 * 1024);
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  child.on("error", (error) => {
    diagnostics += error.message;
  });
  async function terminate() {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await expect
      .poll(() => child.exitCode !== null || child.signalCode !== null, { timeout: 15000 })
      .toBe(true);
  }
  const endpoint = `http://127.0.0.1:${address.port}`;
  try {
    await expect
      .poll(
        () => {
          if (child.exitCode !== null || child.signalCode !== null)
            throw new Error(
              `Installed application exited before debug endpoint: code=${child.exitCode} signal=${child.signalCode}; ${diagnostics}`,
            );
          return fetch(`${endpoint}/json/version`).then(
            (response) => response.ok,
            () => false,
          );
        },
        { timeout: 30000 },
      )
      .toBe(true);
    const browser = await chromium.connectOverCDP(endpoint);
    try {
      const context = browser.contexts()[0]!;
      await expect
        .poll(
          () => {
            if (child.exitCode !== null || child.signalCode !== null)
              throw new Error(
                `Installed application exited before renderer: code=${child.exitCode} signal=${child.signalCode}; ${diagnostics}`,
              );
            return context.pages().some((page) => page.url().startsWith("open-chords://"));
          },
          {
            timeout: 30000,
          },
        )
        .toBe(true);
      const page = context
        .pages()
        .find((candidate) => candidate.url().startsWith("open-chords://"))!;
      let closed = false;
      return {
        page,
        async close() {
          if (closed) return;
          closed = true;
          try {
            const cdp = await browser.newBrowserCDPSession();
            void cdp.send("Browser.close").catch(() => undefined);
            await expect
              .poll(() => child.exitCode !== null || child.signalCode !== null, { timeout: 15000 })
              .toBe(true);
            expect(child.exitCode, diagnostics).toBe(0);
          } finally {
            try {
              await browser.close();
            } finally {
              await terminate();
            }
          }
        },
      };
    } catch (error) {
      await browser.close();
      throw error;
    }
  } catch (error) {
    await terminate();
    throw new Error(`Installed lifecycle startup failed: ${diagnostics}`, { cause: error });
  }
}
async function fingerprints(root: string) {
  const files: Record<string, string> = {};
  async function visit(directory: string, prefix = "") {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const name = prefix + entry.name;
      if (entry.isDirectory()) await visit(join(directory, entry.name), `${name}/`);
      else if (entry.isFile())
        files[name] = createHash("sha256")
          .update(await readFile(join(directory, entry.name)))
          .digest("hex");
      else throw new Error("Unexpected live application handle after shutdown");
    }
  }
  await visit(root);
  return files;
}

test("installed migration and rollback survive application removal and reinstall without changing preserved user data", async () => {
  test.setTimeout(180000);
  const root = await realpath(await mkdtemp(join(tmpdir(), "oc-installed-lifecycle-")));
  try {
    const state = join(root, "state");
    await (await openNetworkMode(state)).setOffline(true);
    const writer = await openProjectLibrary({ stateRoot: state, currentSchemaVersion: "1.0" });
    const original = await writer.createProject({
      envelope: envelope("1.0"),
      records: goldenRecords(),
    });
    const originalObjects = await fingerprints(join(writer.activeRoot, "objects"));
    for (const name of ["models/packs/preserved-pack", "offline-media-cache"]) {
      await mkdir(join(state, name), { recursive: true });
      await writeFile(join(state, name, "lifecycle-fixture"), "private lifecycle fixture");
    }
    const first = await installed(join(root, "installed"), state);
    let restored: string;
    try {
      const recovery = await first.page.evaluate(() =>
        window.openChords!.recovery.perform({ type: "inspect", projectId: "project_golden" }),
      );
      expect(recovery).toMatchObject({
        type: "recovery.result",
        detail: {
          schemaVersion: CONTRACT_VERSION,
          project: { compatibility: "writable" },
          revisions: [
            { reason: "migration" },
            { reason: "created", projectRevisionId: original.projectRevisionId },
          ],
        },
      });
      if (recovery.type !== "recovery.result" || !recovery.detail)
        throw new Error("Recovery metadata unavailable");
      expect(JSON.stringify(recovery)).not.toContain(root);
      const result = await first.page.evaluate(
        ({ expected, target }) =>
          window.openChords!.recovery.perform({
            type: "rollback",
            projectId: "project_golden",
            expectedProjectRevisionId: expected,
            targetProjectRevisionId: target,
            confirmedTargetProjectRevisionId: target,
          }),
        {
          expected: recovery.detail.project.projectRevisionId!,
          target: original.projectRevisionId,
        },
      );
      if (result.type !== "recovery.result" || !result.restoredProjectRevisionId)
        throw new Error("Rollback did not publish");
      restored = result.restoredProjectRevisionId;
      expect(result).toMatchObject({
        detail: {
          schemaVersion: CONTRACT_VERSION,
          revisions: [{ reason: "rollback" }, { reason: "migration" }, { reason: "created" }],
        },
      });
      expect(
        await first.page.evaluate(() => window.openChords!.updates.perform({ type: "check" })),
      ).toMatchObject({ type: "updates.result", state: "offline", release: null });
    } finally {
      await first.close();
    }
    const durable = await fingerprints(state);
    for (const [path, hash] of Object.entries(originalObjects))
      expect(durable[`project-library/objects/${path}`]).toBe(hash);
    // Actual application-directory removal; the ZIP and user data are outside this directory.
    await rm(join(root, "installed"), { recursive: true, maxRetries: 40, retryDelay: 250 });
    expect(await fingerprints(state)).toEqual(durable);
    const second = await installed(join(root, "reinstalled"), state);
    try {
      expect(
        await second.page.evaluate(() =>
          window.openChords!.recovery.perform({ type: "inspect", projectId: "project_golden" }),
        ),
      ).toMatchObject({
        type: "recovery.result",
        detail: {
          schemaVersion: CONTRACT_VERSION,
          project: { projectRevisionId: restored, compatibility: "writable" },
          revisions: [{ reason: "rollback" }, { reason: "migration" }, { reason: "created" }],
        },
      });
      expect(
        await second.page.evaluate(() => window.openChords!.updates.perform({ type: "status" })),
      ).toMatchObject({ type: "updates.result", offline: true });
    } finally {
      await second.close();
    }
    for (const name of ["models/packs/preserved-pack", "offline-media-cache"])
      expect(await readFile(join(state, name, "lifecycle-fixture"), "utf8")).toBe(
        "private lifecycle fixture",
      );
    expect(
      (await (await openProjectLibrary({ stateRoot: state })).readProject("project_golden"))
        .revisions,
    ).toHaveLength(3);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 40, retryDelay: 250 });
  }
});

test("installed older application reports newer schema read-only and refuses rollback without changing original Head or revision objects", async () => {
  test.setTimeout(120000);
  const root = await realpath(await mkdtemp(join(tmpdir(), "oc-installed-newer-")));
  try {
    const state = join(root, "state");
    await (await openNetworkMode(state)).setOffline(true);
    const writer = await openProjectLibrary({ stateRoot: state, currentSchemaVersion: "1.5" });
    const created = await writer.createProject({
      envelope: envelope("1.5"),
      records: goldenRecords(),
    });
    const head = join(writer.activeRoot, "projects/project_golden/HEAD.json");
    const beforeHead = await readFile(head, "utf8");
    const beforeObjects = await fingerprints(join(writer.activeRoot, "objects"));
    const app = await installed(join(root, "installed"), state);
    try {
      const result = await app.page.evaluate(() =>
        window.openChords!.recovery.perform({ type: "inspect", projectId: "project_golden" }),
      );
      expect(result).toMatchObject({
        type: "recovery.result",
        detail: {
          schemaVersion: "1.5",
          project: { compatibility: "read_only", readOnlyReason: "unsupported_schema" },
        },
      });
      const refused = await app.page.evaluate(
        (id) =>
          window.openChords!.recovery.perform({
            type: "rollback",
            projectId: "project_golden",
            expectedProjectRevisionId: id,
            targetProjectRevisionId: id,
            confirmedTargetProjectRevisionId: id,
          }),
        created.projectRevisionId,
      );
      expect(refused).toMatchObject({ type: "desktop.error" });
      expect(JSON.stringify(refused)).not.toContain(root);
      expect(JSON.stringify(result)).not.toContain("private lifecycle fixture");
    } finally {
      await app.close();
    }
    expect(await readFile(head, "utf8")).toBe(beforeHead);
    expect(await fingerprints(join(writer.activeRoot, "objects"))).toEqual(beforeObjects);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 40, retryDelay: 250 });
  }
});

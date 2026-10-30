import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import { observeExportProofIO } from "./support/export-proof-io-diagnostic.ts";

it("retains real file writes, sync, rename and original errors without exposing private values", async () => {
  const root = await mkdtemp(join(tmpdir(), "oc-unit-io-"));
  const originalOpen = fs.promises.open;
  const originalRename = fs.promises.rename;
  const lines: string[] = [];
  const stop = observeExportProofIO((line) => lines.push(line));
  try {
    const path = join(root, "private-file");
    const handle = await fs.promises.open(path, "wx");
    await handle.writeFile("private-content");
    await handle.sync();
    await handle.close();
    await fs.promises.rename(path, join(root, "private-target"));
    await expect(fs.promises.open(path, "r")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.promises.readFile(join(root, "private-target"), "utf8")).toBe(
      "private-content",
    );
    expect(lines.join("")).not.toContain("private");
    expect(lines.join("")).not.toContain(root);
    expect(lines).toContainEqual(
      expect.stringMatching(
        /^Export unit IO: operation=sync state=returned elapsed_ms=[0-9]{1,6}\n$/,
      ),
    );
    expect(lines).toContainEqual(expect.stringMatching(/operation=open state=rejected/));
  } finally {
    stop();
    await rm(root, { recursive: true, force: true });
  }
  expect(fs.promises.open).toBe(originalOpen);
  expect(fs.promises.rename).toBe(originalRename);
});

it("bounds records and stops timers and late diagnostics without changing I/O results", async () => {
  vi.useFakeTimers();
  const lines: string[] = [];
  const stop = observeExportProofIO((line) => lines.push(line));
  try {
    for (let index = 0; index < 70; index++)
      await fs.promises.open("/missing-private-parent/file", "r").catch(() => {});
    expect(lines).toHaveLength(128);
    await vi.advanceTimersByTimeAsync(29000);
    expect(lines).toHaveLength(130);
    expect(lines.at(-1)).toBe(
      "Export unit IO pending: open=0 write=0 sync=0 close=0 rename=0 elapsed_ms=29000\n",
    );
    stop();
    await vi.advanceTimersByTimeAsync(30000);
    expect(lines).toHaveLength(130);
  } finally {
    stop();
    vi.useRealTimers();
  }
});

it("keeps diagnostic writer exceptions separate from original filesystem results", async () => {
  const stop = observeExportProofIO(() => {
    throw new Error("private-diagnostic-error");
  });
  try {
    await expect(fs.promises.open("/missing-private-parent/file", "r")).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    stop();
  }
});

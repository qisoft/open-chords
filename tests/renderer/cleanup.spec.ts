import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "@playwright/test";
import electronPath from "electron";
import { z } from "zod";

import { openProjectLibrary } from "../../apps/desktop/src/main/project-library.ts";

for (const scenario of ["unchecked", "cancel-final", "confirm-models"]) {
  test(`cold native cleanup startup: ${scenario}`, async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "oc-cleanup-native-")));
    try {
      const state = join(root, "state");
      await mkdir(state);
      await openProjectLibrary({ stateRoot: state });
      await mkdir(join(state, "models"));
      await writeFile(join(state, "models", "fixture"), "pack");
      const report = join(root, "prompts.json");
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(process.env))
        if (key !== "ELECTRON_RUN_AS_NODE" && value !== undefined) env[key] = value;
      const executable: unknown = electronPath;
      if (typeof executable !== "string") throw new Error("Electron executable is unavailable");
      const child = spawn(
        executable,
        [
          join(process.cwd(), "tests/support/cleanup-startup.cjs"),
          "--open-chords-cleanup",
          `--cleanup-test-state=${state}`,
          `--cleanup-test-scenario=${scenario}`,
          `--cleanup-test-report=${report}`,
        ],
        { env, stdio: ["ignore", "pipe", "pipe"] },
      );
      let output = "";
      child.stdout.on("data", (chunk) => {
        output += String(chunk);
      });
      child.stderr.on("data", (chunk) => {
        output += String(chunk);
      });
      const exit = await new Promise<number | null>((resolve, reject) => {
        const timeout = setTimeout(() => {
          child.kill();
          reject(new Error(`Cleanup startup timed out: ${output}`));
        }, 20_000);
        child.once("error", (error) => {
          clearTimeout(timeout);
          reject(error);
        });
        child.once("exit", (code) => {
          clearTimeout(timeout);
          resolve(code);
        });
      });
      expect(exit, output).toBe(0);
      const prompts = z
        .array(
          z.object({
            message: z.string(),
            checkboxChecked: z.boolean().optional(),
            defaultId: z.number(),
            cancelId: z.number(),
            checkboxLabel: z.string().optional(),
          }),
        )
        .parse(JSON.parse(await readFile(report, "utf8")));
      expect(prompts.length).toBeGreaterThan(0);
      for (const prompt of prompts) {
        expect(prompt.defaultId).toBe(0);
        expect(prompt.cancelId).toBe(0);
        if (prompt.checkboxLabel) expect(prompt.checkboxChecked).toBe(false);
      }
      expect(
        await readFile(join(state, "project-library", "project-index.json"), "utf8"),
      ).toContain("rebuildable-project-index");
      if (scenario === "confirm-models") {
        await expect(readFile(join(state, "models", "fixture"))).rejects.toThrow();
        expect(prompts.at(-1)!.message).toBe("Selected cleanup completed");
      } else expect(await readFile(join(state, "models", "fixture"), "utf8")).toBe("pack");
      expect(
        prompts.some((prompt) => prompt.message === "Permanently delete the selected data?"),
      ).toBe(scenario !== "unchecked");
    } finally {
      await rm(root, { force: true, recursive: true, maxRetries: 20, retryDelay: 100 });
    }
  });
}

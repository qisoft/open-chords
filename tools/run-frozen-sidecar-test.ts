import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const executable = resolve(
  "dist",
  "analysis-sidecar",
  "open-chords-analysis",
  `open-chords-analysis${process.platform === "win32" ? ".exe" : ""}`,
);
const result = spawnSync(
  process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "pnpm",
  process.platform === "win32"
    ? ["/d", "/s", "/c", "pnpm", "exec", "vitest", "run", "tests/frozen-sidecar.test.ts"]
    : ["exec", "vitest", "run", "tests/frozen-sidecar.test.ts"],
  {
    env: { ...process.env, OPEN_CHORDS_FROZEN_SIDECAR: executable },
    stdio: "inherit",
  },
);
if (result.error !== undefined) throw result.error;
if (result.signal !== null) process.kill(process.pid, result.signal);
process.exitCode = result.status ?? 1;

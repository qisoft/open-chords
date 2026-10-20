import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

import { windowsUiaLoadDiagnostic } from "../tests/support/installed-windows-uia-load-evidence.ts";

const windows = process.env.SystemRoot ?? process.env.WINDIR;
if (process.platform !== "win32" || !windows)
  throw new Error("Windows load measurement unavailable");
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
])
  if (process.env[key]) env[key] = process.env[key];
env.PATH = [
  join(windows, "System32", "WindowsPowerShell", "v1.0"),
  join(windows, "System32"),
  windows,
].join(";");
const execute = promisify(execFile);
for (const mode of ["name", "path"] as const) {
  const started = performance.now();
  let stdout: string;
  try {
    ({ stdout } = await execute(
      join(windows, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      [
        "-NoProfile",
        "-NonInteractive",
        "-File",
        join(process.cwd(), "tests/support/measure-windows-uia-load.ps1"),
        "-Mode",
        mode,
      ],
      { env, timeout: 100000, maxBuffer: 4096 },
    ));
  } catch {
    // Native errors can embed command paths; preserve only a fixed failure.
    throw new Error("Native UIAutomation load measurement failed");
  }
  console.log(windowsUiaLoadDiagnostic(mode, stdout, performance.now() - started));
}

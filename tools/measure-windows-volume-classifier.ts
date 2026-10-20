import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { promisify } from "node:util";

import { windowsLocalVolumeCommand } from "../apps/desktop/src/main/windows-local-volume-command.ts";

const windows = process.env.SystemRoot ?? process.env.WINDIR;
if (process.platform !== "win32" || !windows)
  throw new Error("Windows volume measurement unavailable");
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
const root = parse(tmpdir()).root.replace(/[\\/]$/, "");
const execute = promisify(execFile);
let original: string | undefined;
for (const mode of ["automatic", "explicit"] as const) {
  const started = performance.now();
  let stdout: string;
  try {
    ({ stdout } = await execute(
      join(windows, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        windowsLocalVolumeCommand(root, mode),
      ],
      { env, timeout: 100000, maxBuffer: 4096 },
    ));
  } catch {
    // Raw subprocess errors can expose local paths and command output.
    throw new Error("Windows volume measurement failed");
  }
  const elapsed = Math.min(999999, Math.round(performance.now() - started));
  const driveType = stdout.trim();
  if (!/^[0-6]$/.test(driveType)) throw new Error("Windows volume measurement evidence invalid");
  if (mode === "automatic") original = driveType;
  const matches = original === driveType;
  console.log(
    `Native Windows volume classification: mode=${mode} drive_type=${driveType} matches=${matches} process_ms=${elapsed}`,
  );
  if (!matches) throw new Error("Windows volume classifiers disagree");
}

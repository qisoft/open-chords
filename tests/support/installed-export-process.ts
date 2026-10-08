import { execFile } from "node:child_process";
import { promisify } from "node:util";

export function installedExportExitDiagnostic(error: unknown, durationMs: number) {
  const value = typeof error === "object" && error !== null ? error : {};
  const code =
    "code" in value && typeof value.code === "number" && Number.isSafeInteger(value.code)
      ? value.code
      : "none";
  const signal =
    "signal" in value &&
    typeof value.signal === "string" &&
    ["SIGTERM", "SIGKILL", "SIGABRT", "SIGSEGV"].includes(value.signal)
      ? value.signal
      : "none";
  const killed = "killed" in value && value.killed === true;
  return `Installed export process failure: duration_ms=${Math.round(durationMs)} killed=${killed} exit_code=${code} exit_signal=${signal}`;
}

export async function runInstalledExportProcess(
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv,
) {
  const started = performance.now();
  try {
    return await promisify(execFile)(executable, args, {
      env,
      timeout: 120000,
      maxBuffer: 16384,
      windowsHide: true,
    });
  } catch (error) {
    console.error(installedExportExitDiagnostic(error, performance.now() - started));
    throw error;
  }
}

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
      // The expanded Windows export proof includes three independent durable reopens and retry.
      timeout:
        process.platform === "win32" && args.includes("--open-chords-export-proof")
          ? 300000
          : 120000,
      maxBuffer: 16384,
      windowsHide: true,
    });
  } catch (error) {
    const diagnostic = installedExportExitDiagnostic(error, performance.now() - started);
    const stages = installedExportProofStages(error);
    // Raw child errors contain command paths and output; retaining cause defeats redaction.
    // eslint-disable-next-line preserve-caught-error
    throw new Error([diagnostic, ...stages].join("\n"));
  }
}

function installedExportProofStages(error: unknown): string[] {
  if (
    typeof error !== "object" ||
    error === null ||
    !("stderr" in error) ||
    typeof error.stderr !== "string"
  )
    return [];
  const names = new Set([
    "started",
    "preserved_journal_write",
    "preserved_staging_write",
    "preserved_staging_sync",
    "retry_service_opening",
    "retry_saving",
    "retry_target_selected",
    "retry_saved",
    "retry_library_reopened",
    "retry_output_verified",
    "retry_recovery_verified",
  ]);
  return error.stderr
    .slice(0, 16384)
    .split(/\r?\n/)
    .flatMap((line) => {
      const match = /^Export disk proof stage: ([a-z_]+) duration_ms=([0-9]{1,9})$/.exec(line);
      if (match && names.has(match[1]!)) return [line];
      return /^Export recovery proof stage: (started|published_pending|refused_changed_output|refused_missing_output|recovered|idempotent) duration_ms=[0-9]{1,9}$/.test(
        line,
      )
        ? [line]
        : [];
    })
    .slice(-16);
}

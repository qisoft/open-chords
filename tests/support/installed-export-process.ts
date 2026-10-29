import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { PROJECTION_PROOF_FAILURE_CODES } from "../../apps/desktop/src/main/packaged-projection-proof-diagnostic.ts";

export function installedExportExitDiagnostic(error: unknown, durationMs: number) {
  return installedProcessExitDiagnostic("export", error, durationMs);
}

export function installedProcessExitDiagnostic(
  proof: "export" | "acquisition",
  error: unknown,
  durationMs: number,
) {
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
  return `Installed ${proof} process failure: duration_ms=${Math.round(durationMs)} killed=${killed} exit_code=${code} exit_signal=${signal}`;
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
    "retry_check_receipt_count_refused",
    "retry_check_output_hash_refused",
    "retry_check_output_bytes_refused",
    "retry_check_revision_refused",
    "retry_check_source_tree_refused",
  ]);
  return error.stderr
    .slice(0, 16384)
    .split(/\r?\n/)
    .flatMap((line) => {
      const projectionFailure = /^Packaged (export|archive) proof failure: code=([A-Za-z_]+)$/.exec(
        line,
      );
      if (projectionFailure && PROJECTION_PROOF_FAILURE_CODES.has(projectionFailure[2]!))
        return [line];
      if (
        /^Export proof stage: (rejected_(stale_revision|protected_target|directory_target|missing_parent)|cancelled_existing_target_unchanged)$/.test(
          line,
        )
      )
        return [line];
      if (
        /^Export projection proof stage: (library_open|library_ready|cancellation|save_json|save_archive|save_chordpro|save_lrc|save_pdf|failure_cases|reopened)$/.test(
          line,
        )
      )
        return [line];
      if (
        /^Archive proof stage: (archive_read|library_open|library_ready|import_started|import_finished|roundtrip_verified|duplicate|cancellation|reopen|rejecting_(traversal|link|collision|executable|hash|future|size|encrypted))$/.test(
          line,
        )
      )
        return [line];
      const match = /^Export disk proof stage: ([a-z_]+) duration_ms=([0-9]{1,9})$/.exec(line);
      if (match && names.has(match[1]!)) return [line];
      if (
        /^Export disk proof source delta: added=[0-9]{1,4} removed=[0-9]{1,4} changed=[0-9]{1,4} library=[0-9]{1,4} location=[0-9]{1,4} network=[0-9]{1,4} export_pending=[0-9]{1,4} chromium_preferences=[0-9]{1,4} chromium_storage=[0-9]{1,4} chromium_cache=[0-9]{1,4} other=[0-9]{1,4}$/.test(
          line,
        )
      )
        return [line];
      if (
        /^Export disk proof failure: code=(export_disk_proof_(fixture_invalid|content_invalid|preservation_failed|retry_failed|retry_not_durable|retry_not_recovered)|ENOSPC|ENOENT|EACCES|EPERM|EIO|EBUSY|unknown) duration_ms=[0-9]{1,9}$/.test(
          line,
        )
      )
        return [line];
      return /^Export recovery proof stage: (started|published_pending|refused_changed_output|refused_missing_output|recovered|replay_journal_writing|replay_journal_written|replay_recovered_once|replay_recovered_twice|replay_library_opened|replay_service_opened|replay_verification_refused|replay_check_(busy|pending|head|receipt|library_tree|target_tree|source_tree)_refused|idempotent) duration_ms=[0-9]{1,9}$/.test(
        line,
      )
        ? [line]
        : [];
    })
    .slice(-16);
}

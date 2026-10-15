import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { installedProcessExitDiagnostic } from "./installed-export-process.ts";

export function installedAcquisitionFailureDiagnostic(error: unknown, durationMs: number): string {
  const stderr =
    typeof error === "object" &&
    error !== null &&
    "stderr" in error &&
    typeof error.stderr === "string"
      ? error.stderr.slice(-65536)
      : "";
  const lines = stderr.split(/\r?\n/u);
  const stages = lines
    .filter((line) =>
      /^Acquisition proof stage: (?:application_ready|runtime_setup|extractor_run|artifact_verification|extractor_cleanup|extractor_reaped|jobs|jobs_ready|jobs_bot_check|jobs_invalid_media|jobs_overlong|jobs_offline_cancel|jobs_closing|jobs_closed)(?: duration_ms=[0-9]{1,10})?$/u.test(
        line,
      ),
    )
    .slice(-16);
  const phases = lines
    .filter((line) =>
      /^Native destroy phase: (?:lock|derive|revoke|delete_profile|remove_runtime|complete)$/u.test(
        line,
      ),
    )
    .slice(-1);
  const probes = lines
    .filter((line) =>
      /^Native destroy revoke probe: ancestor=[0-5] step=(?:runtime_root|ancestor_attributes|canonical|path_attributes|mutex_create|mutex_wait|security_read|acl_build|security_write|release|complete)$/u.test(
        line,
      ),
    )
    .slice(-1);
  return [
    installedProcessExitDiagnostic("acquisition", error, durationMs),
    ...stages,
    ...phases,
    ...probes,
  ].join("\n");
}

export async function runInstalledAcquisitionProcess(
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeout: number,
) {
  const started = performance.now();
  try {
    return await promisify(execFile)(executable, args, {
      env,
      timeout,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
  } catch (error) {
    // Raw exec errors contain private command paths and captured output.
    // eslint-disable-next-line preserve-caught-error
    throw new Error(installedAcquisitionFailureDiagnostic(error, performance.now() - started));
  }
}

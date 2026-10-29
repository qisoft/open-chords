// Fixed synthetic installed-proof failures only; never emit exception text or paths.
export const PROJECTION_PROOF_FAILURE_CODES = new Set([
  "export_proof_fixture_invalid",
  "export_proof_cancellation_failed",
  "export_proof_project_missing",
  "export_proof_publication_failed",
  "export_proof_reopen_failed",
  "export_failure_proof_project_missing",
  "export_failure_proof_state_changed",
  "export_failure_proof_refusal_failed",
  "export_failure_proof_cancellation_failed",
  "archive_proof_fixture_invalid",
  "archive_proof_import_failed",
  "archive_proof_roundtrip_failed",
  "archive_proof_library_changed",
  "archive_proof_duplicate_failed",
  "archive_proof_cancellation_failed",
  "archive_proof_rejection_failed",
  "archive_proof_reopen_failed",
  "ENOSPC",
  "ENOENT",
  "EACCES",
  "EPERM",
  "EIO",
  "EBUSY",
  "unknown",
]);

export function projectionProofFailureCode(error: unknown): string {
  if (error instanceof Error && PROJECTION_PROOF_FAILURE_CODES.has(error.message))
    return error.message;
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = error.code;
    if (typeof code === "string" && PROJECTION_PROOF_FAILURE_CODES.has(code)) return code;
  }
  return "unknown";
}

export async function rethrowProjectionProofFailure(
  proof: "archive" | "export",
  error: unknown,
): Promise<never> {
  const diagnostic = `Packaged ${proof} proof failure: code=${projectionProofFailureCode(error)}\n`;
  await new Promise<void>((resolve) => {
    try {
      process.stderr.write(diagnostic, () => resolve());
    } catch {
      // A diagnostic transport failure must not replace the original proof failure.
      resolve();
    }
  });
  throw error;
}

import { AcquisitionSessionError } from "./acquisition-session.ts";
import { packagedWorkspaceFailureCode } from "./packaged-sidecar-proof-workspace.ts";

/** Dispose a partially prepared workspace without losing an earlier cleanup failure. */
export function rethrowAfterAcquisitionCleanup(
  error: unknown,
  workspace?: { cleanup(): void },
): never {
  try {
    workspace?.cleanup();
  } catch {
    throw new AcquisitionSessionError("cleanup_failure");
  }
  if (hasWorkspaceCleanupFailure(error)) throw new AcquisitionSessionError("cleanup_failure");
  throw error;
}
function hasWorkspaceCleanupFailure(error: unknown): boolean {
  return (
    packagedWorkspaceFailureCode(error) === "cleanup_failed" ||
    (error instanceof AggregateError && error.errors.some(hasWorkspaceCleanupFailure))
  );
}

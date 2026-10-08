import { AcquisitionBrokerError } from "./acquisition-broker.ts";
import { AcquisitionSessionError } from "./acquisition-session.ts";
import { packagedWorkspaceFailureCode } from "./packaged-sidecar-proof-workspace.ts";
import { SidecarSessionError } from "./sidecar-protocol.ts";

const ALLOWED_CODES = new Set([
  "protocol_violation",
  "cancelled",
  "deadline",
  "worker_failed",
  "cleanup_failure",
  "provider_unavailable",
  "bot_check",
  "unsupported_delivery",
  "endpoint_denied",
  "network_unavailable",
  "dns_denied",
  "budget_exceeded",
  "process_failure",
  "unexpected_eof",
  "cleanup_failed",
  "setup_prepare_failed",
  "setup_response_failed",
  "setup_validation_failed",
  "setup_workspace_failed",
  "ENOENT",
  "EACCES",
  "EPERM",
  "EPIPE",
  "ABORT_ERR",
  "EINVAL",
  "E2BIG",
  "ENOMEM",
]);

/** Emit only fixed failure categories; error messages, paths and provider data remain private. */
export function acquisitionProofFailureCode(cause: unknown): string {
  if (
    cause instanceof AcquisitionSessionError ||
    cause instanceof AcquisitionBrokerError ||
    cause instanceof SidecarSessionError
  )
    return ALLOWED_CODES.has(cause.code) ? cause.code : "unknown";
  const workspace = packagedWorkspaceFailureCode(cause);
  if (workspace !== undefined && ALLOWED_CODES.has(workspace)) return workspace;
  if (cause instanceof Error && cause.message === "acquisition_runtime_unavailable")
    return "runtime_unavailable";
  if (cause instanceof Error) {
    const code: unknown = Object.getOwnPropertyDescriptor(cause, "code")?.value;
    if (typeof code === "string" && ALLOWED_CODES.has(code)) return code;
  }
  return "unknown";
}

/** Inspect only bounded internal cause chains and print allowlisted categories. */
export function acquisitionProofFailureChain(cause: unknown, depth = 0): string {
  if (depth >= 4) return "truncated";
  if (cause !== null && typeof cause === "object" && !(cause instanceof Error)) {
    const exitCode: unknown = Object.getOwnPropertyDescriptor(cause, "exitCode")?.value;
    if (typeof exitCode === "number" && Number.isSafeInteger(exitCode)) return `exit_${exitCode}`;
    const spawnCode: unknown = Object.getOwnPropertyDescriptor(cause, "code")?.value;
    if (typeof spawnCode === "string" && ALLOWED_CODES.has(spawnCode)) return spawnCode;
  }
  const code = acquisitionProofFailureCode(cause);
  if (cause instanceof AggregateError) {
    return `${code}[${cause.errors
      .slice(0, 4)
      .map((error: unknown) => acquisitionProofFailureChain(error, depth + 1))
      .join(",")}]`;
  }
  if (cause instanceof Error) {
    const nested: unknown = Object.getOwnPropertyDescriptor(cause, "cause")?.value;
    if (nested !== undefined) return `${code}[${acquisitionProofFailureChain(nested, depth + 1)}]`;
  }
  return code;
}

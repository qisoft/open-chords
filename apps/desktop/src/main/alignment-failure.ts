import { CpuWorkCleanupFailure } from "./cpu-work.ts";
import { SidecarSessionError } from "./sidecar-session.ts";

export type AlignmentFailureKind =
  | "integrity"
  | "protocol"
  | "cleanup"
  | "worker"
  | "interrupted"
  | "storage";
export class AlignmentExecutionError extends Error {
  readonly kind: AlignmentFailureKind;
  constructor(kind: AlignmentFailureKind) {
    super(`Alignment ${kind} failure`);
    this.kind = kind;
  }
}
export function alignmentFailureKind(error: unknown): AlignmentFailureKind {
  if (error instanceof CpuWorkCleanupFailure) return "cleanup";
  if (error instanceof AlignmentExecutionError) return error.kind;
  if (error instanceof SidecarSessionError) {
    if (["protocol_violation", "frame_too_large", "invalid_request"].includes(error.code))
      return "protocol";
    if (error.code === "cleanup_failure") return "cleanup";
    if (error.code === "launch_failure") return "integrity";
  }
  return "worker";
}

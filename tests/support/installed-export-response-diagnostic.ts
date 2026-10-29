const codes = new Set([
  "busy",
  "capability_unavailable",
  "internal_error",
  "invalid_media",
  "invalid_command",
  "invalid_generation",
  "project_not_found",
  "project_read_only",
  "source_unavailable",
  "stale_revision",
  "unauthorized_sender",
]);

export function installedExportResponseDiagnostic(result: unknown): string {
  const response =
    result && typeof result === "object" && "response" in result ? result.response : undefined;
  const fields = response && typeof response === "object" ? response : {};
  const type =
    "type" in fields && (fields.type === "exports.result" || fields.type === "desktop.error")
      ? fields.type
      : "unknown";
  const code =
    "code" in fields && typeof fields.code === "string" && codes.has(fields.code)
      ? fields.code
      : "unknown";
  const retryable =
    "retryable" in fields && typeof fields.retryable === "boolean" ? fields.retryable : "unknown";
  return `Installed native export response: type=${type} code=${code} retryable=${retryable}`;
}

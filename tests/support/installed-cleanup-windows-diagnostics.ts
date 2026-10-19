export function installedWindowsCleanupFailure(error: unknown): string {
  const stderr =
    typeof error === "object" &&
    error !== null &&
    "stderr" in error &&
    typeof error.stderr === "string"
      ? error.stderr.slice(-16384)
      : "";
  const matches = [
    ...stderr.matchAll(
      /Native cleanup input failure: (target|foreground|hit_test|cursor_position|send_input)(?=[\s"\r\n]|$)/g,
    ),
  ];
  const stage = matches.length === 1 ? matches[0]![1] : "unknown";
  return `Native Windows cleanup driver failed: input_stage=${stage}`;
}

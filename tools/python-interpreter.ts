export interface PythonCandidate {
  arguments: string[];
  command: string;
}

export function pythonCandidates(
  override: string | undefined,
  platform: NodeJS.Platform,
): PythonCandidate[] {
  if (override !== undefined) return [{ arguments: [], command: override }];
  if (platform === "win32")
    return [
      { arguments: [], command: "python" },
      { arguments: ["-3"], command: "py" },
    ];
  return [
    { arguments: [], command: "python3" },
    { arguments: [], command: "python" },
  ];
}

import { win32 as windowsPath } from "node:path";

export function isExpectedWindowsProfileRoot(profileRoot: string, packagesRoot: string): boolean {
  if (!windowsPath.isAbsolute(profileRoot) || !windowsPath.isAbsolute(packagesRoot)) return false;
  const relative = windowsPath.relative(packagesRoot, profileRoot);
  const parts = relative.split(windowsPath.sep);
  return parts.length === 2 && parts[0] !== "" && parts[1]?.toLowerCase() === "ac";
}

import { open } from "node:fs/promises";

const UNSUPPORTED_WINDOWS_DIRECTORY_SYNC_ERRORS = new Set(["EISDIR", "EINVAL", "ENOTSUP", "EPERM"]);

export async function syncDirectory(path: string): Promise<void> {
  try {
    const handle = await open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (
      process.platform === "win32" &&
      isNodeError(error) &&
      error.code !== undefined &&
      UNSUPPORTED_WINDOWS_DIRECTORY_SYNC_ERRORS.has(error.code)
    ) {
      return;
    }
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}

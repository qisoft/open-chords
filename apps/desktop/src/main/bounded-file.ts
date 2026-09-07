import { constants } from "node:fs";
import { open } from "node:fs/promises";

/** Read through one regular-file descriptor with a hard allocation ceiling. */
export async function readBoundedFile(path: string, limit: number): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) throw new Error("Invalid bounded file");
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > limit) throw new Error("Bounded file grew beyond its limit");
    return buffer.subarray(0, length);
  } finally {
    await handle.close();
  }
}

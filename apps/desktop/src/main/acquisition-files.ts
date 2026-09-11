import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";

/** Copy a closed, regular media object while validating its bounded byte identity. */
export async function copyAcquiredFile(
  source: string,
  target: string,
  expected: { bytes: number; sha256: string },
) {
  if (
    !Number.isSafeInteger(expected.bytes) ||
    expected.bytes <= 0 ||
    expected.bytes > 512 * 1024 * 1024 ||
    !/^[a-f0-9]{64}$/u.test(expected.sha256)
  )
    throw new Error("invalid_acquisition_artifact");
  const before = await lstat(source, { bigint: true });
  if (!before.isFile() || before.nlink !== 1n || before.size !== BigInt(expected.bytes))
    throw new Error("invalid_acquisition_artifact");
  const input = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const held = await input.stat({ bigint: true });
    if (
      held.ino !== before.ino ||
      held.dev !== before.dev ||
      held.size !== before.size ||
      !held.isFile()
    )
      throw new Error("invalid_acquisition_artifact");
    const output = await open(target, "wx", 0o600);
    try {
      const hash = createHash("sha256");
      const chunk = Buffer.alloc(Math.min(1024 * 1024, expected.bytes));
      for (let position = 0; position < expected.bytes;) {
        const amount = Math.min(chunk.length, expected.bytes - position);
        const { bytesRead } = await input.read(chunk, 0, amount, position);
        if (bytesRead !== amount) throw new Error("invalid_acquisition_artifact");
        hash.update(chunk.subarray(0, bytesRead));
        await output.writeFile(chunk.subarray(0, bytesRead));
        position += bytesRead;
      }
      const after = await input.stat({ bigint: true });
      const current = await lstat(source, { bigint: true });
      if (
        hash.digest("hex") !== expected.sha256 ||
        after.size !== before.size ||
        after.mtimeNs !== before.mtimeNs ||
        after.ctimeNs !== before.ctimeNs ||
        current.ino !== before.ino ||
        current.dev !== before.dev ||
        !current.isFile()
      )
        throw new Error("invalid_acquisition_artifact");
      await output.sync();
    } finally {
      await output.close();
    }
  } finally {
    await input.close();
  }
}

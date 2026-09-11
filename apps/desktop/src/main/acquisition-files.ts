import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname, resolve } from "node:path";

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
  const ancestors = await inspectAncestors(source, target);
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
      await verifyAncestors(ancestors);
      await output.sync();
    } finally {
      await output.close();
    }
  } finally {
    await input.close();
  }
}

async function inspectAncestors(...paths: string[]) {
  const ancestors = new Set<string>();
  for (const path of paths) {
    for (
      let current = dirname(resolve(path));
      current !== dirname(current);
      current = dirname(current)
    )
      ancestors.add(current);
  }
  const identities = [];
  for (const path of [...ancestors].sort((a, b) => a.length - b.length)) {
    const stat = await lstat(path, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("invalid_acquisition_path");
    identities.push({ path, dev: stat.dev, ino: stat.ino, mode: stat.mode });
  }
  return identities;
}
async function verifyAncestors(identities: Awaited<ReturnType<typeof inspectAncestors>>) {
  for (const expected of identities) {
    const stat = await lstat(expected.path, { bigint: true });
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.dev !== expected.dev ||
      stat.ino !== expected.ino ||
      stat.mode !== expected.mode
    )
      throw new Error("invalid_acquisition_path");
  }
}

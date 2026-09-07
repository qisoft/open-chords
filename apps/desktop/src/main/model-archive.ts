import { createHash } from "node:crypto";
import { mkdir, open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { inflateRawSync } from "node:zlib";

export type ModelFile = { path: string; bytes: number; sha256: string };

// Release manifests enumerate every output. This is deliberately a narrow ZIP subset:
// stored/deflated regular files and directories, no encryption, links, ZIP64 or split disks.
export async function unpackModel(bytes: Buffer, root: string, expected: ModelFile[]) {
  const invalid = () => {
    throw new Error("Invalid model archive");
  };
  if (bytes.length < 22) invalid();
  const end = bytes.length - 22;
  if (
    bytes.readUInt32LE(end) !== 0x06054b50 ||
    bytes.readUInt32LE(end + 4) !== 0 ||
    bytes.readUInt16LE(end + 20) !== 0
  )
    invalid();
  const count = bytes.readUInt16LE(end + 10);
  const start = bytes.readUInt32LE(end + 16);
  if (
    count > 128 ||
    bytes.readUInt16LE(end + 8) !== count ||
    start + bytes.readUInt32LE(end + 12) !== end
  )
    invalid();
  const seen = new Set<string>();
  const extracted = new Set<string>();
  let cursor = start;
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50) invalid();
    const flags = bytes.readUInt16LE(cursor + 8);
    const method = bytes.readUInt16LE(cursor + 10);
    const compressed = bytes.readUInt32LE(cursor + 20);
    const size = bytes.readUInt32LE(cursor + 24);
    const length = bytes.readUInt16LE(cursor + 28);
    const extra = bytes.readUInt16LE(cursor + 30);
    const comment = bytes.readUInt16LE(cursor + 32);
    const mode = bytes.readUInt32LE(cursor + 38) >>> 16;
    const local = bytes.readUInt32LE(cursor + 42);
    if (
      (flags & ~0x808) !== 0 ||
      ![0, 8].includes(method) ||
      bytes.readUInt16LE(cursor + 34) !== 0 ||
      cursor + 46 + length + extra + comment > end
    )
      invalid();
    const name = new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(cursor + 46, cursor + 46 + length),
    );
    const directory = name.endsWith("/");
    const path = directory ? name.slice(0, -1) : name;
    if (
      !path ||
      path.split("/").some((part) => !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(part)) ||
      seen.has(path.toLowerCase())
    )
      invalid();
    seen.add(path.toLowerCase());
    if ((mode & 0xf000) !== 0 && (mode & 0xf000) !== (directory ? 0x4000 : 0x8000)) invalid();
    if (
      local + 30 > start ||
      bytes.readUInt32LE(local) !== 0x04034b50 ||
      bytes.readUInt16LE(local + 6) !== flags ||
      bytes.readUInt16LE(local + 8) !== method
    )
      invalid();
    const localLength = bytes.readUInt16LE(local + 26);
    const data = local + 30 + localLength + bytes.readUInt16LE(local + 28);
    if (
      data + compressed > start ||
      !bytes
        .subarray(local + 30, local + 30 + localLength)
        .equals(bytes.subarray(cursor + 46, cursor + 46 + length))
    )
      invalid();
    if (directory) {
      if (size !== 0 || !expected.some((file) => file.path.startsWith(name))) invalid();
    } else {
      const file = expected.find((item) => item.path === name);
      if (!file || size !== file.bytes || size > 128 * 1024 * 1024) invalid();
      const content =
        method === 0
          ? bytes.subarray(data, data + compressed)
          : inflateRawSync(bytes.subarray(data, data + compressed), {
              maxOutputLength: Math.max(1, size),
            });
      if (
        content.length !== size ||
        createHash("sha256").update(content).digest("hex") !== file!.sha256
      )
        invalid();
      await mkdir(dirname(join(root, name)), { recursive: true });
      const output = await open(join(root, name), "wx", 0o600);
      try {
        await output.writeFile(content);
        await output.sync();
      } finally {
        await output.close();
      }
      extracted.add(name);
    }
    cursor += 46 + length + extra + comment;
  }
  if (cursor !== end || extracted.size !== expected.length) invalid();
}

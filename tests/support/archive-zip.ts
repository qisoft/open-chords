import { createHash } from "node:crypto";
import { crc32, deflateRawSync } from "node:zlib";

import { canonicalSerialize } from "@open-chords/domain";

import {
  archiveRequirementsFor,
  type ArchivedProject,
} from "../../apps/desktop/src/main/project-archive-format.ts";

export type RawZipEntry = {
  name: string | Buffer;
  data: Buffer;
  method?: number;
  flags?: number;
  externalAttributes?: number;
  declaredSize?: number;
  extra?: Buffer;
};

export function rawZip(
  entries: readonly RawZipEntry[],
  options: { prefix?: Buffer; suffix?: Buffer; zip64Locator?: boolean } = {},
): Buffer {
  const prefix = options.prefix ?? Buffer.alloc(0);
  const locals: Buffer[] = [prefix];
  const centrals: Buffer[] = [];
  let offset = prefix.length;
  for (const entry of entries) {
    const name = typeof entry.name === "string" ? Buffer.from(entry.name, "utf8") : entry.name;
    const method = entry.method ?? 8;
    const data = method === 8 ? deflateRawSync(entry.data) : entry.data;
    const size = entry.declaredSize ?? entry.data.length;
    const extra = entry.extra ?? Buffer.alloc(0);
    const flags = entry.flags ?? 0x0800;
    const header = (signature: number, central: boolean) => {
      const buffer = Buffer.alloc(central ? 46 : 30);
      buffer.writeUInt32LE(signature, 0);
      const base = central ? 2 : 0;
      if (central) buffer.writeUInt16LE((3 << 8) | 20, 4);
      buffer.writeUInt16LE(20, 4 + base);
      buffer.writeUInt16LE(flags, 6 + base);
      buffer.writeUInt16LE(method, 8 + base);
      buffer.writeUInt16LE(0x0021, 12 + base);
      buffer.writeUInt32LE(crc32(entry.data), 14 + base);
      buffer.writeUInt32LE(data.length, 18 + base);
      buffer.writeUInt32LE(size, 22 + base);
      buffer.writeUInt16LE(name.length, 26 + base);
      buffer.writeUInt16LE(extra.length, 28 + base);
      if (central) {
        buffer.writeUInt32LE(entry.externalAttributes ?? 0o100644 * 0x10000, 38);
        buffer.writeUInt32LE(offset, 42);
      }
      return buffer;
    };
    locals.push(header(0x04034b50, false), name, extra, data);
    centrals.push(header(0x02014b50, true), name, extra);
    offset += 30 + name.length + extra.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const locator = Buffer.alloc(options.zip64Locator ? 20 : 0);
  if (options.zip64Locator) locator.writeUInt32LE(0x07064b50, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, locator, end, options.suffix ?? Buffer.alloc(0)]);
}

export const sha256 = (bytes: Buffer | string) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

// Build signed archive entries from a (possibly hostile) document, so each test can
// break exactly one property while every hash and declaration stays consistent.
export function signedArchiveEntries(
  document: ArchivedProject,
  options: {
    manifest?: (manifest: Record<string, unknown>) => Record<string, unknown>;
    media?: { bytes: Buffer; declaration: Record<string, unknown> };
    requirements?: unknown[];
  } = {},
): RawZipEntry[] {
  const project = Buffer.from(canonicalSerialize(document), "utf8");
  const baseManifest: Record<string, unknown> = {
    format: "open-chords/portable-project-archive",
    formatVersion: "1.0",
    project: { byteSize: project.length, path: "project.json", sha256: sha256(project) },
    requirements: options.requirements ?? archiveRequirementsFor(document),
    ...(options.media
      ? {
          media: {
            byteSize: options.media.bytes.length,
            path: "media/project-range.pcm",
            sha256: sha256(options.media.bytes),
            ...options.media.declaration,
          },
        }
      : {}),
  };
  const manifest = options.manifest ? options.manifest(baseManifest) : baseManifest;
  return [
    { name: "manifest.json", data: Buffer.from(canonicalSerialize(manifest), "utf8") },
    { name: "project.json", data: project },
    ...(options.media ? [{ name: "media/project-range.pcm", data: options.media.bytes }] : []),
  ];
}

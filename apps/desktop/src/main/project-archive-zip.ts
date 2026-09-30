import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";

export type ArchiveZipRejection =
  | "compression_ratio"
  | "encrypted_entry"
  | "link_entry"
  | "malformed_zip"
  | "name_collision"
  | "size_limit"
  | "unsafe_path"
  | "unsupported_zip_feature";

export class ArchiveZipError extends Error {
  readonly reason: ArchiveZipRejection;
  constructor(reason: ArchiveZipRejection) {
    super(`Portable Project Archive rejected: ${reason}`);
    this.name = "ArchiveZipError";
    this.reason = reason;
  }
}

export type ArchiveZipEntry = { name: string; size: number; read(): Buffer };

export const ARCHIVE_ZIP_LIMITS = {
  maxArchiveBytes: 160 * 1024 * 1024,
  maxCompressionRatio: 200,
  maxEntries: 8,
  maxEntryBytes: 128 * 1024 * 1024,
  maxNameBytes: 255,
  maxTotalBytes: 160 * 1024 * 1024,
  ratioFloorBytes: 1024 * 1024,
} as const;

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const END_SIGNATURE = 0x06054b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const UTF8_FLAG = 0x0800;
const DOS_DATE_1980_01_01 = 0x0021;
const UNIX_REGULAR_FILE = 0o100644;
const VERSION_MADE_BY_UNIX = (3 << 8) | 20;

export function writeArchiveZip(entries: ReadonlyArray<{ name: string; bytes: Buffer }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const { name, bytes } of entries) {
    const encodedName = Buffer.from(name, "utf8");
    const deflated = deflateRawSync(bytes, { level: 9 });
    const method =
      deflated.length < bytes.length && !exceedsCompressionRatio(bytes.length, deflated.length)
        ? 8
        : 0;
    const data = method === 8 ? deflated : bytes;
    const checksum = crc32(bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIGNATURE, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(UTF8_FLAG, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(DOS_DATE_1980_01_01, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(encodedName.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_SIGNATURE, 0);
    central.writeUInt16LE(VERSION_MADE_BY_UNIX, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(UTF8_FLAG, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(DOS_DATE_1980_01_01, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(bytes.length, 24);
    central.writeUInt16LE(encodedName.length, 28);
    central.writeUInt32LE(UNIX_REGULAR_FILE * 0x10000, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, encodedName, data);
    centrals.push(central, encodedName);
    offset += local.length + encodedName.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_SIGNATURE, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

// Only the profile Open Chords writes is accepted: one disk, no ZIP64, no extra
// fields, no data descriptors, no comments, contiguous entries starting at byte 0.
export function readArchiveZip(bytes: Buffer): ArchiveZipEntry[] {
  const reject = (reason: ArchiveZipRejection): never => {
    throw new ArchiveZipError(reason);
  };
  if (bytes.length > ARCHIVE_ZIP_LIMITS.maxArchiveBytes) reject("size_limit");
  if (bytes.length < 22) reject("malformed_zip");
  const end = bytes.length - 22;
  if (bytes.readUInt32LE(end) !== END_SIGNATURE || bytes.readUInt16LE(end + 20) !== 0)
    reject("malformed_zip");
  if (end >= 20 && bytes.readUInt32LE(end - 20) === ZIP64_LOCATOR_SIGNATURE)
    reject("unsupported_zip_feature");
  const count = bytes.readUInt16LE(end + 10);
  const directorySize = bytes.readUInt32LE(end + 12);
  const directoryStart = bytes.readUInt32LE(end + 16);
  if (count === 0xffff || directorySize === 0xffffffff || directoryStart === 0xffffffff)
    reject("unsupported_zip_feature");
  if (
    bytes.readUInt16LE(end + 4) !== 0 ||
    bytes.readUInt16LE(end + 6) !== 0 ||
    bytes.readUInt16LE(end + 8) !== count
  )
    reject("unsupported_zip_feature");
  if (count === 0 || directoryStart + directorySize !== end) reject("malformed_zip");
  if (count > ARCHIVE_ZIP_LIMITS.maxEntries) reject("size_limit");

  const decoder = new TextDecoder("utf-8", { fatal: true });
  const collisionKeys = new Set<string>();
  const entries: ArchiveZipEntry[] = [];
  let totalBytes = 0;
  let cursor = directoryStart;
  let expectedLocal = 0;
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== CENTRAL_SIGNATURE)
      reject("malformed_zip");
    const flags = bytes.readUInt16LE(cursor + 8);
    const method = bytes.readUInt16LE(cursor + 10);
    const checksum = bytes.readUInt32LE(cursor + 16);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const size = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const externalAttributes = bytes.readUInt32LE(cursor + 38);
    const localOffset = bytes.readUInt32LE(cursor + 42);
    if ((flags & 0x0001) !== 0 || (flags & 0x0040) !== 0 || (flags & 0x2000) !== 0 || method === 99)
      reject("encrypted_entry");
    const unixType = (externalAttributes >>> 16) & 0o170000;
    if (
      (externalAttributes & 0x0400) !== 0 ||
      (unixType !== 0 && unixType !== 0o100000 && unixType !== 0o040000)
    )
      reject("link_entry");
    if (
      (flags & ~(UTF8_FLAG | 0x0006)) !== 0 ||
      (method !== 0 && method !== 8) ||
      bytes.readUInt16LE(cursor + 6) > 20 ||
      extraLength !== 0 ||
      commentLength !== 0 ||
      bytes.readUInt16LE(cursor + 34) !== 0 ||
      size === 0xffffffff ||
      compressedSize === 0xffffffff
    )
      reject("unsupported_zip_feature");
    if (nameLength === 0 || nameLength > ARCHIVE_ZIP_LIMITS.maxNameBytes) reject("unsafe_path");
    const nameEnd = cursor + 46 + nameLength;
    if (nameEnd > end) reject("malformed_zip");
    const rawName = bytes.subarray(cursor + 46, nameEnd);
    let name = "";
    try {
      name = decoder.decode(rawName);
    } catch {
      reject("unsafe_path");
    }
    if (!isSafeEntryName(name) || unixType === 0o040000) reject("unsafe_path");
    const collisionKey = name.normalize("NFKC").toLowerCase().normalize("NFKC");
    if (collisionKeys.has(collisionKey)) reject("name_collision");
    collisionKeys.add(collisionKey);
    if (size > ARCHIVE_ZIP_LIMITS.maxEntryBytes) reject("size_limit");
    totalBytes += size;
    if (totalBytes > ARCHIVE_ZIP_LIMITS.maxTotalBytes) reject("size_limit");
    if (method === 0 && compressedSize !== size) reject("malformed_zip");
    if (method === 8 && exceedsCompressionRatio(size, compressedSize)) reject("compression_ratio");

    if (localOffset !== expectedLocal || localOffset + 30 > directoryStart) reject("malformed_zip");
    if (
      bytes.readUInt32LE(localOffset) !== LOCAL_SIGNATURE ||
      bytes.readUInt16LE(localOffset + 6) !== flags ||
      bytes.readUInt16LE(localOffset + 8) !== method ||
      bytes.readUInt32LE(localOffset + 14) !== checksum ||
      bytes.readUInt32LE(localOffset + 18) !== compressedSize ||
      bytes.readUInt32LE(localOffset + 22) !== size ||
      bytes.readUInt16LE(localOffset + 26) !== nameLength
    )
      reject("malformed_zip");
    if (bytes.readUInt16LE(localOffset + 28) !== 0) reject("unsupported_zip_feature");
    const dataStart = localOffset + 30 + nameLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > directoryStart || !bytes.subarray(localOffset + 30, dataStart).equals(rawName))
      reject("malformed_zip");
    expectedLocal = dataEnd;
    const compressed = bytes.subarray(dataStart, dataEnd);
    entries.push({
      name,
      size,
      read: () => {
        let content: Buffer = compressed;
        if (method === 8) {
          try {
            content = inflateWholeStream(compressed, size) ?? reject("malformed_zip");
          } catch (error) {
            if (error instanceof ArchiveZipError) throw error;
            reject(error instanceof RangeError ? "size_limit" : "malformed_zip");
          }
        }
        if (content.length !== size || crc32(content) !== checksum) reject("malformed_zip");
        return content;
      },
    });
    cursor = nameEnd;
  }
  if (cursor !== end || expectedLocal !== directoryStart) reject("malformed_zip");
  return entries;
}

// Node reports consumed input only through the untyped `info` result. Bytes hidden after
// the end of the deflate stream make the entry malformed.
function inflateWholeStream(compressed: Buffer, size: number): Buffer | null {
  const result: unknown = inflateRawSync(compressed, {
    info: true,
    maxOutputLength: Math.max(1, size),
  });
  if (
    typeof result !== "object" ||
    result === null ||
    !("buffer" in result) ||
    !("engine" in result)
  )
    return null;
  const { buffer, engine } = result;
  if (
    !Buffer.isBuffer(buffer) ||
    typeof engine !== "object" ||
    engine === null ||
    !("bytesWritten" in engine) ||
    engine.bytesWritten !== compressed.length
  )
    return null;
  return buffer;
}

function exceedsCompressionRatio(size: number, compressedSize: number): boolean {
  return (
    size > ARCHIVE_ZIP_LIMITS.ratioFloorBytes &&
    size > compressedSize * ARCHIVE_ZIP_LIMITS.maxCompressionRatio
  );
}

function isSafeEntryName(name: string): boolean {
  if (
    /[\p{Cc}\p{Cf}\\:]/u.test(name) ||
    name.startsWith("/") ||
    name.endsWith("/") ||
    /^[A-Za-z]:/u.test(name)
  )
    return false;
  return name.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

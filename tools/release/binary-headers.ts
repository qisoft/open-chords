const MACH_O_64_LE_MAGIC = 0xfeedfacf;
const FAT_MAGIC = 0xcafebabe;
const MAX_FAT_SLICES = 16;
const MH_EXECUTE = 2;

export const MACH_O_HEADER_BYTES = 16;

export function machOFirstSliceOffset(header: Buffer): number | undefined {
  if (header.length < 8) return undefined;
  if (header.readUInt32LE(0) === MACH_O_64_LE_MAGIC) return 0;
  if (header.readUInt32BE(0) !== FAT_MAGIC) return undefined;
  const slices = header.readUInt32BE(4);
  if (slices === 0 || slices > MAX_FAT_SLICES || header.length < 20) return undefined;
  return header.readUInt32BE(16);
}

export function isMachOExecuteSlice(slice: Buffer): boolean {
  return (
    slice.length >= MACH_O_HEADER_BYTES &&
    slice.readUInt32LE(0) === MACH_O_64_LE_MAGIC &&
    slice.readUInt32LE(12) === MH_EXECUTE
  );
}

const PE32_MAGIC = 0x10b;
const PE32_PLUS_MAGIC = 0x20b;
const APPCONTAINER = 0x1000;
const SECURITY_DIRECTORY = 4;

export type PeFacts = { readonly authenticodeSigned: boolean; readonly appContainerImage: boolean };

export function readPeFacts(header: Buffer): PeFacts | undefined {
  if (header.length < 0x40 || header.toString("latin1", 0, 2) !== "MZ") return undefined;
  const peOffset = header.readUInt32LE(0x3c);
  if (
    peOffset + 24 > header.length ||
    header.toString("latin1", peOffset, peOffset + 4) !== "PE\0\0"
  ) {
    return undefined;
  }
  const optional = peOffset + 24;
  if (optional + 2 > header.length) return undefined;
  const magic = header.readUInt16LE(optional);
  if (magic !== PE32_MAGIC && magic !== PE32_PLUS_MAGIC) return undefined;
  const directoryCountOffset = optional + (magic === PE32_MAGIC ? 92 : 108);
  const directories = optional + (magic === PE32_MAGIC ? 96 : 112);
  const securitySizeOffset = directories + SECURITY_DIRECTORY * 8 + 4;
  if (securitySizeOffset + 4 > header.length) return undefined;
  const directoryCount = header.readUInt32LE(directoryCountOffset);
  return {
    authenticodeSigned:
      directoryCount > SECURITY_DIRECTORY && header.readUInt32LE(securitySizeOffset) > 0,
    appContainerImage: (header.readUInt16LE(optional + 0x46) & APPCONTAINER) !== 0,
  };
}

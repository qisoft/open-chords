import { expect, it } from "vitest";

import {
  isMachOExecuteSlice,
  machOFirstSliceOffset,
  readPeFacts,
} from "../tools/release/binary-headers.ts";

function thinMachO(fileType: number): Buffer {
  const header = Buffer.alloc(32);
  header.writeUInt32LE(0xfeedfacf, 0);
  header.writeUInt32LE(0x0100000c, 4);
  header.writeUInt32LE(fileType, 12);
  return header;
}

function fatHeader(slices: number, firstOffset: number): Buffer {
  const header = Buffer.alloc(32);
  header.writeUInt32BE(0xcafebabe, 0);
  header.writeUInt32BE(slices, 4);
  header.writeUInt32BE(0x0100000c, 8);
  header.writeUInt32BE(firstOffset, 16);
  return header;
}

function portableExecutable(options: {
  magic: number;
  dllCharacteristics: number;
  securityBytes: number;
}): Buffer {
  const image = Buffer.alloc(512);
  image.write("MZ", 0, "latin1");
  image.writeUInt32LE(0x80, 0x3c);
  image.write("PE\0\0", 0x80, "latin1");
  const optional = 0x80 + 24;
  image.writeUInt16LE(options.magic, optional);
  image.writeUInt16LE(options.dllCharacteristics, optional + 0x46);
  const plus = options.magic === 0x20b;
  image.writeUInt32LE(16, optional + (plus ? 108 : 92));
  const security = optional + (plus ? 112 : 96) + 4 * 8;
  image.writeUInt32LE(options.securityBytes === 0 ? 0 : 0x4000, security);
  image.writeUInt32LE(options.securityBytes, security + 4);
  return image;
}

it("finds the MH_EXECUTE Mach-O files and nothing else", () => {
  expect(machOFirstSliceOffset(thinMachO(2))).toBe(0);
  expect(isMachOExecuteSlice(thinMachO(2))).toBe(true);
  expect(isMachOExecuteSlice(thinMachO(6))).toBe(false);
  expect(machOFirstSliceOffset(fatHeader(2, 0x4000))).toBe(0x4000);
  expect(machOFirstSliceOffset(fatHeader(52, 0))).toBeUndefined();
  expect(machOFirstSliceOffset(Buffer.from("#!/bin/sh\nexit 0\n"))).toBeUndefined();
});

it("reads Authenticode and AppContainer facts from PE32 and PE32+ headers", () => {
  expect(
    readPeFacts(
      portableExecutable({ magic: 0x20b, dllCharacteristics: 0x1160, securityBytes: 0x2000 }),
    ),
  ).toEqual({ authenticodeSigned: true, appContainerImage: true });
  expect(
    readPeFacts(portableExecutable({ magic: 0x10b, dllCharacteristics: 0x0140, securityBytes: 0 })),
  ).toEqual({ authenticodeSigned: false, appContainerImage: false });
  expect(readPeFacts(Buffer.concat([Buffer.from("MZ"), Buffer.alloc(126)]))).toBeUndefined();
  expect(readPeFacts(Buffer.from("not an executable"))).toBeUndefined();
});

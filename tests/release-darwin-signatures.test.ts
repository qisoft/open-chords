import { expect, it } from "vitest";

import { classifyCodeSignature } from "../tools/release/darwin-signatures.ts";

const ADHOC = [
  "Executable=/tmp/Open Chords.app/Contents/MacOS/Open Chords",
  "Identifier=io.github.qisoft.open-chords",
  "CodeDirectory v=20400 size=392 flags=0x20002(adhoc,linker-signed) hashes=9+0 location=embedded",
  "Signature=adhoc",
  "Info.plist=not bound",
  "TeamIdentifier=not set",
  "",
].join("\n");

it("classifies ad-hoc and unsigned code from codesign details", () => {
  expect(classifyCodeSignature(ADHOC, 0)).toBe("adhoc");
  expect(classifyCodeSignature("/tmp/tool: code object is not signed at all\n", 1)).toBe(
    "unsigned",
  );
});

it("refuses certificate chains and team identifiers the manifest cannot represent", () => {
  expect(() =>
    classifyCodeSignature(`${ADHOC}Authority=Developer ID Application: Someone (ABCDE12345)\n`, 0),
  ).toThrow("Executable carries a certificate chain");
  expect(() =>
    classifyCodeSignature(ADHOC.replace("TeamIdentifier=not set", "TeamIdentifier=ABCDE12345"), 0),
  ).toThrow("Executable carries a team identifier (TeamIdentifier=ABCDE12345)");
  expect(() => classifyCodeSignature("codesign: unexpected failure\n", 1)).toThrow(
    "Unrecognized code signature",
  );
});

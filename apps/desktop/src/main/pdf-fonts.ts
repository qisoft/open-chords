import { createHash } from "node:crypto";

import bold from "./fonts/NotoSans-Bold.ttf?inline";
import regular from "./fonts/NotoSans-Regular.ttf?inline";

export type LeadSheetFonts = { regular: Buffer; bold: Buffer };

function decode(dataUrl: string, sha256: string): Buffer {
  const match = /^data:[^;,]+;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match) throw new Error("Embedded PDF font is not inlined");
  const bytes = Buffer.from(match[1]!, "base64");
  if (createHash("sha256").update(bytes).digest("hex") !== sha256)
    throw new Error("Embedded PDF font does not match its pinned hash");
  return bytes;
}

let fonts: LeadSheetFonts | undefined;

export function leadSheetFonts(): LeadSheetFonts {
  fonts ??= {
    regular: decode(regular, "478c558ea716033cd60c03438f628dfa75694dcf6b5f6d505a2f05fd2b4f3823"),
    bold: decode(bold, "1df075a380fc7cb898acf64c1f7b3b4dd780de3caa860178bf929de35817a913"),
  };
  return fonts;
}

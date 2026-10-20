import { z } from "zod";

const evidence = z
  .strictObject({
    available: z.boolean(),
    identityMatches: z.boolean(),
    bytesMatch: z.boolean(),
    clientMs: z.number().int().min(0).max(100000),
    typesMs: z.number().int().min(0).max(100000),
    totalMs: z.number().int().min(0).max(100000),
  })
  .refine((value) => value.clientMs + value.typesMs === value.totalMs);

export function windowsUiaLoadDiagnostic(mode: "name" | "path", stdout: string) {
  if (stdout.length > 1024) throw new Error("Native UIAutomation load evidence invalid");
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new Error("Native UIAutomation load evidence invalid");
  }
  const parsed = evidence.safeParse(value);
  if (!parsed.success) throw new Error("Native UIAutomation load evidence invalid");
  const result = parsed.data;
  return `Native UIAutomation load: mode=${mode} available=${result.available} identity_matches=${result.identityMatches} bytes_match=${result.bytesMatch} client_ms=${result.clientMs} types_ms=${result.typesMs} total_ms=${result.totalMs}`;
}

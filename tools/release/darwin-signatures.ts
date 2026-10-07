import { spawnSync } from "node:child_process";

import { z } from "zod";

import type { DarwinExecutable } from "./release-manifest.ts";

const EntitlementsSchema = z.record(z.string(), z.json());

function run(command: string, args: readonly string[], input?: string) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    ...(input === undefined ? {} : { input }),
  });
  if (result.error !== undefined) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

export function readBundleIdentifier(infoPlist: string): string {
  const result = run("plutil", ["-extract", "CFBundleIdentifier", "raw", "-o", "-", infoPlist]);
  if (result.status !== 0) throw new Error(`plutil could not read ${infoPlist}: ${result.stderr}`);
  return result.stdout.trim();
}

export function classifyCodeSignature(
  details: string,
  status: number | null,
): DarwinExecutable["signature"] {
  if (details.includes("code object is not signed at all")) return "unsigned";
  const lines = details.split(/\r?\n/);
  const authority = lines.find((line) => line.startsWith("Authority="));
  if (authority !== undefined) {
    throw new Error(`Executable carries a certificate chain (${authority})`);
  }
  const team = lines.find((line) => line.startsWith("TeamIdentifier="));
  if (team !== undefined && team !== "TeamIdentifier=not set") {
    throw new Error(`Executable carries a team identifier (${team})`);
  }
  if (status === 0 && lines.includes("Signature=adhoc")) return "adhoc";
  throw new Error(`Unrecognized code signature:\n${details}`);
}

function readEntitlements(path: string): DarwinExecutable["entitlements"] {
  const xml = run("codesign", ["-d", "--entitlements", "-", "--xml", path]);
  if (xml.status !== 0) throw new Error(`codesign could not read entitlements: ${xml.stderr}`);
  if (xml.stdout.trim() === "") return {};
  const json = run("plutil", ["-convert", "json", "-o", "-", "-"], xml.stdout);
  if (json.status !== 0) throw new Error(`plutil could not convert entitlements: ${json.stderr}`);
  return EntitlementsSchema.parse(JSON.parse(json.stdout));
}

export function observeDarwinExecutable(absolutePath: string, path: string): DarwinExecutable {
  const details = run("codesign", ["-dvvv", absolutePath]);
  const signature = classifyCodeSignature(details.stderr, details.status);
  return {
    path,
    signature,
    teamIdentifier: null,
    entitlements: signature === "unsigned" ? {} : readEntitlements(absolutePath),
  };
}

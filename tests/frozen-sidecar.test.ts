import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { monoPcmWav } from "@open-chords/testkit/media";
import { afterAll, expect, it } from "vitest";
import { z } from "zod";

import {
  createPromiseSidecarClient,
  createUncontainedSpawnLauncherForProof,
  parseSidecarSessionRequest,
  SidecarSessionError,
} from "../apps/desktop/src/main/sidecar-session.ts";

const executablePath = process.env.OPEN_CHORDS_FROZEN_SIDECAR;
const temporaryRoots: string[] = [];

afterAll(() => {
  for (const root of temporaryRoots) rmSync(root, { force: true, recursive: true });
});

it.skipIf(executablePath === undefined)(
  "runs the same canonical decode deterministically without PATH or system runtimes",
  async () => {
    const runtimeRoot = dirname(executablePath!);
    const manifestBytes = readFileSync(join(runtimeRoot, "runtime-manifest.json"));
    const manifestHash = createHash("sha256").update(manifestBytes).digest("hex");
    const inventory = z
      .object({
        dependencies: z.array(
          z.object({
            component: z.string(),
            license: z.string(),
            licenseFile: z.string(),
            present: z.boolean(),
          }),
        ),
        nativeFiles: z.array(
          z.object({
            component: z.string(),
            format: z.string(),
            path: z.string(),
            sha256: z.string(),
          }),
        ),
      })
      .parse(JSON.parse(readFileSync(join(runtimeRoot, "native-dependencies.json"), "utf8")));
    for (const dependency of inventory.dependencies) {
      expect(dependency.license).not.toHaveLength(0);
      expect(readFileSync(join(runtimeRoot, dependency.licenseFile)).byteLength).toBeGreaterThan(0);
    }
    const dependenciesByComponent = new Map(
      inventory.dependencies.map((dependency) => [dependency.component, dependency]),
    );
    for (const nativeFile of inventory.nativeFiles) {
      expect(dependenciesByComponent.get(nativeFile.component)?.present).toBe(true);
      expect(
        createHash("sha256")
          .update(readFileSync(join(runtimeRoot, nativeFile.path)))
          .digest("hex"),
      ).toBe(nativeFile.sha256);
    }
    const inventoriedNativePaths = new Set(inventory.nativeFiles.map((entry) => entry.path));
    const discoveredNativePaths = allRuntimeFiles(runtimeRoot)
      .filter(isNativeBinary)
      .map((runtimePath) => runtimePath.slice(runtimeRoot.length + 1).replaceAll("\\", "/"));
    expect([...inventoriedNativePaths]).toEqual(expect.arrayContaining(discoveredNativePaths));
    const fixture = monoPcmWav(
      Array.from({ length: 48_000 }, (_value, index) => Math.round(Math.sin(index / 13) * 4_000)),
    );

    const manifests: unknown[] = [];
    for (const suffix of ["first", "second"]) {
      const workspace = mkdtempSync(join(tmpdir(), `open-chords-frozen-${suffix}-`));
      temporaryRoots.push(workspace);
      const inputPath = join(workspace, "input", "source-media");
      mkdirSync(dirname(inputPath), { recursive: true });
      writeFileSync(inputPath, fixture);
      const client = createPromiseSidecarClient(
        createUncontainedSpawnLauncherForProof({
          args: [],
          cwd: workspace,
          env: {},
          executablePath: resolve(executablePath!),
        }),
      );
      try {
        let result: Awaited<ReturnType<typeof client.runSession>> | undefined;
        let errorCode = "unknown";
        try {
          result = await client.runSession(
            parseSidecarSessionRequest({
              jobId: `job-frozen-${suffix}`,
              manifestHash,
              nonce: `nonce-frozen-${suffix}`,
              requestId: `request-frozen-${suffix}`,
              timeoutMs: 10_000,
            }),
          );
        } catch (error) {
          errorCode = error instanceof SidecarSessionError ? error.code : "unknown";
        }
        if (result === undefined) {
          throw new Error(
            `Frozen sidecar failed (${errorCode}); bounded native diagnostics: ${nativeToolDiagnostics(runtimeRoot, inputPath, workspace)}`,
          );
        }
        expect(result.artifact.path).toBe("artifacts/decode-manifest.json");
        manifests.push(JSON.parse(readFileSync(join(workspace, result.artifact.path), "utf8")));
      } finally {
        await client.dispose();
      }
    }

    expect(manifests[0]).toEqual(manifests[1]);
    expect(manifests[0]).toMatchObject({
      canonicalAudio: {
        channels: 1,
        sampleCount: 48_000,
        sampleFormat: "s16le",
        sampleRate: 48_000,
      },
      configuration: {
        value: {
          platformProfile:
            process.platform === "win32" ? "windows-server-2025-x64" : "darwin-arm64",
        },
      },
      tools: {
        ffmpeg: {
          configuration: expect.stringContaining("--disable-network"),
        },
      },
    });
  },
  20_000,
);

function allRuntimeFiles(root: string): string[] {
  const entries = readdirSync(root, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return allRuntimeFiles(path);
    return entry.isFile() ? [path] : [];
  });
}

function isNativeBinary(path: string): boolean {
  const content = readFileSync(path);
  const magic = content.subarray(0, 4).toString("hex");
  return (
    magic.startsWith("4d5a") ||
    magic === "7f454c46" ||
    [
      "feedface",
      "cefaedfe",
      "feedfacf",
      "cffaedfe",
      "cafebabe",
      "bebafeca",
      "cafebabf",
      "bfbafeca",
    ].includes(magic) ||
    /\.(?:dll|dylib|exe|pyd|so)$/iu.test(path)
  );
}

function nativeToolDiagnostics(runtimeRoot: string, inputPath: string, workspace: string): string {
  const executableSuffix = process.platform === "win32" ? ".exe" : "";
  const ffmpeg = join(runtimeRoot, "tools", `ffmpeg${executableSuffix}`);
  const ffprobe = join(runtimeRoot, "tools", `ffprobe${executableSuffix}`);
  const environment =
    process.platform === "win32"
      ? { SYSTEMROOT: process.env.SYSTEMROOT ?? "C:\\Windows" }
      : { LANG: "C", LC_ALL: "C" };
  const diagnosticOutput = join(workspace, "artifacts", "diagnostic.wav");
  mkdirSync(dirname(diagnosticOutput), { recursive: true });
  const checks = [
    ["ffprobe-version", ffprobe, ["-version"]],
    [
      "ffprobe-input",
      ffprobe,
      [
        "-v",
        "error",
        "-select_streams",
        "a:0",
        "-show_entries",
        "stream=codec_type",
        "-of",
        "json",
        inputPath,
      ],
    ],
    ["ffmpeg-version", ffmpeg, ["-version"]],
    [
      "ffmpeg-decode",
      ffmpeg,
      [
        "-v",
        "error",
        "-i",
        inputPath,
        "-map",
        "0:a:0",
        "-c:a",
        "pcm_s16le",
        "-f",
        "wav",
        "-y",
        diagnosticOutput,
      ],
    ],
  ] as const;
  return checks
    .map(([label, command, arguments_]) => {
      const diagnostic = spawnSync(command, arguments_, {
        env: environment,
        stdio: "ignore",
        timeout: 1_000,
      });
      return `${label}=${diagnostic.error?.name ?? diagnostic.signal ?? diagnostic.status ?? "unknown"}`;
    })
    .join(",");
}

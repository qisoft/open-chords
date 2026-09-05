import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
const probeArgumentsFixture = z
  .object({ arguments: z.array(z.string()) })
  .parse(
    JSON.parse(readFileSync(resolve("tests/fixtures/canonical-probe-arguments.json"), "utf8")),
  );
const temporaryRoots: string[] = [];

afterAll(() => {
  for (const root of temporaryRoots) rmSync(root, { force: true, recursive: true });
});

it.skipIf(executablePath === undefined)(
  "validates the frozen runtime and runs deterministic uncontained analysis where supported",
  async () => {
    const runtimeRoot = dirname(executablePath!);
    const importWorkspace = mkdtempSync(join(tmpdir(), "open-chords-frozen-import-"));
    temporaryRoots.push(importWorkspace);
    const analysisImport = spawnSync(executablePath!, ["--cpu-analysis-import-check"], {
      cwd: importWorkspace,
      encoding: "utf8",
      env: {},
      timeout: 90_000,
    });
    if (analysisImport.status !== 0) throw new Error(analysisImport.stderr);
    expect(JSON.parse(analysisImport.stdout)).toEqual({
      capability: "cpu_analysis",
      durationSamples: 48_000,
      profiles: ["balanced", "eco", "fast"],
      stageOutcomes: ["shared_features", "harmony", "assemble"],
    });
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
    const windowsRuntimePath = join(runtimeRoot, "windows-runtime.json");
    const windowsRuntimeSchema = z.object({
      nativeFiles: z
        .array(z.object({ file: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/u) }))
        .min(1),
      package: z.object({
        name: z.literal("mingw-w64-ucrt-x86_64-libwinpthread"),
        url: z.literal("https://packages.msys2.org/packages/mingw-w64-ucrt-x86_64-libwinpthread"),
        version: z.string().min(1),
      }),
      schemaVersion: z.literal(1),
    });
    const windowsRuntime = existsSync(windowsRuntimePath)
      ? windowsRuntimeSchema.parse(JSON.parse(readFileSync(windowsRuntimePath, "utf8")))
      : undefined;
    expect(windowsRuntime === undefined).toBe(process.platform !== "win32");
    for (const runtimeFile of windowsRuntime?.nativeFiles ?? []) {
      const runtimeFilePath = join(runtimeRoot, "tools", runtimeFile.file);
      expect(createHash("sha256").update(readFileSync(runtimeFilePath)).digest("hex")).toBe(
        runtimeFile.sha256,
      );
      expect(inventory.nativeFiles).toContainEqual(
        expect.objectContaining({
          component: "winpthreads",
          path: `tools/${runtimeFile.file}`,
          sha256: runtimeFile.sha256,
        }),
      );
    }
    if (process.platform === "win32") return;
    const fixture = monoPcmWav(
      Array.from({ length: 48_000 }, (_value, index) => Math.round(Math.sin(index / 13) * 4_000)),
    );

    const candidates: unknown[] = [];
    const decodeManifests: unknown[] = [];
    for (const suffix of ["first", "second"]) {
      const workspace = mkdtempSync(join(tmpdir(), `open-chords-frozen-${suffix}-`));
      temporaryRoots.push(workspace);
      const inputPath = join(workspace, "input", "source-media");
      mkdirSync(dirname(inputPath), { recursive: true });
      writeFileSync(inputPath, fixture);
      writeFileSync(
        join(workspace, "input", "analysis-recipe.json"),
        JSON.stringify(analysisRecipe),
      );
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
          if (error instanceof SidecarSessionError) {
            const remoteCode = /^Sidecar ([a-z_]{1,64}):/u.exec(error.message)?.[1];
            errorCode = remoteCode === undefined ? error.code : `${error.code}/${remoteCode}`;
          }
        }
        if (result === undefined) {
          throw new Error(
            `Frozen sidecar failed (${errorCode}); bounded native diagnostics: ${nativeToolDiagnostics(runtimeRoot, inputPath, workspace)}`,
          );
        }
        expect(result.artifact.path).toBe("artifacts/analysis-result.json");
        candidates.push(JSON.parse(readFileSync(join(workspace, result.artifact.path), "utf8")));
        decodeManifests.push(
          JSON.parse(readFileSync(join(workspace, "artifacts", "decode-manifest.json"), "utf8")),
        );
      } finally {
        await client.dispose();
      }
    }

    expect(candidates[0]).toEqual(candidates[1]);
    expect(decodeManifests[0]).toEqual(decodeManifests[1]);
    expect(decodeManifests[0]).toMatchObject({
      canonicalAudio: {
        channels: 1,
        sampleCount: 48_000,
        sampleFormat: "s16le",
        sampleRate: 48_000,
      },
      configuration: { value: { platformProfile: "darwin-arm64" } },
      tools: { ffmpeg: { configuration: expect.stringContaining("--disable-network") } },
    });
    expect(candidates[0]).toMatchObject({
      durationSamples: 48_000,
      recipe: analysisRecipe,
      sampleRate: 48_000,
      stageOutcomes: expect.arrayContaining([
        { stage: "shared_features", state: expect.stringMatching(/^completed/u) },
        { stage: "assemble", state: "completed" },
      ]),
      supportClaimIds: [],
      timeline: {
        chordEvents: expect.any(Array),
        keyRegions: expect.any(Array),
        sectionRegions: expect.any(Array),
      },
    });
  },
  180_000,
);

const analysisRecipe = {
  capabilities: ["rhythm", "meter", "key", "chords", "sections"],
  components: [
    {
      hash: `sha256:${"1".repeat(64)}`,
      id: "open-chords-cpu-dsp",
      version: "1.0.0",
    },
  ],
  numericalBackend: {
    hash: `sha256:${"2".repeat(64)}`,
    id: "numpy",
    version: "2.5.2",
  },
  pipeline: [
    "preflight",
    "canonical_decode",
    "shared_features",
    "rhythm",
    "harmony",
    "sections",
    "assemble",
    "main_validation",
    "publish",
  ],
  profile: {
    hash: `sha256:${"3".repeat(64)}`,
    id: "balanced",
    name: "balanced",
    version: "1.0.0",
  },
  seeds: { decoder: 0 },
  settings: { analysisWindowSamples: 96_000, hopLength: 1_024, nFft: 8_192 },
};

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
  const environment = { LANG: "C", LC_ALL: "C" } as Record<string, string>;
  if (process.platform === "win32") {
    environment.SYSTEMROOT = process.env.SYSTEMROOT ?? "C:\\Windows";
  }
  const diagnosticOutput = join(workspace, "artifacts", "diagnostic.wav");
  mkdirSync(dirname(diagnosticOutput), { recursive: true });
  const exactProbeArguments = [...probeArgumentsFixture.arguments, inputPath];
  const fullProbeArguments = withoutProtocolWhitelist(exactProbeArguments);
  const decodeArguments = [
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
  ];
  const checks = [
    ["ffprobe-full", ffprobe, fullProbeArguments],
    ["ffprobe-full-whitelist", ffprobe, exactProbeArguments],
    ["ffmpeg-basic", ffmpeg, decodeArguments],
    ["ffmpeg-whitelist", ffmpeg, withProtocolWhitelist(decodeArguments)],
  ] as const;
  return checks
    .map(([label, command, arguments_]) => {
      const diagnostic = spawnSync(command, arguments_, {
        env: environment,
        encoding: "utf8",
        maxBuffer: 64 * 1024,
        timeout: 1_000,
      });
      const outcome = diagnostic.error?.name ?? diagnostic.signal ?? diagnostic.status ?? "unknown";
      if (!label.startsWith("ffprobe")) return `${label}=${outcome}`;
      return `${label}=${outcome}/${probeOutputShape(diagnostic.stdout)}/out-${Buffer.byteLength(diagnostic.stdout ?? "")}/err-${Buffer.byteLength(diagnostic.stderr ?? "")}`;
    })
    .join(",");
}

it.each([
  ["invalid JSON", "{", "invalid-json"],
  ["a non-object", "[]", "no-streams"],
  ["a missing streams property", "{}", "no-streams"],
  ["a non-array streams property", '{"streams":{}}', "invalid-streams"],
  ["a bounded stream array", '{"streams":[{}]}', "streams-1"],
])("classifies %s probe output", (_case, output, expected) => {
  expect(probeOutputShape(output)).toBe(expected);
});

function probeOutputShape(output: string | null): string {
  try {
    const parsed: unknown = JSON.parse(output ?? "");
    if (typeof parsed !== "object" || parsed === null || !("streams" in parsed))
      return "no-streams";
    const streams = (parsed as { streams?: unknown }).streams;
    return Array.isArray(streams) ? `streams-${streams.length}` : "invalid-streams";
  } catch {
    return "invalid-json";
  }
}

function withoutProtocolWhitelist(arguments_: string[]): string[] {
  const optionIndex = arguments_.indexOf("-protocol_whitelist");
  if (optionIndex < 0) return arguments_;
  return [...arguments_.slice(0, optionIndex), ...arguments_.slice(optionIndex + 2)];
}

function withProtocolWhitelist(arguments_: string[]): string[] {
  return ["-protocol_whitelist", "file,pipe", ...arguments_];
}

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { monoPcmWav } from "@open-chords/testkit/media";
import { afterAll, expect, it } from "vitest";
import { z } from "zod";

import {
  createPromiseSidecarClient,
  createUncontainedSpawnLauncherForProof,
  parseSidecarSessionRequest,
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
          z.object({ component: z.string(), path: z.string(), sha256: z.string() }),
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
        const result = await client.runSession(
          parseSidecarSessionRequest({
            jobId: `job-frozen-${suffix}`,
            manifestHash,
            nonce: `nonce-frozen-${suffix}`,
            requestId: `request-frozen-${suffix}`,
            timeoutMs: 10_000,
          }),
        );
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

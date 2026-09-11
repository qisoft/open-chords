import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, opendir } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { AcquisitionBroker, type AcquisitionNetwork } from "./acquisition-broker.ts";
import { runAcquisitionSession } from "./acquisition-session.ts";
import { readBoundedFile } from "./bounded-file.ts";
import { preparePackagedWorkspace } from "./packaged-sidecar-proof-workspace.ts";
import { verifyContainmentRuntime } from "./sidecar-containment-integrity.ts";
import { createNativeContainmentLauncher } from "./sidecar-containment-launcher.ts";
import { createExecutableNativeContainmentBroker } from "./sidecar-native-broker.ts";
import { parseSidecarSessionRequest } from "./sidecar-protocol.ts";

const Hash = z.string().regex(/^[a-f0-9]{64}$/u);
const Manifest = z.strictObject({
  version: z.literal(1),
  platform: z.enum(["darwin-arm64", "win32-x64"]),
  components: z.object({
    ytDlp: z.object({ version: z.literal("2026.7.4"), sha256: Hash }),
    ejs: z.object({ version: z.literal("0.8.0"), sha256: Hash }),
    deno: z.object({ version: z.literal("2.8.3") }),
  }),
  files: z
    .array(
      z.strictObject({
        path: z
          .string()
          .min(1)
          .max(600)
          .refine((path) =>
            path
              .split("/")
              .every(
                (part) =>
                  part.length > 0 &&
                  part !== "." &&
                  part !== ".." &&
                  !/[\\:]/u.test(part) &&
                  !part.includes(String.fromCharCode(0)),
              ),
          ),
        bytes: z
          .number()
          .int()
          .nonnegative()
          .max(256 * 1024 * 1024),
        sha256: Hash,
      }),
    )
    .min(1)
    .max(5000),
});

export async function verifyAcquisitionRuntime(root: string, expectedHash: string) {
  try {
    Hash.parse(expectedHash);
    if (!(await lstat(root)).isDirectory()) throw new Error();
    const bytes = await readBoundedFile(join(root, "runtime-info.json"), 4 * 1024 * 1024);
    if (createHash("sha256").update(bytes).digest("hex") !== expectedHash) throw new Error();
    const manifest = Manifest.parse(JSON.parse(bytes.toString("utf8")));
    if (manifest.platform !== `${process.platform}-${process.arch}`) throw new Error();
    const expected = new Map(manifest.files.map((file) => [file.path, file]));
    if (
      expected.size !== manifest.files.length ||
      new Set(manifest.files.map((file) => file.path.toLowerCase())).size !== expected.size
    )
      throw new Error();
    const seen = new Set<string>();
    const visit = async (prefix: string) => {
      const directory = await opendir(join(root, prefix));
      for await (const entry of directory) {
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          await visit(relative);
          continue;
        }
        if (!entry.isFile()) throw new Error();
        if (relative === "runtime-info.json") continue;
        const file = expected.get(relative);
        if (!file) throw new Error();
        const path = join(root, relative);
        if ((await lstat(path)).size !== file.bytes) throw new Error();
        const hash = createHash("sha256");
        for await (const chunk of createReadStream(path)) hash.update(chunk);
        if (hash.digest("hex") !== file.sha256) throw new Error();
        seen.add(relative);
      }
    };
    await visit("");
    const suffix = process.platform === "win32" ? ".exe" : "";
    if (
      seen.size !== expected.size ||
      !seen.has(`deno${suffix}`) ||
      !seen.has(`open-chords-extractor-worker${suffix}`)
    )
      throw new Error();
    return {
      executablePath: join(root, `open-chords-extractor-worker${suffix}`),
      manifestHash: expectedHash,
      components: manifest.components,
    };
  } catch {
    throw new Error("acquisition_runtime_unavailable");
  }
}

export type AcquisitionRuntimeOptions = {
  runtimeRoot: string;
  runtimeManifestHash: string;
  containmentRoot: string;
  containmentManifestHash: string;
  bridgePath?: string;
};

export async function openContainedAcquisitionAttempt(
  options: AcquisitionRuntimeOptions,
  identifier: string = randomUUID(),
) {
  if (process.platform !== "darwin" && process.platform !== "win32")
    throw new Error("acquisition_runtime_unavailable");
  const platform = process.platform;
  await verifyAcquisitionRuntime(options.runtimeRoot, options.runtimeManifestHash);
  const containment = verifyContainmentRuntime(
    options.containmentRoot,
    options.containmentManifestHash,
    platform,
    options.bridgePath,
  );
  const prepared = preparePackagedWorkspace(
    platform,
    containment.helperPath,
    options.runtimeRoot,
    identifier,
  );
  try {
    const runtime = await verifyAcquisitionRuntime(
      prepared.runtimeRoot,
      options.runtimeManifestHash,
    );
    return {
      workspace: prepared.workspace,
      cleanup: () => prepared.cleanup(),
      async run(input: {
        videoId: string;
        signal?: AbortSignal;
        proof?: boolean;
        network?: AcquisitionNetwork;
        onCounters?: (counters: {
          requests: number;
          responseBytes: number;
          activeStreams: number;
          redirects: number;
        }) => void;
      }) {
        const broker = new AcquisitionBroker({
          videoId: input.videoId,
          ...(input.network ? { network: input.network } : {}),
        });
        const native = createExecutableNativeContainmentBroker({
          args: [input.proof ? "--containment-proof" : "--acquire"],
          containment,
          executablePath: runtime.executablePath,
          platform,
          runtimeRoot: prepared.runtimeRoot,
          workspace: prepared.workspace,
          ...(prepared.windowsProfile ? { windowsProfile: prepared.windowsProfile } : {}),
        });
        const launcher = createNativeContainmentLauncher(native, platform);
        try {
          const result = await runAcquisitionSession({
            videoId: input.videoId,
            broker,
            proof: input.proof ?? false,
            ...(input.signal ? { signal: input.signal } : {}),
            launch: (signal) =>
              launcher.launch(
                parseSidecarSessionRequest({
                  jobId: identifier,
                  requestId: identifier,
                  nonce: randomUUID(),
                  manifestHash: options.runtimeManifestHash,
                  timeoutMs: 180000,
                }),
                signal,
              ),
          });
          return { ...result, counters: broker.counters() };
        } finally {
          input.onCounters?.(broker.counters());
        }
      },
    };
  } catch (error) {
    prepared.cleanup();
    throw error;
  }
}

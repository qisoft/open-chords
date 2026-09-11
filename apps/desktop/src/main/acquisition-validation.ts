import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { copyAcquiredFile } from "./acquisition-files.ts";
import type { AcquisitionRuntimeOptions } from "./acquisition-runtime.ts";
import { rethrowAfterAcquisitionCleanup } from "./acquisition-workspace-cleanup.ts";
import { readBoundedFile } from "./bounded-file.ts";
import { inspectCanonicalMedia } from "./local-media.ts";
import {
  preparePackagedWorkspace,
  type PreparedPackagedWorkspace,
} from "./packaged-sidecar-proof-workspace.ts";
import { verifyContainmentRuntime } from "./sidecar-containment-integrity.ts";
import { createNativeContainmentLauncher } from "./sidecar-containment-launcher.ts";
import { createExecutableNativeContainmentBroker } from "./sidecar-native-broker.ts";
import { verifyPackagedSidecarRuntime } from "./sidecar-runtime-integrity.ts";
import { createPromiseSidecarClient, parseSidecarSessionRequest } from "./sidecar-session.ts";

const Descriptor = z.strictObject({
  byteSize: z
    .number()
    .int()
    .positive()
    .max(512 * 1024 * 1024),
  path: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
});
const DecodeManifest = z.object({
  acquisitionFormat: z.strictObject({
    container: z.enum(["mp4", "webm"]),
    audioCodec: z.enum(["aac", "opus", "vorbis"]),
  }),
  artifact: Descriptor.extend({ path: z.literal("artifacts/canonical.wav") }),
  input: Descriptor.extend({ path: z.literal("input/source-media") }),
  canonicalAudio: z.strictObject({
    channels: z.literal(1),
    sampleCount: z
      .number()
      .int()
      .positive()
      .max(48000 * 3600),
    sampleFormat: z.literal("s16le"),
    sampleRate: z.literal(48000),
  }),
  schemaVersion: z.literal(1),
});

export async function openAcquisitionValidation(
  options: AcquisitionRuntimeOptions,
  identifier = randomUUID(),
) {
  if (process.platform !== "darwin" && process.platform !== "win32")
    throw new Error("acquisition_validation_unavailable");
  const platform = process.platform;
  verifyPackagedSidecarRuntime(options.runtimeRoot, options.runtimeManifestHash);
  const containment = verifyContainmentRuntime(
    options.containmentRoot,
    options.containmentManifestHash,
    platform,
    options.bridgePath,
  );
  let workspace: PreparedPackagedWorkspace | undefined;
  try {
    const prepared = preparePackagedWorkspace(
      platform,
      containment.helperPath,
      options.runtimeRoot,
      identifier,
    );
    workspace = prepared;
    const runtime = verifyPackagedSidecarRuntime(prepared.runtimeRoot, options.runtimeManifestHash);
    return {
      workspace: prepared.workspace,
      cleanup: () => prepared.cleanup(),
      async validate(input: { path: string; bytes: number; sha256: string; signal: AbortSignal }) {
        input.signal.throwIfAborted();
        await mkdir(join(prepared.workspace, "input"), { mode: 0o700 });
        await copyAcquiredFile(input.path, join(prepared.workspace, "input/source-media"), input);
        const launcher = createNativeContainmentLauncher(
          createExecutableNativeContainmentBroker({
            args: ["--acquisition-validation"],
            containment,
            executablePath: runtime.executablePath,
            platform,
            runtimeRoot: prepared.runtimeRoot,
            workspace: prepared.workspace,
            ...(prepared.windowsProfile ? { windowsProfile: prepared.windowsProfile } : {}),
          }),
          platform,
        );
        const client = createPromiseSidecarClient(launcher);
        try {
          const result = await client.runSession(
            parseSidecarSessionRequest({
              jobId: identifier,
              requestId: identifier,
              nonce: randomUUID(),
              manifestHash: runtime.manifestHash,
              timeoutMs: 120000,
              signal: input.signal,
            }),
          );
          if (result.artifact.path !== "artifacts/decode-manifest.json")
            throw new Error("invalid_acquisition_artifact");
          const bytes = await readBoundedFile(
            join(prepared.workspace, result.artifact.path),
            65536,
          );
          if (
            bytes.byteLength !== result.artifact.byteSize ||
            createHash("sha256").update(bytes).digest("hex") !== result.artifact.sha256
          )
            throw new Error("invalid_acquisition_artifact");
          const manifest = DecodeManifest.parse(JSON.parse(bytes.toString("utf8")));
          if (manifest.input.byteSize !== input.bytes || manifest.input.sha256 !== input.sha256)
            throw new Error("invalid_acquisition_artifact");
          const path = join(prepared.workspace, "artifacts/canonical.wav");
          const canonical = await inspectCanonicalMedia(path);
          if (
            canonical.durationSamples !== manifest.canonicalAudio.sampleCount ||
            canonical.byteSize !== manifest.artifact.byteSize ||
            canonical.byteFingerprint !== `sha256:${manifest.artifact.sha256}`
          )
            throw new Error("invalid_acquisition_artifact");
          input.signal.throwIfAborted();
          return {
            ...canonical,
            format: manifest.acquisitionFormat,
            path,
            acquiredPath: join(prepared.workspace, "input/source-media"),
          };
        } finally {
          await client.dispose();
        }
      },
    };
  } catch (error) {
    return rethrowAfterAcquisitionCleanup(error, workspace);
  }
}

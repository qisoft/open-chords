import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

import { z } from "zod";

import { EXPECTED_CONTAINMENT_MANIFEST_SHA256 } from "./containment-build-metadata.ts";
import { EXPECTED_SIDECAR_MANIFEST_SHA256 } from "./sidecar-build-metadata.ts";
import { verifyContainmentRuntime } from "./sidecar-containment-integrity.ts";
import { createNativeContainmentLauncher } from "./sidecar-containment-launcher.ts";
import { createExecutableNativeContainmentBroker } from "./sidecar-native-broker.ts";
import { verifyPackagedSidecarRuntime } from "./sidecar-runtime-integrity.ts";
import { createEffectSidecarClient, parseSidecarSessionRequest } from "./sidecar-session.ts";

export async function runPackagedSidecarProof(): Promise<void> {
  if (process.platform !== "darwin" && process.platform !== "win32") {
    throw new Error("Packaged containment proof targets macOS and Windows only");
  }
  const platform = process.platform;
  const verifiedRuntime = verifyPackagedSidecarRuntime(
    join(process.resourcesPath, "open-chords-analysis"),
    EXPECTED_SIDECAR_MANIFEST_SHA256,
  );
  const containment = verifyContainmentRuntime(
    join(process.resourcesPath, "containment"),
    EXPECTED_CONTAINMENT_MANIFEST_SHA256,
    platform,
  );
  const prepared = prepareWorkspace(platform, containment.helperPath, verifiedRuntime.runtimeRoot);
  const containedRuntime = verifyPackagedSidecarRuntime(
    prepared.runtimeRoot,
    EXPECTED_SIDECAR_MANIFEST_SHA256,
  );
  const workspace = prepared.workspace;
  const inputPath = join(workspace, "input", "source-media");
  mkdirSync(dirname(inputPath), { recursive: true });
  writeFileSync(inputPath, canonicalWavFixture());
  const createLauncher = (args: readonly string[]) =>
    createNativeContainmentLauncher(
      createExecutableNativeContainmentBroker({
        args,
        containment,
        executablePath: containedRuntime.executablePath,
        platform,
        runtimeRoot: containedRuntime.runtimeRoot,
        ...(prepared.windowsProfile === undefined
          ? {}
          : { windowsProfile: prepared.windowsProfile }),
        workspace,
      }),
      platform,
    );
  await runAdversarialContainmentProbe(createLauncher, workspace);
  const client = createEffectSidecarClient(createLauncher([]));
  const request = parseSidecarSessionRequest({
    jobId: "job-packaged-proof",
    manifestHash: containedRuntime.manifestHash,
    nonce: "nonce-packaged-proof",
    requestId: "request-packaged-proof",
    timeoutMs: 15_000,
  });
  try {
    const result = await client.runSession(request);
    if (
      result.artifact.path !== "artifacts/decode-manifest.json" ||
      result.jobId !== request.jobId ||
      result.requestId !== request.requestId
    ) {
      throw new Error("Packaged sidecar lifecycle proof returned an unexpected descriptor");
    }
    const decodeManifestBytes = readFileSync(join(workspace, result.artifact.path));
    if (
      decodeManifestBytes.byteLength !== result.artifact.byteSize ||
      createHash("sha256").update(decodeManifestBytes).digest("hex") !== result.artifact.sha256
    ) {
      throw new Error("Packaged sidecar lifecycle proof returned an invalid descriptor hash");
    }
    const decodeManifest = z
      .object({ canonicalAudio: z.object({ sampleCount: z.literal(4_800) }) })
      .parse(JSON.parse(decodeManifestBytes.toString("utf8")));
    if (decodeManifest.canonicalAudio.sampleCount !== 4_800) {
      throw new Error("Packaged sidecar lifecycle proof returned unexpected evidence");
    }
  } finally {
    try {
      await client.dispose();
    } finally {
      prepared.cleanup();
    }
  }
}

async function runAdversarialContainmentProbe(
  createLauncher: (args: readonly string[]) => ReturnType<typeof createNativeContainmentLauncher>,
  workspace: string,
): Promise<void> {
  const sentinelRoot = mkdtempSync(join(homedir(), ".open-chords-containment-proof-"));
  const sentinel = join(sentinelRoot, "canonical-private-data");
  writeFileSync(sentinel, "private");
  const server = createServer((socket) => socket.destroy());
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Loopback probe did not bind");
  const plan = join(workspace, "containment-probe.json");
  writeFileSync(plan, JSON.stringify({ loopbackPort: address.port, sentinelPath: sentinel }));
  const request = parseSidecarSessionRequest({
    jobId: "job-containment-probe",
    manifestHash: "0".repeat(64),
    nonce: "nonce-containment-probe",
    requestId: "request-containment-probe",
    timeoutMs: 15_000,
  });
  let process: Awaited<ReturnType<ReturnType<typeof createLauncher>["launch"]>> | undefined;
  try {
    process = await createLauncher([`--containment-probe=${plan}`]).launch(
      request,
      AbortSignal.timeout(15_000),
    );
    let output = Buffer.alloc(0);
    for await (const chunk of process.stdout) {
      output = Buffer.concat([output, chunk]);
      if (output.byteLength > 64 * 1024) throw new Error("Containment probe output is oversized");
    }
    z.object({
      controlHandleClosed: z.literal(true),
      environmentIsolated: z.literal(true),
      linkEscapeBlocked: z.literal(true),
      networkBlocked: z.literal(true),
      packagedHelperRan: z.literal(true),
      pathBlocked: z.literal(true),
      shellEscapeBlocked: z.literal(true),
    }).parse(JSON.parse(output.toString("utf8")));
  } finally {
    await process?.stop("completed");
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    rmSync(sentinelRoot, { force: true, recursive: true });
  }
}

function prepareWorkspace(
  platform: "darwin" | "win32",
  helperPath: string,
  packagedRuntimeRoot: string,
): { cleanup(): void; runtimeRoot: string; windowsProfile?: string; workspace: string } {
  const identifier = randomUUID();
  if (platform === "darwin") {
    const workspace = join(
      homedir(),
      "Library",
      "Containers",
      "io.github.qisoft.open-chords.analysis-service",
      "Data",
      "jobs",
      identifier,
    );
    mkdirSync(workspace, { recursive: true, mode: 0o700 });
    return {
      cleanup: () => rmSync(workspace, { force: true, recursive: true }),
      runtimeRoot: packagedRuntimeRoot,
      workspace,
    };
  }
  const profile = `OpenChords.Analysis.${identifier}`;
  const profileRoot = execFileSync(helperPath, [`--prepare=${profile}`], {
    encoding: "utf8",
    env: {},
    windowsHide: true,
  }).trim();
  if (!isAbsolute(profileRoot)) throw new Error("AppContainer profile returned an invalid path");
  const runtimeRoot = join(profileRoot, "runtime");
  const workspace = join(profileRoot, "jobs", identifier);
  try {
    cpSync(packagedRuntimeRoot, runtimeRoot, { recursive: true });
    mkdirSync(workspace, { recursive: true });
  } catch (cause) {
    execFileSync(helperPath, [`--destroy=${profile}`], { env: {}, windowsHide: true });
    throw cause;
  }
  return {
    cleanup() {
      execFileSync(helperPath, [`--destroy=${profile}`], { env: {}, windowsHide: true });
      rmSync(profileRoot, { force: true, recursive: true });
    },
    runtimeRoot,
    windowsProfile: profile,
    workspace,
  };
}

function canonicalWavFixture(): Buffer {
  const sampleCount = 4_800;
  const result = Buffer.alloc(44 + sampleCount * 2);
  result.write("RIFF", 0, "ascii");
  result.writeUInt32LE(result.byteLength - 8, 4);
  result.write("WAVEfmt ", 8, "ascii");
  result.writeUInt32LE(16, 16);
  result.writeUInt16LE(1, 20);
  result.writeUInt16LE(1, 22);
  result.writeUInt32LE(48_000, 24);
  result.writeUInt32LE(96_000, 28);
  result.writeUInt16LE(2, 32);
  result.writeUInt16LE(16, 34);
  result.write("data", 36, "ascii");
  result.writeUInt32LE(sampleCount * 2, 40);
  for (let index = 0; index < sampleCount; index += 1) {
    result.writeInt16LE(Math.round(Math.sin(index / 13) * 4_000), 44 + index * 2);
  }
  return result;
}

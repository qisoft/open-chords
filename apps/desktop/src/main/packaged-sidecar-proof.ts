import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { z } from "zod";

import { EXPECTED_CONTAINMENT_MANIFEST_SHA256 } from "./containment-build-metadata.ts";
import { EXPECTED_SIDECAR_MANIFEST_SHA256 } from "./sidecar-build-metadata.ts";
import { verifyContainmentRuntime } from "./sidecar-containment-integrity.ts";
import { createNativeContainmentLauncher } from "./sidecar-containment-launcher.ts";
import { createExecutableNativeContainmentBroker } from "./sidecar-native-broker.ts";
import { verifyPackagedSidecarRuntime } from "./sidecar-runtime-integrity.ts";
import { createEffectSidecarClient, parseSidecarSessionRequest } from "./sidecar-session.ts";
import { isExpectedWindowsProfileRoot } from "./windows-app-container-path.ts";

const SensitiveSurfacesSchema = z.object({
  browserState: z.boolean(),
  credentials: z.boolean(),
  modelStore: z.boolean(),
  projectLibrary: z.boolean(),
  source: z.boolean(),
});

const PACKAGED_PROOF_FAILURE_CODES = [
  "adversarial_probe_failed",
  "adversarial_environment_failed",
  "adversarial_helper_failed",
  "adversarial_link_failed",
  "adversarial_network_failed",
  "adversarial_path_failed",
  "adversarial_process_failed",
  "adversarial_protocol_failed",
  "adversarial_shell_failed",
  "cancel_probe_failed",
  "cleanup_failed",
  "crash_probe_failed",
  "proof_and_cleanup_failed",
  "session_probe_failed",
  "setup_failed",
] as const;
type PackagedProofFailureCode = (typeof PACKAGED_PROOF_FAILURE_CODES)[number];

class PackagedProofFailure extends Error {
  readonly code: PackagedProofFailureCode;

  constructor(code: PackagedProofFailureCode) {
    super(code);
    this.name = "PackagedProofFailure";
    this.code = code;
  }
}

export function packagedProofFailureCode(cause: unknown): string {
  if (cause instanceof PackagedProofFailure) return cause.code;
  if (cause instanceof AggregateError) {
    const codes = cause.errors.map(packagedProofFailureCode);
    if (codes.includes("cleanup_failed") && codes.some((code) => code !== "cleanup_failed")) {
      return "proof_and_cleanup_failed";
    }
    return codes.find((code) => code !== "proof_failed") ?? "proof_failed";
  }
  return "proof_failed";
}

export async function runPackagedSidecarProof(): Promise<void> {
  try {
    await runPackagedSidecarProofInternal();
  } catch (cause) {
    if (packagedProofFailureCode(cause) !== "proof_failed") throw cause;
    throw new PackagedProofFailure("setup_failed");
  }
}

async function runPackagedSidecarProofInternal(): Promise<void> {
  if (process.platform !== "darwin" && process.platform !== "win32") {
    throw new Error("Packaged containment proof targets macOS and Windows only");
  }
  const platform = process.platform;
  const verifiedRuntime = verifyPackagedSidecarRuntime(
    platform === "darwin"
      ? join(
          process.resourcesPath,
          "..",
          "XPCServices",
          "OpenChordsAnalysisService.xpc",
          "Contents",
          "Resources",
          "open-chords-analysis",
        )
      : join(process.resourcesPath, "open-chords-analysis"),
    EXPECTED_SIDECAR_MANIFEST_SHA256,
  );
  const containment = verifyContainmentRuntime(
    join(
      process.resourcesPath,
      platform === "darwin" ? join("..", "MacOS", "containment") : "containment",
    ),
    EXPECTED_CONTAINMENT_MANIFEST_SHA256,
    platform,
    platform === "darwin"
      ? join(process.resourcesPath, "..", "MacOS", "open-chords-containment-bridge")
      : undefined,
  );
  const prepared = prepareWorkspace(platform, containment.helperPath, verifiedRuntime.runtimeRoot);
  let proofFailure: { cause: unknown } | undefined;
  let stage: PackagedProofFailureCode = "setup_failed";
  try {
    const containedRuntime = verifyPackagedSidecarRuntime(
      prepared.runtimeRoot,
      EXPECTED_SIDECAR_MANIFEST_SHA256,
    );
    const workspace = prepared.workspace;
    mkdirSync(join(workspace, "tmp"), { recursive: true, mode: 0o700 });
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
    stage = "adversarial_probe_failed";
    await runAdversarialContainmentProbe(createLauncher, workspace, platform);
    stage = "cancel_probe_failed";
    await runLifecycleContainmentProbe(createLauncher, workspace, "cancel");
    stage = "crash_probe_failed";
    await runLifecycleContainmentProbe(createLauncher, workspace, "crash");
    stage = "session_probe_failed";
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
      await client.dispose();
    }
  } catch (cause) {
    proofFailure = {
      cause:
        packagedProofFailureCode(cause) === "proof_failed"
          ? new PackagedProofFailure(stage)
          : cause,
    };
  }
  const cleanupFailures: unknown[] = [];
  try {
    prepared.cleanup();
  } catch {
    cleanupFailures.push(new PackagedProofFailure("cleanup_failed"));
  }
  throwCombinedFailures(
    "Packaged containment proof and cleanup failed",
    proofFailure,
    cleanupFailures,
  );
}

async function runAdversarialContainmentProbe(
  createLauncher: (args: readonly string[]) => ReturnType<typeof createNativeContainmentLauncher>,
  workspace: string,
  platform: "darwin" | "win32",
): Promise<void> {
  const sentinels = createSensitiveSentinels(platform);
  const server = createServer((socket) => socket.destroy());
  let process: Awaited<ReturnType<ReturnType<typeof createLauncher>["launch"]>> | undefined;
  let proofFailure: { cause: unknown } | undefined;
  try {
    await new Promise<void>((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolveListen);
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Loopback probe did not bind");
    }
    const plan = join(workspace, "containment-probe.json");
    writeFileSync(
      plan,
      JSON.stringify({
        loopbackPort: address.port,
        sensitivePaths: sentinels.paths,
      }),
    );
    const request = parseSidecarSessionRequest({
      jobId: "job-containment-probe",
      manifestHash: "0".repeat(64),
      nonce: "nonce-containment-probe",
      requestId: "request-containment-probe",
      timeoutMs: 15_000,
    });
    process = await createLauncher([`--containment-probe=${plan}`]).launch(
      request,
      AbortSignal.timeout(15_000),
    );
    let output = Buffer.alloc(0);
    for await (const chunk of process.stdout) {
      output = Buffer.concat([output, chunk]);
      if (output.byteLength > 64 * 1024) throw new Error("Containment probe output is oversized");
    }
    const evidence = z
      .object({
        controlHandleClosed: z.boolean(),
        environmentIsolated: z.boolean(),
        environmentRedirected: z.boolean(),
        linkEscapeBlocked: z.boolean(),
        networkBlocked: z.boolean(),
        packagedHelperRan: z.boolean(),
        pathBlocked: z.boolean(),
        processEscapeBlocked: z.boolean(),
        sensitiveLinkEscapesBlocked: SensitiveSurfacesSchema,
        sensitivePathsBlocked: SensitiveSurfacesSchema,
        sensitiveShellEscapesBlocked: SensitiveSurfacesSchema,
        shellEscapeBlocked: z.boolean(),
      })
      .parse(JSON.parse(output.toString("utf8")));
    requireAdversarial(evidence.controlHandleClosed, "adversarial_protocol_failed");
    requireAdversarial(
      evidence.environmentIsolated && evidence.environmentRedirected,
      "adversarial_environment_failed",
    );
    requireAdversarial(evidence.packagedHelperRan, "adversarial_helper_failed");
    requireAdversarial(evidence.networkBlocked, "adversarial_network_failed");
    requireAdversarial(evidence.processEscapeBlocked, "adversarial_process_failed");
    requireAdversarial(
      evidence.pathBlocked && Object.values(evidence.sensitivePathsBlocked).every(Boolean),
      "adversarial_path_failed",
    );
    requireAdversarial(
      evidence.linkEscapeBlocked &&
        Object.values(evidence.sensitiveLinkEscapesBlocked).every(Boolean),
      "adversarial_link_failed",
    );
    requireAdversarial(
      evidence.shellEscapeBlocked &&
        Object.values(evidence.sensitiveShellEscapesBlocked).every(Boolean),
      "adversarial_shell_failed",
    );
  } catch (cause) {
    proofFailure = { cause };
  }
  const cleanupErrors: unknown[] = [];
  try {
    await process?.stop("completed");
  } catch (cause) {
    cleanupErrors.push(cause);
  }
  if (server.listening) {
    try {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    } catch (cause) {
      cleanupErrors.push(cause);
    }
  }
  try {
    sentinels.cleanup();
  } catch (cause) {
    cleanupErrors.push(cause);
  }
  throwCombinedFailures(
    "Packaged containment proof and cleanup failed",
    proofFailure,
    privateCleanupFailures(cleanupErrors),
  );
}

function requireAdversarial(condition: boolean, code: PackagedProofFailureCode): void {
  if (!condition) throw new PackagedProofFailure(code);
}

const LifecycleEvidenceSchema = z.object({
  descendantPid: z.number().int().positive(),
  parentPid: z.number().int().positive(),
  partialPath: z.string(),
});

async function runLifecycleContainmentProbe(
  createLauncher: (args: readonly string[]) => ReturnType<typeof createNativeContainmentLauncher>,
  workspace: string,
  mode: "cancel" | "crash",
): Promise<void> {
  const partialPath = join(workspace, "artifacts", `${mode}.json.partial`);
  const publishablePath = join(workspace, "artifacts", `${mode}.json`);
  const plan = join(workspace, `containment-lifecycle-${mode}.json`);
  writeFileSync(plan, JSON.stringify({ mode, partialPath }));
  const request = parseSidecarSessionRequest({
    jobId: `job-containment-${mode}`,
    manifestHash: "0".repeat(64),
    nonce: `nonce-containment-${mode}`,
    requestId: `request-containment-${mode}`,
    timeoutMs: 15_000,
  });
  const process = await createLauncher([`--containment-lifecycle-probe=${plan}`]).launch(
    request,
    AbortSignal.timeout(15_000),
  );
  let primaryFailure: { cause: unknown } | undefined;
  let evidence: z.infer<typeof LifecycleEvidenceSchema> | undefined;
  const iterator = process.stdout[Symbol.asyncIterator]();
  try {
    evidence = LifecycleEvidenceSchema.parse(JSON.parse(await readBoundedLine(iterator)));
    if (evidence.partialPath !== partialPath || !existsSync(partialPath)) {
      throw new Error(`Contained ${mode} probe did not stage its partial output`);
    }
    if (mode === "crash") await drainOutput(iterator);
  } catch (cause) {
    primaryFailure = { cause };
  }
  const cleanupFailures: unknown[] = [];
  try {
    await process.stop(mode === "cancel" ? "cancelled" : "completed");
  } catch (cause) {
    cleanupFailures.push(cause);
  }
  throwCombinedFailures(
    `Contained ${mode} proof and cleanup failed`,
    primaryFailure,
    privateCleanupFailures(cleanupFailures),
  );
  if (evidence === undefined) {
    throw new Error(`Contained ${mode} probe returned no evidence`);
  }
  try {
    await assertProcessesExited([evidence.parentPid, evidence.descendantPid]);
    if (existsSync(publishablePath)) {
      throw new Error(`Contained ${mode} probe left publishable output`);
    }
    rmSync(partialPath, { force: true });
  } catch {
    throw new PackagedProofFailure("cleanup_failed");
  }
}

async function readBoundedLine(iterator: AsyncIterator<Uint8Array>): Promise<string> {
  let buffered = Buffer.alloc(0);
  while (true) {
    const next = await withTimeout(
      iterator.next(),
      5_000,
      "Containment lifecycle evidence timed out",
    );
    if (next.done) throw new Error("Containment lifecycle evidence is missing");
    buffered = Buffer.concat([buffered, Buffer.from(next.value)]);
    if (buffered.byteLength > 4 * 1024) {
      throw new Error("Containment lifecycle evidence is oversized");
    }
    const newline = buffered.indexOf(0x0a);
    if (newline >= 0) return buffered.subarray(0, newline).toString("utf8");
  }
}

async function drainOutput(iterator: AsyncIterator<Uint8Array>): Promise<void> {
  while (true) {
    const next = await withTimeout(iterator.next(), 10_000, "Contained crash probe did not exit");
    if (next.done) return;
  }
}

async function withTimeout<T>(
  promise: PromiseLike<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}

async function assertProcessesExited(processIds: readonly number[]): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (processIds.some(isProcessAlive)) {
    if (Date.now() >= deadline) {
      throw new Error("Contained process domain left a survivor");
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
}

function isProcessAlive(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (cause) {
    return !(cause instanceof Error && Reflect.get(cause, "code") === "ESRCH");
  }
}

function createSensitiveSentinels(platform: "darwin" | "win32"): {
  cleanup(): void;
  paths: Record<keyof z.infer<typeof SensitiveSurfacesSchema>, string>;
} {
  const home = homedir();
  const applicationSupport =
    platform === "win32"
      ? join(home, "AppData", "Roaming")
      : join(home, "Library", "Application Support");
  const browserSupport =
    platform === "win32"
      ? join(home, "AppData", "Local")
      : join(home, "Library", "Application Support");
  const identifier = randomUUID();
  const roots = {
    browserState: join(browserSupport, "Google", "Chrome", "User Data", "Default", identifier),
    credentials: join(home, ".config", "open-chords", identifier),
    modelStore: join(applicationSupport, "Open Chords", "Model Store", identifier),
    projectLibrary: join(applicationSupport, "Open Chords", "Project Library", identifier),
    source: join(home, "Music", "Open Chords Containment Proof", identifier),
  };
  const createSentinel = (root: string) => {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const path = join(root, "canonical-private-data");
    writeFileSync(path, "private");
    return path;
  };
  let paths: Record<keyof typeof roots, string>;
  try {
    paths = {
      browserState: createSentinel(roots.browserState),
      credentials: createSentinel(roots.credentials),
      modelStore: createSentinel(roots.modelStore),
      projectLibrary: createSentinel(roots.projectLibrary),
      source: createSentinel(roots.source),
    };
  } catch (cause) {
    for (const root of Object.values(roots)) {
      rmSync(root, { force: true, recursive: true });
    }
    throw cause;
  }
  return {
    cleanup() {
      for (const root of Object.values(roots)) {
        rmSync(root, { force: true, recursive: true });
      }
    },
    paths,
  };
}

function throwCombinedFailures(
  message: string,
  primaryFailure: { cause: unknown } | undefined,
  cleanupFailures: readonly unknown[],
): void {
  const failures = [
    ...(primaryFailure === undefined ? [] : [primaryFailure.cause]),
    ...cleanupFailures,
  ];
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, message);
}

function prepareWorkspace(
  platform: "darwin" | "win32",
  helperPath: string,
  packagedRuntimeRoot: string,
): {
  cleanup(): void;
  runtimeRoot: string;
  windowsProfile?: string;
  workspace: string;
} {
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
  let reportedProfileRoot: string;
  try {
    reportedProfileRoot = execFileSync(helperPath, [`--prepare=${profile}`], {
      encoding: "utf8",
      env: {},
      windowsHide: true,
    }).trim();
  } catch {
    throwCombinedFailures(
      "AppContainer profile preparation and cleanup failed",
      { cause: new PackagedProofFailure("setup_failed") },
      privateCleanupFailures(destroyWindowsProfile(helperPath, profile)),
    );
    throw new PackagedProofFailure("setup_failed");
  }
  const profileRoot = canonicalWindowsProfileRoot(reportedProfileRoot);
  if (profileRoot === null) {
    throwCombinedFailures(
      "AppContainer profile validation and cleanup failed",
      { cause: new PackagedProofFailure("setup_failed") },
      privateCleanupFailures(destroyWindowsProfile(helperPath, profile)),
    );
    throw new PackagedProofFailure("setup_failed");
  }
  const runtimeRoot = join(profileRoot, "runtime");
  const workspace = join(profileRoot, "jobs", identifier);
  try {
    cpSync(packagedRuntimeRoot, runtimeRoot, { recursive: true });
    mkdirSync(workspace, { recursive: true });
  } catch {
    throwCombinedFailures(
      "AppContainer workspace setup and cleanup failed",
      { cause: new PackagedProofFailure("setup_failed") },
      privateCleanupFailures(cleanupWindowsProfile(helperPath, profile, profileRoot)),
    );
  }
  return {
    cleanup() {
      throwCombinedFailures(
        "AppContainer profile cleanup failed",
        undefined,
        cleanupWindowsProfile(helperPath, profile, profileRoot),
      );
    },
    runtimeRoot,
    windowsProfile: profile,
    workspace,
  };
}

function canonicalWindowsProfileRoot(reportedRoot: string): string | null {
  try {
    const packagesRoot = realpathSync(join(homedir(), "AppData", "Local", "Packages"));
    const profileRoot = realpathSync(reportedRoot);
    return isExpectedWindowsProfileRoot(profileRoot, packagesRoot) ? profileRoot : null;
  } catch {
    return null;
  }
}

function cleanupWindowsProfile(
  helperPath: string,
  profile: string,
  profileRoot: string,
): unknown[] {
  const failures = destroyWindowsProfile(helperPath, profile);
  try {
    rmSync(profileRoot, { force: true, recursive: true });
  } catch (cause) {
    failures.push(cause);
  }
  return failures;
}

function privateCleanupFailures(failures: readonly unknown[]): PackagedProofFailure[] {
  return failures.map(() => new PackagedProofFailure("cleanup_failed"));
}

function destroyWindowsProfile(helperPath: string, profile: string): unknown[] {
  const failures: unknown[] = [];
  try {
    execFileSync(helperPath, [`--destroy=${profile}`], {
      env: {},
      windowsHide: true,
    });
  } catch (cause) {
    failures.push(cause);
  }
  return failures;
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

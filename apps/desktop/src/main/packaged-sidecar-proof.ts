import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import { z } from "zod";

import { EXPECTED_CONTAINMENT_MANIFEST_SHA256 } from "./containment-build-metadata.ts";
import { throwCombinedFailures } from "./packaged-sidecar-proof-failures.ts";
import {
  packagedWorkspaceFailureCode,
  preparePackagedWorkspace,
} from "./packaged-sidecar-proof-workspace.ts";
import { EXPECTED_SIDECAR_MANIFEST_SHA256 } from "./sidecar-build-metadata.ts";
import { verifyContainmentRuntime } from "./sidecar-containment-integrity.ts";
import { createNativeContainmentLauncher } from "./sidecar-containment-launcher.ts";
import { createExecutableNativeContainmentBroker } from "./sidecar-native-broker.ts";
import { verifyPackagedSidecarRuntime } from "./sidecar-runtime-integrity.ts";
import {
  createEffectSidecarClient,
  parseSidecarSessionRequest,
  SidecarSessionError,
  type SidecarSessionErrorCode,
} from "./sidecar-session.ts";

const SensitiveSurfacesSchema = z.object({
  browserState: z.boolean(),
  credentials: z.boolean(),
  modelStore: z.boolean(),
  projectLibrary: z.boolean(),
  source: z.boolean(),
});

const PACKAGED_PROOF_FAILURE_CODES = [
  "adversarial_probe_failed",
  "adversarial_evidence_invalid",
  "adversarial_environment_isolation_failed",
  "adversarial_environment_redirect_appdata_failed",
  "adversarial_environment_redirect_home_failed",
  "adversarial_environment_redirect_localappdata_failed",
  "adversarial_environment_redirect_temp_failed",
  "adversarial_environment_redirect_tmp_failed",
  "adversarial_environment_redirect_tmpdir_failed",
  "adversarial_environment_redirect_userprofile_failed",
  "adversarial_helper_missing",
  "adversarial_helper_nonzero",
  "adversarial_helper_os_error",
  "adversarial_helper_permission_denied",
  "adversarial_helper_permission_denied_child",
  "adversarial_helper_permission_denied_child_image",
  "adversarial_helper_permission_denied_child_policy",
  "adversarial_helper_permission_denied_image",
  "adversarial_helper_permission_denied_probe",
  "adversarial_helper_permission_denied_unreadable",
  "adversarial_helper_timeout",
  "adversarial_link_failed",
  "adversarial_launch_failed",
  "adversarial_network_failed",
  "adversarial_output_failed",
  "adversarial_output_invalid",
  "adversarial_path_failed",
  "adversarial_process_failed",
  "adversarial_runtime_mutation_failed",
  "adversarial_protocol_failed",
  "adversarial_probe_file_missing",
  "adversarial_probe_invalid_plan",
  "adversarial_probe_os_error",
  "adversarial_probe_permission_denied",
  "adversarial_probe_runtime_error",
  "adversarial_shell_failed",
  "cancel_probe_failed",
  "cleanup_failed",
  "crash_probe_failed",
  "proof_and_cleanup_failed",
  "session_artifact_failed",
  "session_descriptor_failed",
  "session_evidence_failed",
  "session_probe_failed",
  "setup_failed",
  "setup_prepare_failed",
  "setup_response_failed",
  "setup_validation_failed",
  "setup_workspace_failed",
] as const;
const SESSION_REMOTE_FAILURE_CODES = [
  "analysis_failed",
  "canonical_artifact_validation_failed",
  "canonical_cleanup_failed",
  "canonical_decode_failed",
  "canonical_prepare_failed",
  "canonical_prepare_artifacts_failed",
  "canonical_prepare_input_failed",
  "canonical_prepare_tools_failed",
  "canonical_prepare_workspace_failed",
  "canonical_probe_execution_failed",
  "canonical_probe_exit_failed",
  "canonical_probe_loader_init_failed",
  "canonical_probe_loader_invalid_image",
  "canonical_probe_loader_missing",
  "canonical_probe_loader_symbol_missing",
  "canonical_probe_output_failed",
  "canonical_probe_output_limit_failed",
  "canonical_probe_process_cleanup_failed",
  "canonical_probe_process_failed",
  "canonical_probe_runtime_failed",
  "canonical_probe_spawn_failed",
  "canonical_probe_stream_missing",
  "canonical_probe_timeout_failed",
  "canonical_publication_failed",
  "canonical_tool_identity_failed",
  "canonical_transcode_failed",
] as const;
const SIDECAR_PROCESS_FAILURE_CODES = [
  "sidecar_broken_pipe",
  "sidecar_file_not_found",
  "sidecar_internal_error",
  "sidecar_os_error",
  "sidecar_protocol_error",
  "sidecar_runtime_entry_content_permission_denied",
  "sidecar_runtime_entry_metadata_permission_denied",
  "sidecar_runtime_file_permission_denied",
  "sidecar_runtime_inventory_permission_denied",
  "sidecar_runtime_manifest_permission_denied",
  "sidecar_runtime_root_permission_denied",
  "sidecar_runtime_error",
  "sidecar_runtime_tool_permission_denied",
  "sidecar_session_permission_denied",
  "sidecar_value_error",
] as const;
type SessionRemoteFailureCode = (typeof SESSION_REMOTE_FAILURE_CODES)[number];
const SessionRemoteFailureCodeSchema = z.enum(SESSION_REMOTE_FAILURE_CODES);
type SidecarProcessFailureCode = (typeof SIDECAR_PROCESS_FAILURE_CODES)[number];
const SidecarProcessFailureCodeSchema = z.enum(SIDECAR_PROCESS_FAILURE_CODES);
type PackagedProofFailureCode =
  | (typeof PACKAGED_PROOF_FAILURE_CODES)[number]
  | `adversarial_containment_setup_failed_${string}`
  | `session_${SidecarSessionErrorCode}`
  | `session_${SessionRemoteFailureCode}`
  | `session_${SidecarProcessFailureCode}`;

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
  const workspaceFailureCode = packagedWorkspaceFailureCode(cause);
  if (workspaceFailureCode !== undefined) return workspaceFailureCode;
  if (cause instanceof AggregateError) {
    const codes = cause.errors.map(packagedProofFailureCode);
    const hasCleanupFailure = codes.some(
      (code) => code === "cleanup_failed" || code === "session_cleanup_failure",
    );
    if (
      hasCleanupFailure &&
      codes.some((code) => code !== "cleanup_failed" && code !== "session_cleanup_failure")
    ) {
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
  const prepared = preparePackagedWorkspace(
    platform,
    containment.helperPath,
    verifiedRuntime.runtimeRoot,
  );
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
    writeFileSync(
      join(workspace, "input", "analysis-recipe.json"),
      JSON.stringify(packagedAnalysisRecipe()),
    );
    const createLauncher = (args: readonly string[], acceptedExitCodes: readonly number[] = [0]) =>
      createNativeContainmentLauncher(
        createExecutableNativeContainmentBroker({
          acceptedExitCodes,
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
    const candidates: Buffer[] = [];
    for (const temperature of ["cold", "warm"] as const) {
      process.stderr.write(`Packaged sidecar proof stage: analysis_${temperature}_started\n`);
      const client = createEffectSidecarClient(createLauncher([]));
      const request = parseSidecarSessionRequest({
        jobId: `job-packaged-proof-${temperature}`,
        manifestHash: containedRuntime.manifestHash,
        nonce: `nonce-packaged-proof-${temperature}`,
        requestId: `request-packaged-proof-${temperature}`,
        timeoutMs: 120_000,
      });
      await runWithPackagedSessionCleanup(
        async () => {
          const result = await client.runSession(request);
          stage = "session_descriptor_failed";
          if (
            result.artifact.path !== "artifacts/analysis-result.json" ||
            result.jobId !== request.jobId ||
            result.requestId !== request.requestId
          ) {
            throw new Error("Packaged sidecar lifecycle proof returned an unexpected descriptor");
          }
          stage = "session_artifact_failed";
          const candidateBytes = readFileSync(join(workspace, result.artifact.path));
          if (
            candidateBytes.byteLength !== result.artifact.byteSize ||
            createHash("sha256").update(candidateBytes).digest("hex") !== result.artifact.sha256
          ) {
            throw new Error("Packaged sidecar lifecycle proof returned an invalid descriptor hash");
          }
          stage = "session_evidence_failed";
          const candidate = z
            .strictObject({
              durationSamples: z.literal(4_800),
              recipe: z.unknown(),
              sampleRate: z.literal(48_000),
              stageOutcomes: z.array(z.object({ stage: z.string(), state: z.string() })),
              supportClaimIds: z.array(z.string()).length(0),
              timeline: z.object({
                chordEvents: z.array(z.unknown()).min(1),
                keyRegions: z.array(z.unknown()).min(1),
                sectionRegions: z.array(z.unknown()).min(1),
              }),
              warnings: z.array(z.string()),
            })
            .parse(JSON.parse(candidateBytes.toString("utf8")));
          if (candidate.stageOutcomes.at(-1)?.stage !== "assemble") {
            throw new Error(
              "Packaged sidecar lifecycle proof returned incomplete analysis evidence",
            );
          }
          candidates.push(candidateBytes);
        },
        () => client.dispose(),
      );
      process.stderr.write(`Packaged sidecar proof stage: analysis_${temperature}_completed\n`);
    }
    if (candidates.length !== 2 || !candidates[0]!.equals(candidates[1]!)) {
      throw new Error("Packaged cold and warm analysis candidates are not deterministic");
    }
  } catch (cause) {
    proofFailure = {
      cause:
        packagedProofFailureCode(cause) === "proof_failed"
          ? new PackagedProofFailure(sessionFailureCode(stage, cause))
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

function packagedAnalysisRecipe() {
  return {
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
      id: "fast",
      name: "fast",
      version: "1.0.0",
    },
    seeds: { decoder: 0 },
    settings: {
      analysisWindowSamples: 96_000,
      hopLength: 1_024,
      nFft: 8_192,
    },
  };
}

export async function runWithPackagedSessionCleanup(
  run: () => Promise<void>,
  dispose: () => Promise<void>,
): Promise<void> {
  let primaryFailure: { cause: unknown } | undefined;
  try {
    await run();
  } catch (cause) {
    primaryFailure = { cause };
  }
  const cleanupFailures: unknown[] = [];
  try {
    await dispose();
  } catch (cause) {
    cleanupFailures.push(
      new PackagedProofFailure(
        cause instanceof SidecarSessionError ? `session_${cause.code}` : "session_cleanup_failure",
      ),
    );
  }
  throwCombinedFailures(
    "Packaged session proof and cleanup failed",
    primaryFailure,
    cleanupFailures,
  );
}

export function sessionFailureCode(
  stage: PackagedProofFailureCode,
  cause: unknown,
): PackagedProofFailureCode {
  const remoteFailureCode =
    cause instanceof SidecarSessionError
      ? SessionRemoteFailureCodeSchema.safeParse(cause.remoteCode)
      : undefined;
  const processFailureCode =
    cause instanceof SidecarSessionError
      ? SidecarProcessFailureCodeSchema.safeParse(cause.remoteCode)
      : undefined;
  if (
    stage === "adversarial_launch_failed" &&
    cause instanceof SidecarSessionError &&
    cause.code === "launch_failure" &&
    isNativeContainmentFailureCode(cause.remoteCode)
  ) {
    return `adversarial_${cause.remoteCode}`;
  }
  if (
    stage === "session_probe_failed" &&
    cause instanceof SidecarSessionError &&
    cause.code === "remote_failure"
  ) {
    return remoteFailureCode?.success === true
      ? `session_${remoteFailureCode.data}`
      : "session_remote_failure";
  }
  if (
    cause instanceof SidecarSessionError &&
    cause.code === "process_failure" &&
    processFailureCode?.success === true
  ) {
    return `session_${processFailureCode.data}`;
  }
  if (cause instanceof SidecarSessionError && cause.code === "process_failure") {
    return "session_process_failure";
  }
  if (stage === "session_probe_failed" && cause instanceof SidecarSessionError) {
    return `session_${cause.code}`;
  }
  return stage;
}

function isNativeContainmentFailureCode(
  value: string | undefined,
): value is `containment_setup_failed_${string}` {
  return (
    value !== undefined &&
    value.length <= 128 &&
    /^containment_setup_failed_[a-z0-9_-]+$/u.test(value)
  );
}

async function runAdversarialContainmentProbe(
  createLauncher: (args: readonly string[]) => ReturnType<typeof createNativeContainmentLauncher>,
  workspace: string,
  platform: "darwin" | "win32",
): Promise<void> {
  const sentinels = createSensitiveSentinels(platform);
  const sensitiveLinkRoots = Object.fromEntries(
    Object.keys(sentinels.paths).map((name) => [
      name,
      join(workspace, `containment-link-probe-${name}`),
    ]),
  );
  const sensitiveLinkPaths = Object.fromEntries(
    Object.entries(sentinels.paths).map(([name, target]) => [
      name,
      join(sensitiveLinkRoots[name]!, basename(target)),
    ]),
  );
  const server = createServer((socket) => socket.destroy());
  let process: Awaited<ReturnType<ReturnType<typeof createLauncher>["launch"]>> | undefined;
  let proofFailure: { cause: unknown } | undefined;
  let stage: PackagedProofFailureCode = "adversarial_probe_failed";
  try {
    await new Promise<void>((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolveListen);
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Loopback probe did not bind");
    }
    const request = parseSidecarSessionRequest({
      jobId: "job-containment-probe",
      manifestHash: "0".repeat(64),
      nonce: "nonce-containment-probe",
      requestId: "request-containment-probe",
      timeoutMs: 15_000,
    });
    let linkEscapePreflightBlocked = false;
    if (platform === "win32") {
      const linkRoot = sensitiveLinkRoots.source!;
      symlinkSync(dirname(sentinels.paths.source), linkRoot, "junction");
      let escapedProcess:
        | Awaited<ReturnType<ReturnType<typeof createLauncher>["launch"]>>
        | undefined;
      try {
        escapedProcess = await createLauncher([]).launch(request, AbortSignal.timeout(15_000));
      } catch (cause) {
        if (
          cause instanceof SidecarSessionError &&
          cause.code === "launch_failure" &&
          cause.message ===
            "Native containment rejected launch: containment_setup_failed_reparse_entry"
        ) {
          linkEscapePreflightBlocked = true;
        } else {
          throw cause;
        }
      }
      if (escapedProcess !== undefined) {
        try {
          await escapedProcess.stop("launch_failure");
        } catch {
          throwCombinedFailures(
            "Reparse escape proof and cleanup failed",
            { cause: new PackagedProofFailure("adversarial_link_failed") },
            [new PackagedProofFailure("cleanup_failed")],
          );
        }
      }
      try {
        unlinkSync(linkRoot);
      } catch {
        throw new PackagedProofFailure("cleanup_failed");
      }
      requireAdversarial(linkEscapePreflightBlocked, "adversarial_link_failed");
    } else {
      for (const [name, target] of Object.entries(sentinels.paths)) {
        symlinkSync(dirname(target), sensitiveLinkRoots[name]!, "dir");
      }
    }
    const plan = join(workspace, "containment-probe.json");
    writeFileSync(
      plan,
      JSON.stringify({
        linkEscapePreflightBlocked,
        loopbackPort: address.port,
        sensitiveLinkPaths,
        sensitivePaths: sentinels.paths,
      }),
    );
    stage = "adversarial_launch_failed";
    process = await createLauncher([`--containment-probe=${plan}`]).launch(
      request,
      AbortSignal.timeout(15_000),
    );
    stage = "adversarial_output_failed";
    let output = Buffer.alloc(0);
    for await (const chunk of process.stdout) {
      output = Buffer.concat([output, chunk]);
      if (output.byteLength > 64 * 1024) throw new Error("Containment probe output is oversized");
    }
    stage = "adversarial_output_invalid";
    const rawEvidence: unknown = JSON.parse(output.toString("utf8"));
    const probeError = z
      .object({
        probeError: z.enum([
          "file_missing",
          "invalid_plan",
          "os_error",
          "permission_denied",
          "runtime_error",
        ]),
      })
      .safeParse(rawEvidence);
    if (probeError.success) {
      throw new PackagedProofFailure(`adversarial_probe_${probeError.data.probeError}`);
    }
    stage = "adversarial_evidence_invalid";
    const evidence = z
      .object({
        controlHandleClosed: z.boolean(),
        environmentIsolated: z.boolean(),
        environmentRedirects: z.record(z.string(), z.boolean()),
        linkEscapeBlocked: z.boolean(),
        networkBlocked: z.boolean(),
        packagedHelperStatus: z.enum([
          "missing",
          "nonzero",
          "os_error",
          "permission_denied",
          "permission_denied_child",
          "permission_denied_child_image",
          "permission_denied_child_policy",
          "permission_denied_image",
          "permission_denied_probe",
          "permission_denied_unreadable",
          "ran",
          "timeout",
        ]),
        pathBlocked: z.boolean(),
        processEscapeBlocked: z.boolean(),
        runtimeCreateBlocked: z.boolean().optional(),
        runtimeDeleteBlocked: z.boolean().optional(),
        runtimeModifyBlocked: z.boolean().optional(),
        sensitiveLinkEscapesBlocked: SensitiveSurfacesSchema,
        sensitivePathsBlocked: SensitiveSurfacesSchema,
        sensitiveShellEscapesBlocked: SensitiveSurfacesSchema,
        shellEscapeBlocked: z.boolean(),
      })
      .parse(rawEvidence);
    stage = "adversarial_probe_failed";
    requireAdversarial(evidence.controlHandleClosed, "adversarial_protocol_failed");
    requireAdversarial(evidence.environmentIsolated, "adversarial_environment_isolation_failed");
    const requiredRedirects =
      platform === "win32"
        ? (["APPDATA", "HOME", "LOCALAPPDATA", "TEMP", "TMP", "USERPROFILE"] as const)
        : (["HOME", "TMPDIR"] as const);
    const redirectFailureCodes = {
      APPDATA: "adversarial_environment_redirect_appdata_failed",
      HOME: "adversarial_environment_redirect_home_failed",
      LOCALAPPDATA: "adversarial_environment_redirect_localappdata_failed",
      TEMP: "adversarial_environment_redirect_temp_failed",
      TMP: "adversarial_environment_redirect_tmp_failed",
      TMPDIR: "adversarial_environment_redirect_tmpdir_failed",
      USERPROFILE: "adversarial_environment_redirect_userprofile_failed",
    } as const satisfies Record<(typeof requiredRedirects)[number], PackagedProofFailureCode>;
    for (const name of requiredRedirects) {
      requireAdversarial(evidence.environmentRedirects[name] === true, redirectFailureCodes[name]);
    }
    if (evidence.packagedHelperStatus !== "ran") {
      throw new PackagedProofFailure(`adversarial_helper_${evidence.packagedHelperStatus}`);
    }
    if (platform === "win32") {
      requireAdversarial(
        evidence.runtimeCreateBlocked === true &&
          evidence.runtimeModifyBlocked === true &&
          evidence.runtimeDeleteBlocked === true,
        "adversarial_runtime_mutation_failed",
      );
    }
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
    proofFailure = {
      cause:
        packagedProofFailureCode(cause) === "proof_failed"
          ? new PackagedProofFailure(sessionFailureCode(stage, cause))
          : cause,
    };
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
    for (const path of Object.values(sensitiveLinkRoots)) {
      if (existsSync(path)) unlinkSync(path);
    }
  } catch (cause) {
    cleanupErrors.push(cause);
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
  createLauncher: (
    args: readonly string[],
    acceptedExitCodes?: readonly number[],
  ) => ReturnType<typeof createNativeContainmentLauncher>,
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
  const process = await createLauncher(
    [`--containment-lifecycle-probe=${plan}`],
    mode === "crash" ? [73] : [0],
  ).launch(request, AbortSignal.timeout(15_000));
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
  } catch {
    throw new PackagedProofFailure("cleanup_failed");
  }
  if (existsSync(publishablePath)) {
    throw new Error(`Contained ${mode} probe left publishable output`);
  }
  try {
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

function privateCleanupFailures(failures: readonly unknown[]): PackagedProofFailure[] {
  return failures.map(() => new PackagedProofFailure("cleanup_failed"));
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

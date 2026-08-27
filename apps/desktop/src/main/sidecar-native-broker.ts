import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { isAbsolute, relative, resolve } from "node:path";

import { z } from "zod";

import type { VerifiedContainmentRuntime } from "./sidecar-containment-integrity.ts";
import type {
  NativeContainmentBroker,
  NativeContainmentEvidence,
  NativeContainmentPlatform,
} from "./sidecar-containment-launcher.ts";
import { waitForExit } from "./sidecar-proof-process.ts";
import { SidecarSessionError } from "./sidecar-protocol.ts";

const EvidenceSchema = z.discriminatedUnion("backend", [
  z.object({
    appSandbox: z.literal(true),
    backend: z.literal("macos-xpc-app-sandbox"),
    helperInheritance: z.literal(true),
    networkClient: z.literal(false),
    networkServer: z.literal(false),
  }),
  z.object({
    appContainer: z.literal(true),
    backend: z.literal("windows-appcontainer-job"),
    breakawayDisabled: z.literal(true),
    jobObject: z.literal(true),
    networkCapabilityCount: z.literal(0),
  }),
  z.object({
    backend: z.literal("linux-landlock-seccomp"),
    cgroupDelegated: z.boolean(),
    landlockAbi: z.number().int().min(3),
    noNewPrivileges: z.literal(true),
    seccompFilter: z.literal(true),
  }),
]);
const FailureSchema = z.object({
  error: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-z0-9_]+(?:-[0-9]+)?$/),
});

type NativeBrokerOptions = {
  acceptedExitCodes?: readonly number[];
  args: readonly string[];
  containment: VerifiedContainmentRuntime;
  executablePath: string;
  platform: Exclude<NativeContainmentPlatform, "linux">;
  runtimeRoot: string;
  windowsProfile?: string;
  workspace: string;
};

const MAX_ATTESTATION_BYTES = 4 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const SIDECAR_FAILURE_PATTERN =
  /(?:^|\n)Open Chords analysis sidecar failed safely: (sidecar_(?:broken_pipe|file_not_found|internal_error|os_error|protocol_error|runtime_error|runtime_file_permission_denied|runtime_manifest_permission_denied|runtime_root_permission_denied|runtime_tool_permission_denied|session_permission_denied|value_error))(?:\r?\n|$)/u;

export function createExecutableNativeContainmentBroker(
  options: NativeBrokerOptions,
): NativeContainmentBroker {
  const acceptedExitCodes = options.acceptedExitCodes ?? [0];
  if (
    acceptedExitCodes.length === 0 ||
    acceptedExitCodes.some((code) => !Number.isInteger(code) || code < 0)
  ) {
    throw new SidecarSessionError("launch_failure", "Accepted sidecar exit codes are invalid");
  }
  const runtimeRoot = absolute(options.runtimeRoot, "Sidecar runtime root");
  const executablePath = absolute(options.executablePath, "Sidecar executable");
  const workspace = absolute(options.workspace, "Analysis workspace");
  assertChild(runtimeRoot, executablePath, "Sidecar executable escaped its runtime root");
  if (options.platform === "win32" && options.windowsProfile === undefined) {
    throw new SidecarSessionError("launch_failure", "Windows AppContainer profile is required");
  }
  return {
    async launchAndVerify(_request, signal) {
      const helperArguments = [
        ...(options.platform === "win32" ? [`--profile=${options.windowsProfile!}`] : []),
        `--workspace=${workspace}`,
        `--runtime-root=${runtimeRoot}`,
        "--",
        executablePath,
        ...options.args,
      ];
      const child = spawn(options.containment.helperPath, helperArguments, {
        cwd: workspace,
        env: {},
        shell: false,
        signal,
        stdio: ["pipe", "pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolveExit) => {
          child.once("close", (code, exitSignal) => resolveExit({ code, signal: exitSignal }));
        },
      );
      try {
        await waitForSpawn(child);
        const evidence = await readEvidence(child);
        if (evidence.backend !== options.containment.backend) {
          throw new SidecarSessionError(
            "launch_failure",
            "Native broker attested another containment backend",
          );
        }
        if (child.stdin === null || child.stdout === null) {
          throw new SidecarSessionError("launch_failure", "Contained process pipes are missing");
        }
        const stdin = child.stdin;
        const stderr = createBoundedSidecarStderrCapture(() => {
          if (child.exitCode === null) child.kill("SIGKILL");
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          stderr.append(chunk);
        });
        let stopped = false;
        return {
          evidence,
          process: {
            stdout: containedProcessStdout(
              child.stdout,
              exited,
              stderr.snapshot,
              acceptedExitCodes,
            ),
            async stop() {
              if (stopped) return;
              stopped = true;
              if (child.exitCode !== null || child.signalCode !== null) return;
              child.kill("SIGTERM");
              if (await waitForExit(child, 5_000)) return;
              child.kill("SIGKILL");
              if (!(await waitForExit(child, 5_000))) {
                throw new SidecarSessionError(
                  "cleanup_failure",
                  "Native containment process domain was not reaped",
                );
              }
            },
            async write(frame) {
              await new Promise<void>((resolveWrite, reject) => {
                stdin.write(frame, (error) => {
                  if (error === null || error === undefined) resolveWrite();
                  else reject(error);
                });
              });
            },
          },
        };
      } catch (cause) {
        child.kill("SIGKILL");
        await waitForExit(child, 5_000).catch(() => false);
        if (cause instanceof SidecarSessionError) throw cause;
        throw new SidecarSessionError("launch_failure", "Native containment setup failed", {
          cause,
        });
      }
    },
  };
}

async function* containedProcessStdout(
  stdout: NonNullable<ChildProcess["stdout"]>,
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>,
  stderr: () => { bytes: Buffer; exceeded: boolean },
  acceptedExitCodes: readonly number[],
): AsyncGenerator<Uint8Array> {
  yield* stdout;
  const status = await exited;
  if (containedExitWasAccepted(status, acceptedExitCodes)) return;
  const capturedStderr = stderr();
  const failureCode = parseSidecarProcessFailure(
    capturedStderr.bytes.toString("utf8"),
    capturedStderr.exceeded,
  );
  throw new SidecarSessionError(
    "process_failure",
    "Contained sidecar exited before completing its protocol",
    failureCode === null ? undefined : { remoteCode: failureCode },
  );
}

export function containedExitWasAccepted(
  status: { code: number | null; signal: NodeJS.Signals | null },
  acceptedExitCodes: readonly number[],
): boolean {
  return status.signal === null && status.code !== null && acceptedExitCodes.includes(status.code);
}

export function createBoundedSidecarStderrCapture(onExceeded: () => void): {
  append(chunk: Buffer): void;
  snapshot: () => { bytes: Buffer; exceeded: boolean };
} {
  let bytes = Buffer.alloc(0);
  let exceeded = false;
  return {
    append(chunk) {
      if (exceeded) return;
      const remaining = MAX_STDERR_BYTES - bytes.byteLength;
      if (chunk.byteLength > remaining) {
        bytes = Buffer.concat([bytes, chunk.subarray(0, remaining)]);
        exceeded = true;
        onExceeded();
        return;
      }
      bytes = Buffer.concat([bytes, chunk]);
    },
    snapshot: () => ({ bytes, exceeded }),
  };
}

export function parseSidecarProcessFailure(value: string, exceeded = false): string | null {
  if (exceeded) return null;
  return SIDECAR_FAILURE_PATTERN.exec(value)?.[1] ?? null;
}

async function readEvidence(child: ChildProcess): Promise<NativeContainmentEvidence> {
  const control = child.stdio[3];
  if (
    control === undefined ||
    control === null ||
    typeof control === "number" ||
    !("on" in control)
  ) {
    throw new SidecarSessionError("launch_failure", "Containment evidence pipe is missing");
  }
  const bytes = await new Promise<Buffer>((resolveLine, reject) => {
    let buffered = Buffer.alloc(0);
    let settled = false;
    const finish = (error?: Error, value?: Buffer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      control.off("data", onData);
      control.off("end", onEnd);
      control.off("error", onError);
      if (error === undefined && value !== undefined) resolveLine(value);
      else reject(error ?? new Error("containment evidence is missing"));
    };
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.byteLength > MAX_ATTESTATION_BYTES) {
        finish(new SidecarSessionError("launch_failure", "Containment evidence is oversized"));
        return;
      }
      const newline = buffered.indexOf(0x0a);
      if (newline >= 0) finish(undefined, buffered.subarray(0, newline));
    };
    const onEnd = () => finish(new Error("containment evidence pipe closed"));
    const onError = (error: Error) => finish(error);
    const timer = setTimeout(
      () => finish(new SidecarSessionError("launch_failure", "Containment setup timed out")),
      5_000,
    );
    control.on("data", onData);
    control.once("end", onEnd);
    control.once("error", onError);
  });
  try {
    return parseNativeContainmentEvidence(bytes.toString("utf8"));
  } catch (cause) {
    const failure = parseNativeContainmentFailure(bytes.toString("utf8"));
    if (failure !== null) {
      throw new SidecarSessionError(
        "launch_failure",
        `Native containment rejected launch: ${failure}`,
        { cause },
      );
    }
    throw new SidecarSessionError("launch_failure", "Containment evidence is invalid", { cause });
  }
}

export function parseNativeContainmentEvidence(value: string): NativeContainmentEvidence {
  return EvidenceSchema.parse(JSON.parse(value));
}

export function parseNativeContainmentFailure(value: string): string | null {
  try {
    const parsed = FailureSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data.error : null;
  } catch {
    return null;
  }
}

async function waitForSpawn(child: ChildProcess): Promise<void> {
  if (child.pid !== undefined) return;
  await Promise.race([
    once(child, "spawn").then(() => undefined),
    once(child, "error").then(([error]) => Promise.reject(error)),
  ]);
}

function absolute(path: string, label: string): string {
  if (!isAbsolute(path))
    throw new SidecarSessionError("launch_failure", `${label} is not absolute`);
  return resolve(path);
}

function assertChild(root: string, child: string, message: string): void {
  const path = relative(root, child);
  if (path !== "" && !path.startsWith("..") && !isAbsolute(path)) return;
  throw new SidecarSessionError("launch_failure", message);
}

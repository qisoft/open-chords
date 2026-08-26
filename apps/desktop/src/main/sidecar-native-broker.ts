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

type NativeBrokerOptions = {
  args: readonly string[];
  containment: VerifiedContainmentRuntime;
  executablePath: string;
  linuxCgroup?: string;
  platform: NativeContainmentPlatform;
  runtimeRoot: string;
  windowsProfile?: string;
  workspace: string;
};

const MAX_ATTESTATION_BYTES = 4 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;

export function createExecutableNativeContainmentBroker(
  options: NativeBrokerOptions,
): NativeContainmentBroker {
  const runtimeRoot = absolute(options.runtimeRoot, "Sidecar runtime root");
  const executablePath = absolute(options.executablePath, "Sidecar executable");
  const workspace = absolute(options.workspace, "Analysis workspace");
  assertChild(runtimeRoot, executablePath, "Sidecar executable escaped its runtime root");
  if (options.platform === "win32" && options.windowsProfile === undefined) {
    throw new SidecarSessionError("launch_failure", "Windows AppContainer profile is required");
  }
  if (options.platform === "linux" && options.linuxCgroup === undefined) {
    throw new SidecarSessionError("launch_failure", "Delegated Linux cgroup is required");
  }
  return {
    async launchAndVerify(_request, signal) {
      const helperArguments = [
        ...(options.platform === "win32" ? [`--profile=${options.windowsProfile!}`] : []),
        ...(options.platform === "linux" ? [`--cgroup=${options.linuxCgroup!}`] : []),
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
        let stderrBytes = 0;
        child.stderr?.on("data", (chunk: Buffer) => {
          stderrBytes += chunk.byteLength;
          if (stderrBytes > MAX_STDERR_BYTES && child.exitCode === null) child.kill("SIGKILL");
        });
        let stopped = false;
        return {
          evidence,
          process: {
            stdout: child.stdout,
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
  let timer: ReturnType<typeof setTimeout>;
  const bytes = await Promise.race([
    new Promise<Buffer>((resolveLine, reject) => {
      let buffered = Buffer.alloc(0);
      control.on("data", (chunk: Buffer) => {
        buffered = Buffer.concat([buffered, chunk]);
        if (buffered.byteLength > MAX_ATTESTATION_BYTES) {
          reject(new SidecarSessionError("launch_failure", "Containment evidence is oversized"));
          return;
        }
        const newline = buffered.indexOf(0x0a);
        if (newline >= 0) resolveLine(buffered.subarray(0, newline));
      });
      control.once("end", () => reject(new Error("containment evidence pipe closed")));
      control.once("error", reject);
    }),
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new SidecarSessionError("launch_failure", "Containment setup timed out")),
        5_000,
      );
    }),
  ]).finally(() => clearTimeout(timer!));
  try {
    return EvidenceSchema.parse(JSON.parse(bytes.toString("utf8")));
  } catch (cause) {
    throw new SidecarSessionError("launch_failure", "Containment evidence is invalid", { cause });
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

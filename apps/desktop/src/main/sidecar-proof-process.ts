import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";

import { SidecarSessionError, type SidecarProcessLauncher } from "./sidecar-protocol.ts";

type ProofSpawnOptions = {
  args: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
  executablePath: string;
  onSpawn?: (pid: number) => void;
};

/**
 * Cross-process protocol proof only. Ordinary spawn cannot provide the
 * platform containment contract required of the production launcher.
 */
export function createUncontainedSpawnLauncherForProof(
  options: ProofSpawnOptions,
): SidecarProcessLauncher {
  return {
    async launch(_request, signal) {
      const child = spawn(options.executablePath, [...options.args], {
        cwd: options.cwd,
        env: { ...options.env },
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        signal,
        windowsHide: true,
      });
      await waitForSpawn(child);
      if (child.pid === undefined || child.stdout === null || child.stdin === null) {
        throw new SidecarSessionError("launch_failure", "Sidecar process pipes were unavailable");
      }
      const stdin = child.stdin;
      child.stderr?.on("data", () => undefined);
      options.onSpawn?.(child.pid);
      let stopped = false;
      return {
        stdout: child.stdout,
        async stop() {
          if (stopped) return;
          stopped = true;
          if (child.exitCode !== null || child.signalCode !== null) return;
          child.kill("SIGTERM");
          if (await waitForExit(child, 5_000)) return;
          child.kill("SIGKILL");
          if (!(await waitForExit(child, 5_000))) {
            throw new SidecarSessionError("cleanup_failure", "Sidecar process did not terminate");
          }
        },
        async write(frame) {
          await new Promise<void>((resolve, reject) => {
            stdin.write(frame, (error) => {
              if (error === null || error === undefined) resolve();
              else reject(error);
            });
          });
        },
      };
    },
  };
}

async function waitForSpawn(child: ChildProcess): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      child.off("error", failed);
      child.off("spawn", spawned);
    };
    const failed = (error: Error) => {
      cleanup();
      reject(error);
    };
    const spawned = () => {
      cleanup();
      resolve();
    };
    child.once("error", failed);
    child.once("spawn", spawned);
  });
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  let timeout: ReturnType<typeof setTimeout>;
  const timedOut = new Promise<false>((resolve) => {
    timeout = setTimeout(() => resolve(false), timeoutMs);
  });
  const exited = once(child, "exit").then(() => true as const);
  const result = await Promise.race([exited, timedOut]);
  clearTimeout(timeout!);
  return result;
}

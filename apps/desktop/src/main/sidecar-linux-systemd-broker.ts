import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";

import type { VerifiedContainmentRuntime } from "./sidecar-containment-integrity.ts";
import type { NativeContainmentBroker } from "./sidecar-containment-launcher.ts";
import { parseNativeContainmentEvidence } from "./sidecar-native-broker.ts";
import { waitForExit } from "./sidecar-proof-process.ts";
import { SidecarSessionError } from "./sidecar-protocol.ts";

type LinuxSystemdBrokerOptions = {
  args: readonly string[];
  containment: VerifiedContainmentRuntime;
  executablePath: string;
  runtimeRoot: string;
  workspace: string;
};

export function createLinuxSystemdContainmentBroker(
  options: LinuxSystemdBrokerOptions,
): NativeContainmentBroker {
  if (options.containment.backend !== "linux-landlock-seccomp") {
    throw new SidecarSessionError("launch_failure", "Linux broker manifest targets another OS");
  }
  const runtimeRoot = resolveAbsolute(options.runtimeRoot, "Sidecar runtime root");
  const executablePath = resolveAbsolute(options.executablePath, "Sidecar executable");
  const workspace = resolveAbsolute(options.workspace, "Analysis workspace");
  const runtimeDirectory = resolveAbsolute(
    process.env.XDG_RUNTIME_DIR ?? "",
    "Linux user runtime directory",
  );
  assertChild(
    resolve(runtimeDirectory, "open-chords-analysis"),
    workspace,
    "Analysis workspace escaped the private Linux staging root",
  );
  const runtimeChild = relative(runtimeRoot, executablePath);
  if (runtimeChild === "" || runtimeChild.startsWith("..") || isAbsolute(runtimeChild)) {
    throw new SidecarSessionError("launch_failure", "Sidecar executable escaped its runtime root");
  }
  const managerEnvironment = userManagerEnvironment();
  return {
    async launchAndVerify(request, signal) {
      const unit = `open-chords-analysis-${randomUUID()}`;
      const child = spawn(
        "/usr/bin/systemd-run",
        [
          "--user",
          "--scope",
          "--quiet",
          "--collect",
          `--unit=${unit}`,
          "--property=TasksMax=8",
          "--property=MemoryMax=3221225472",
          "--property=KillMode=control-group",
          `--property=RuntimeMaxSec=${String(Math.ceil(request.timeoutMs / 1_000) + 10)}`,
          "--",
          options.containment.helperPath,
          `--expected-unit=${unit}.scope`,
          `--workspace=${workspace}`,
          `--runtime-root=${runtimeRoot}`,
          "--",
          executablePath,
          ...options.args,
        ],
        {
          cwd: workspace,
          env: managerEnvironment,
          shell: false,
          signal,
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      const onChildError = () => undefined;
      child.on("error", onChildError);
      child.once("close", () => child.off("error", onChildError));
      try {
        const evidence = await readSystemdEvidence(child);
        if (child.stdin === null || child.stdout === null) {
          throw new Error("systemd scope pipes are unavailable");
        }
        const stdin = child.stdin;
        let stopped = false;
        return {
          evidence,
          process: {
            stdout: child.stdout,
            async stop() {
              if (stopped) return;
              stopped = true;
              if (child.exitCode !== null || child.signalCode !== null) return;
              const stoppedUnit = await stopUnit(`${unit}.scope`, managerEnvironment)
                .then(() => true)
                .catch(() => false);
              if (await waitForExit(child, 5_000)) return;
              if (!stoppedUnit) {
                await killUnit(`${unit}.scope`, managerEnvironment).catch(() => undefined);
              }
              child.kill("SIGKILL");
              if (!(await waitForExit(child, 5_000))) {
                throw new SidecarSessionError(
                  "cleanup_failure",
                  "Linux systemd containment scope was not reaped",
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
        const stopped = await stopUnit(`${unit}.scope`, managerEnvironment)
          .then(() => true)
          .catch(() => false);
        if (!stopped) await killUnit(`${unit}.scope`, managerEnvironment).catch(() => undefined);
        child.kill("SIGKILL");
        await waitForExit(child, 5_000).catch(() => false);
        throw new SidecarSessionError("launch_failure", "Linux containment setup failed", {
          cause,
        });
      }
    },
  };
}

async function readSystemdEvidence(child: ChildProcess) {
  if (child.stderr === null) throw new Error("systemd scope stderr is unavailable");
  const stderr = child.stderr;
  const line = await new Promise<string>((resolveLine, reject) => {
    let buffered = Buffer.alloc(0);
    const timer = setTimeout(() => finish(new Error("Linux containment setup timed out")), 5_000);
    const finish = (error?: Error, value?: string) => {
      clearTimeout(timer);
      child.off("error", onChildError);
      stderr.off("data", onData);
      stderr.off("end", onEnd);
      stderr.off("error", onError);
      if (error === undefined && value !== undefined) resolveLine(value);
      else reject(error ?? new Error("Linux containment evidence is missing"));
    };
    const onEnd = () => finish(new Error("Linux containment evidence is missing"));
    const onChildError = (error: Error) => finish(error);
    const onError = (error: Error) => finish(error);
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.byteLength > 4 * 1024) {
        finish(new Error("Linux containment evidence is oversized"));
        return;
      }
      const newline = buffered.indexOf(0x0a);
      if (newline < 0) return;
      const trailingBytes = buffered.byteLength - newline - 1;
      drainBoundedStderr(child, stderr, trailingBytes);
      finish(undefined, buffered.subarray(0, newline).toString("utf8"));
    };
    child.once("error", onChildError);
    stderr.on("data", onData);
    stderr.once("end", onEnd);
    stderr.once("error", onError);
  });
  const prefix = "OC_CONTAINMENT_V1 ";
  if (!line.startsWith(prefix)) throw new Error("Linux containment evidence prefix is invalid");
  return parseNativeContainmentEvidence(line.slice(prefix.length));
}

function drainBoundedStderr(
  child: ChildProcess,
  stderr: NonNullable<ChildProcess["stderr"]>,
  initialBytes: number,
): void {
  let bytes = initialBytes;
  stderr.on("data", (chunk: Buffer) => {
    bytes += chunk.byteLength;
    if (bytes > 64 * 1024 && child.exitCode === null) child.kill("SIGKILL");
  });
}

function stopUnit(unit: string, environment: NodeJS.ProcessEnv): Promise<void> {
  return systemctl(["--user", "stop", unit], environment);
}

function killUnit(unit: string, environment: NodeJS.ProcessEnv): Promise<void> {
  return systemctl(["--user", "kill", "--kill-whom=all", "--signal=SIGKILL", unit], environment);
}

function systemctl(arguments_: readonly string[], environment: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolveStop, reject) => {
    execFile(
      "/usr/bin/systemctl",
      arguments_,
      { env: environment, timeout: 5_000, windowsHide: true },
      (error) => (error === null ? resolveStop() : reject(error)),
    );
  });
}

function userManagerEnvironment(): NodeJS.ProcessEnv {
  const runtime = process.env.XDG_RUNTIME_DIR;
  if (runtime === undefined || !isAbsolute(runtime)) {
    throw new SidecarSessionError("launch_failure", "Linux user systemd runtime is unavailable");
  }
  return {
    ...(process.env.DBUS_SESSION_BUS_ADDRESS === undefined
      ? {}
      : { DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS }),
    XDG_RUNTIME_DIR: runtime,
  };
}

function resolveAbsolute(path: string, label: string): string {
  if (!isAbsolute(path))
    throw new SidecarSessionError("launch_failure", `${label} is not absolute`);
  return resolve(path);
}

function assertChild(root: string, child: string, message: string): void {
  const path = relative(root, child);
  if (path !== "" && !path.startsWith("..") && !isAbsolute(path)) return;
  throw new SidecarSessionError("launch_failure", message);
}

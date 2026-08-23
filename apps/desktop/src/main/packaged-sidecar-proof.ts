import { join } from "node:path";

import { utilityProcess } from "electron";

import {
  createEffectSidecarClient,
  parseSidecarSessionRequest,
  SidecarSessionError,
  type SidecarProcessLauncher,
} from "./sidecar-session.ts";
import {
  observeUtilityExit,
  waitForUtilityReap,
  waitForUtilitySpawn,
} from "./sidecar-utility-process.ts";

export async function runPackagedSidecarProof(): Promise<void> {
  let stopReason: string | undefined;
  const client = createEffectSidecarClient(
    createPackagedUtilityProcessLauncherForProof((reason) => {
      stopReason = reason;
    }),
  );
  const request = parseSidecarSessionRequest({
    jobId: "job-packaged-proof",
    manifestHash: "a".repeat(64),
    nonce: "nonce-packaged-proof",
    requestId: "request-packaged-proof",
    timeoutMs: 5_000,
  });
  try {
    const result = await client.runSession(request);
    if (
      result.artifact.path !== "result.json" ||
      result.jobId !== request.jobId ||
      result.requestId !== request.requestId ||
      stopReason !== "completed"
    ) {
      throw new Error("Packaged sidecar lifecycle proof returned unexpected evidence");
    }
  } finally {
    await client.dispose();
  }
}

function createPackagedUtilityProcessLauncherForProof(
  onStop: (reason: string) => void,
): SidecarProcessLauncher {
  return {
    async launch(_request, signal) {
      const child = utilityProcess.fork(
        join(process.resourcesPath, "packaged-sidecar-worker.cjs"),
        [],
        {
          cwd: process.resourcesPath,
          env: {},
          serviceName: "Open Chords packaged sidecar proof",
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const exited = observeUtilityExit(child);
      await waitForUtilitySpawn(child, exited, signal);
      const stdout = child.stdout;
      if (child.pid === undefined || stdout === null) {
        throw new SidecarSessionError(
          "launch_failure",
          "Packaged sidecar utility process pipe was unavailable",
        );
      }
      child.stderr?.on("data", () => undefined);
      let stopped = false;
      return {
        stdout: readUtilityOutput(stdout),
        async stop(reason) {
          if (stopped) return;
          stopped = true;
          onStop(reason);
          if (child.pid === undefined) return;
          if (!child.kill()) {
            throw new SidecarSessionError(
              "cleanup_failure",
              "Packaged sidecar utility process could not be terminated",
            );
          }
          await waitForUtilityReap(exited);
        },
        async write(frame) {
          child.postMessage(Buffer.from(frame));
        },
      };
    },
  };
}

async function* readUtilityOutput(stdout: NodeJS.ReadableStream): AsyncIterable<Uint8Array> {
  for await (const chunk of stdout as AsyncIterable<string | Uint8Array>) {
    yield typeof chunk === "string" ? Buffer.from(chunk) : chunk;
  }
}

import childProcess from "node:child_process";
import fs from "node:fs";
import { readdir } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";

import { openAcquisitionJobs, type AcquisitionJobsOptions } from "./acquisition-jobs.ts";
import { cleanupPackagedWorkspace } from "./packaged-sidecar-proof-workspace.ts";
import { verifyContainmentRuntime } from "./sidecar-containment-integrity.ts";

/** Installed proof only: fault the external filesystem/native cleanup boundary. */
export async function proveInitializationCleanupRecovery(options: AcquisitionJobsOptions) {
  const runtime = options.runtime;
  if (!runtime || (process.platform !== "darwin" && process.platform !== "win32"))
    throw new Error("acquisition_proof_failed");
  const platform = process.platform;
  const stateRoot = join(options.stateRoot, "initialization-failure");
  const jobs = await openAcquisitionJobs({ ...options, stateRoot });
  const originalStat = fs.promises.lstat;
  const originalRemove = fs.rmSync;
  const originalCopy = fs.cpSync;
  const originalExec = childProcess.execFileSync;
  let identity = "";
  let masterChecks = 0;
  let initializationFault = false;
  let retainedPath = "";
  let recoveredWorkspaceRemoved = false;
  let cleanupFault = false;
  let preserved = false;
  let failedSafely = false;
  let blockedSafely = false;
  let closeFailed = false;
  const restore = () => {
    fs.promises.lstat = originalStat;
    fs.rmSync = originalRemove;
    fs.cpSync = originalCopy;
    childProcess.execFileSync = originalExec;
    syncBuiltinESMExports();
  };
  try {
    fs.promises.lstat = new Proxy(originalStat, {
      apply(target, receiver, args) {
        const path = String(args[0]);
        if (path === runtime.runtimeRoot) masterChecks++;
        const prepared =
          platform === "darwin" && path === runtime.runtimeRoot && masterChecks === 3;
        if (prepared) {
          initializationFault = true;
          return Promise.reject(Object.assign(new Error("fixture_io_failure"), { code: "EIO" }));
        }
        return Reflect.apply(target, receiver, args);
      },
    });
    fs.cpSync = new Proxy(originalCopy, {
      apply(target, receiver, args) {
        if (
          platform === "win32" &&
          identity !== "" &&
          String(args[1]).endsWith(`OpenChords.Analysis.${identity}`)
        ) {
          initializationFault = true;
          retainedPath = String(args[1]);
          throw Object.assign(new Error("fixture_io_failure"), { code: "EIO" });
        }
        return Reflect.apply(target, receiver, args);
      },
    });
    fs.rmSync = new Proxy(originalRemove, {
      apply(target, receiver, args) {
        if (identity !== "" && String(args[0]).endsWith(identity)) {
          cleanupFault = true;
          retainedPath = String(args[0]);
          throw Object.assign(new Error("fixture_cleanup_failure"), { code: "EACCES" });
        }
        return Reflect.apply(target, receiver, args);
      },
    });
    childProcess.execFileSync = new Proxy(originalExec, {
      apply(target, receiver, args) {
        if (
          identity !== "" &&
          Array.isArray(args[1]) &&
          args[1].includes(`--destroy=OpenChords.Analysis.${identity}`)
        ) {
          cleanupFault = true;
          throw Object.assign(new Error("fixture_cleanup_failure"), { code: "EACCES" });
        }
        return Reflect.apply(target, receiver, args);
      },
    });
    syncBuiltinESMExports();
    const started = await jobs.start({ url: "https://youtu.be/aqz-KE-bpKQ" });
    identity = started.attempts[0]?.id.slice("acquisitionattempt_".length) ?? "";
    const failed = await jobs.wait(started.id);
    failedSafely = failed.state === "failed" && failed.reason === "cleanup_failure";
    restore();
    preserved = (await readdir(join(stateRoot, "acquisition-jobs/workspaces"))).includes(identity);
    const blocked = await jobs.start({ url: "https://youtu.be/aqz-KE-bpKQ" });
    blockedSafely =
      blocked.state === "blocked" &&
      blocked.reason === "cleanup_failure" &&
      blocked.attempts.length === 0;
    if (blocked.state === "running") await jobs.cancel(blocked.id);
  } finally {
    restore();
    await jobs.close().catch(() => {
      closeFailed = true;
    });
    // Recovery must use the retained authority rather than the test's private path knowledge.
    const recovered = await openAcquisitionJobs({ ...options, stateRoot });
    await recovered.close();
    recoveredWorkspaceRemoved = retainedPath !== "" && !fs.existsSync(retainedPath);
    if (identity) {
      const containment = verifyContainmentRuntime(
        runtime.containmentRoot,
        runtime.containmentManifestHash,
        platform,
        runtime.bridgePath,
      );
      cleanupPackagedWorkspace(platform, containment.helperPath, identity);
    }
  }
  return (
    initializationFault &&
    recoveredWorkspaceRemoved &&
    cleanupFault &&
    failedSafely &&
    preserved &&
    blockedSafely &&
    closeFailed &&
    (await readdir(join(stateRoot, "acquisition-jobs/workspaces"))).length === 0
  );
}

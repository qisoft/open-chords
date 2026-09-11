import fs from "node:fs";
import { readdir } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";

import { openAcquisitionJobs, type AcquisitionJobsOptions } from "./acquisition-jobs.ts";

/** Pause an external durable rename at the public Job start boundary. */
export async function proveAcquisitionStartCancellation(options: AcquisitionJobsOptions) {
  const results: boolean[] = [];
  for (const cause of ["offline", "close"] as const) {
    await options.network.setOffline(false);
    const stateRoot = join(options.stateRoot, `start-${cause}`);
    let resolutions = 0;
    const jobs = await openAcquisitionJobs({
      ...options,
      stateRoot,
      networkTransport: {
        resolve: async () => {
          resolutions++;
          throw new Error("fixture_network_forbidden");
        },
        request: async () => {
          throw new Error("fixture_network_forbidden");
        },
      },
    });
    const originalRename = fs.promises.rename;
    let release!: () => void;
    let paused!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reached = new Promise<void>((resolve) => {
      paused = resolve;
    });
    let armed = true;
    fs.promises.rename = new Proxy(originalRename, {
      apply(target, receiver, args) {
        if (armed && String(args[1]) === join(stateRoot, "acquisition-jobs/state.json")) {
          armed = false;
          paused();
          return gate.then(() => Reflect.apply(target, receiver, args));
        }
        return Reflect.apply(target, receiver, args);
      },
    });
    syncBuiltinESMExports();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let starting: ReturnType<typeof jobs.start> | undefined;
    let closing: Promise<void> | undefined;
    try {
      starting = jobs.start({ url: "https://youtu.be/aqz-KE-bpKQ" });
      void starting.catch(() => undefined);
      await Promise.race([
        reached,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("acquisition_proof_deadline")), 60000);
        }),
      ]);
      if (cause === "offline") {
        await options.network.setOffline(true);
        await options.network.setOffline(false);
      } else {
        closing = jobs.close();
        void closing.catch(() => undefined);
      }
      release();
      const started = await starting;
      await closing;
      const closedTerminal =
        cause !== "close" ||
        (jobs.list().find((job) => job.id === started.id)?.state === "cancelled" &&
          (await readdir(join(stateRoot, "acquisition-jobs/workspaces"))).length === 0);
      const terminal = await jobs.wait(started.id);
      results.push(
        closedTerminal &&
          terminal.state === "cancelled" &&
          resolutions === 0 &&
          (await readdir(join(stateRoot, "acquisition-jobs/workspaces"))).length === 0,
      );
    } finally {
      clearTimeout(timer);
      release();
      fs.promises.rename = originalRename;
      syncBuiltinESMExports();
      await starting?.catch(() => undefined);
      await closing?.catch(() => undefined);
      await jobs.close();
      await options.network.setOffline(false);
    }
  }
  return { offlineDuringStartCancelled: results[0], closeDuringStartReaped: results[1] };
}

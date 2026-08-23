import { EventEmitter } from "node:events";
import { resolve } from "node:path";

import { expect, it } from "vitest";

import { waitForExit } from "../apps/desktop/src/main/sidecar-proof-process.ts";
import {
  createPromiseSidecarClient,
  createUncontainedSpawnLauncherForProof,
  parseSidecarSessionRequest,
} from "../apps/desktop/src/main/sidecar-session.ts";

it("proves the protocol across a real child-process boundary and reaps the child", async () => {
  let childPid: number | undefined;
  const launcher = createUncontainedSpawnLauncherForProof({
    args: [resolve("tests/fixtures/fake-sidecar.mjs")],
    cwd: process.cwd(),
    env: {},
    executablePath: process.execPath,
    onSpawn: (pid) => {
      childPid = pid;
    },
  });
  const client = createPromiseSidecarClient(launcher);

  await expect(
    client.runSession(
      parseSidecarSessionRequest({
        jobId: "job-cross-process",
        manifestHash: "a".repeat(64),
        nonce: "nonce-cross-process",
        requestId: "request-cross-process",
        timeoutMs: 2_000,
      }),
    ),
  ).resolves.toMatchObject({
    artifact: { path: "result.json" },
    jobId: "job-cross-process",
    requestId: "request-cross-process",
  });
  expect(childPid).toBeTypeOf("number");
  let childWasReaped = false;
  try {
    process.kill(childPid!, 0);
  } catch {
    childWasReaped = true;
  }
  expect(childWasReaped).toBe(true);
  await client.dispose();
});

it("removes exit listeners when the child wait times out", async () => {
  const child = Object.assign(new EventEmitter(), {
    exitCode: null,
    signalCode: null,
  });

  await expect(waitForExit(child, 5)).resolves.toBe(false);

  expect(child.listenerCount("exit")).toBe(0);
  expect(child.listenerCount("error")).toBe(0);
});

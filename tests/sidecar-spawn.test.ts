import { resolve } from "node:path";

import { expect, it } from "vitest";

import {
  createPromiseSidecarClient,
  createUncontainedSpawnLauncherForProof,
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
    client.runSession({
      jobId: "job-cross-process",
      manifestHash: "a".repeat(64),
      nonce: "nonce-cross-process",
      requestId: "request-cross-process",
      timeoutMs: 2_000,
    }),
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

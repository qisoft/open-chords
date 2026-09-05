import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { verifyContainmentRuntime } from "../apps/desktop/src/main/sidecar-containment-integrity.ts";
import { createExecutableNativeContainmentBroker } from "../apps/desktop/src/main/sidecar-native-broker.ts";
import { parseSidecarSessionRequest } from "../apps/desktop/src/main/sidecar-session.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it.skipIf(process.platform === "win32")(
  "reaps an acquired broker on abort without an uncaught child-process error",
  async () => {
    const controller = new AbortController();
    const broker = createFixtureBroker(true);
    const acquired = await broker.launchAndVerify(
      parseSidecarSessionRequest({
        jobId: "job_abort",
        manifestHash: "a".repeat(64),
        nonce: "nonce_abort",
        requestId: "request_abort",
        timeoutMs: 5_000,
      }),
      controller.signal,
    );
    try {
      controller.abort();
      await expect(acquired.process.stop("cancelled")).resolves.toBeUndefined();
      // Flush Node's deferred uncaught-error delivery as part of this test.
      await new Promise<void>((resolve) => setImmediate(resolve));
    } finally {
      await acquired.process.stop("cancelled");
    }
  },
);

it.skipIf(process.platform === "win32")(
  "bounds native attestation by the request deadline",
  async () => {
    const broker = createFixtureBroker(false);
    await expect(
      broker.launchAndVerify(
        parseSidecarSessionRequest({
          jobId: "job_deadline",
          manifestHash: "a".repeat(64),
          nonce: "nonce_deadline",
          requestId: "request_deadline",
          timeoutMs: 20,
        }),
        AbortSignal.timeout(500),
      ),
    ).rejects.toMatchObject({
      code: "launch_failure",
      message: "Containment setup timed out",
    });
  },
);

function createFixtureBroker(attest: boolean) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "open-chords-broker-abort-")));
  roots.push(root);
  // Transport fixture only: this shell does not attest real OS containment.
  const helperName = "open-chords-containment-bridge";
  const helper = Buffer.from(
    attest
      ? '#!/bin/sh\nprintf \'%s\\n\' \'{"backend":"macos-xpc-app-sandbox","appSandbox":true,"helperInheritance":true,"networkClient":false,"networkServer":false}\' >&3\nexec /bin/sleep 60\n'
      : "#!/bin/sh\nexec /bin/sleep 60\n",
  );
  const manifest = Buffer.from(
    JSON.stringify({
      backend: "macos-xpc-app-sandbox",
      files: [{ path: helperName, sha256: createHash("sha256").update(helper).digest("hex") }],
      version: 1,
    }),
  );
  writeFileSync(join(root, helperName), helper, { mode: 0o700 });
  writeFileSync(join(root, "containment-manifest.json"), manifest);
  return createExecutableNativeContainmentBroker({
    args: [],
    containment: verifyContainmentRuntime(
      root,
      createHash("sha256").update(manifest).digest("hex"),
      "darwin",
    ),
    executablePath: join(root, helperName),
    platform: "darwin",
    runtimeRoot: root,
    workspace: root,
  });
}

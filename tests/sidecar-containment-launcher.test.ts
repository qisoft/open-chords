import { resolve } from "node:path";

import { expect, it } from "vitest";

import {
  createNativeContainmentLauncher,
  type NativeContainmentBroker,
  type NativeContainmentEvidence,
  type NativeContainmentPlatform,
} from "../apps/desktop/src/main/sidecar-containment-launcher.ts";
import { parseNativeContainmentFailure } from "../apps/desktop/src/main/sidecar-native-broker.ts";
import {
  createPromiseSidecarClient,
  createUncontainedSpawnLauncherForProof,
  parseSidecarSessionRequest,
  SidecarSessionError,
} from "../apps/desktop/src/main/sidecar-session.ts";

const fixtureRoot = resolve("tests/fixtures");

it("surfaces bounded native containment failure reasons", () => {
  expect(parseNativeContainmentFailure('{"error":"helper_signature_create_failed"}')).toBe(
    "helper_signature_create_failed",
  );
  expect(parseNativeContainmentFailure('{"error":"service_bundle_validation_failed_-67030"}')).toBe(
    "service_bundle_validation_failed_-67030",
  );
  expect(parseNativeContainmentFailure('{"error":"invalid reason"}')).toBeNull();
});

it("refuses to launch when the native broker cannot prove containment", async () => {
  const launcher = createNativeContainmentLauncher(
    brokerThatReturns({ backend: "uncontained" }),
    testPlatform(),
  );

  await expect(launcher.launch(request(), new AbortController().signal)).rejects.toMatchObject({
    code: "launch_failure",
  });
});

it("runs the protocol only after the native broker verifies the expected backend", async () => {
  const launcher = createNativeContainmentLauncher(
    brokerThatReturns(validEvidence()),
    testPlatform(),
  );
  const client = createPromiseSidecarClient(launcher);

  await expect(client.runSession(request())).resolves.toMatchObject({
    artifact: { path: "result.json" },
    jobId: "job-contained",
    requestId: "request-contained",
  });
  await client.dispose();
});

it("does not invoke an uncontained fallback when native setup fails", async () => {
  let fallbackLaunches = 0;
  const broker: NativeContainmentBroker = {
    async launchAndVerify() {
      throw new SidecarSessionError("launch_failure", "Native setup failed");
    },
  };
  const launcher = createNativeContainmentLauncher(broker, testPlatform());

  await expect(launcher.launch(request(), new AbortController().signal)).rejects.toMatchObject({
    code: "launch_failure",
  });
  expect(fallbackLaunches).toBe(0);
});

it("rejects Linux evidence when the delegated cgroup was not verified", async () => {
  const launcher = createNativeContainmentLauncher(
    brokerThatReturns({
      backend: "linux-landlock-seccomp",
      cgroupDelegated: false,
      landlockAbi: 3,
      noNewPrivileges: true,
      seccompFilter: true,
    }),
    "linux",
  );

  await expect(launcher.launch(request(), new AbortController().signal)).rejects.toMatchObject({
    code: "launch_failure",
  });
});

function request() {
  return parseSidecarSessionRequest({
    jobId: "job-contained",
    manifestHash: "a".repeat(64),
    nonce: "nonce-contained",
    requestId: "request-contained",
    timeoutMs: 2_000,
  });
}

function testPlatform(): NativeContainmentPlatform {
  if (process.platform === "darwin" || process.platform === "win32") return process.platform;
  return "linux";
}

function validEvidence(): NativeContainmentEvidence {
  if (testPlatform() === "darwin") {
    return {
      appSandbox: true,
      backend: "macos-xpc-app-sandbox",
      helperInheritance: true,
      networkClient: false,
      networkServer: false,
    };
  }
  if (testPlatform() === "win32") {
    return {
      appContainer: true,
      backend: "windows-appcontainer-job",
      breakawayDisabled: true,
      jobObject: true,
      networkCapabilityCount: 0,
    };
  }
  return {
    backend: "linux-landlock-seccomp",
    cgroupDelegated: true,
    landlockAbi: 3,
    noNewPrivileges: true,
    seccompFilter: true,
  };
}

function brokerThatReturns(evidence: NativeContainmentEvidence): NativeContainmentBroker {
  return {
    async launchAndVerify(sessionRequest, signal) {
      const proof = createUncontainedSpawnLauncherForProof({
        args: [resolve(fixtureRoot, "fake-sidecar.mjs")],
        cwd: process.cwd(),
        env: {},
        executablePath: process.execPath,
      });
      return { evidence, process: await proof.launch(sessionRequest, signal) };
    },
  };
}

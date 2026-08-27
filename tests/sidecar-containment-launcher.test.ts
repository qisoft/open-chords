import { readFileSync } from "node:fs";
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
import { isExpectedWindowsProfileRoot } from "../apps/desktop/src/main/windows-app-container-path.ts";

const fixtureRoot = resolve("tests/fixtures");

it("assigns the Windows containment job atomically during process creation", () => {
  const source = readFileSync("native/windows/containment-launcher.cpp", "utf8");

  expect(source).toContain("PROC_THREAD_ATTRIBUTE_JOB_LIST");
  expect(source).not.toContain("AssignProcessToJobObject(");
});

it("makes Windows AppContainer profile destruction idempotent", () => {
  const source = readFileSync("native/windows/containment-launcher.cpp", "utf8");

  expect(source).toContain("HRESULT_FROM_WIN32(ERROR_NOT_FOUND)");
  expect(source).toContain("HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND)");
});

it("supplies the minimal sorted Windows and AppContainer environment", () => {
  const source = readFileSync("native/windows/containment-launcher.cpp", "utf8");
  const entries = [
    "APPDATA=",
    "HOME=",
    "LOCALAPPDATA=",
    "PATH=",
    "SystemRoot=",
    "TEMP=",
    "TMP=",
    "USERPROFILE=",
  ];
  const positions = entries.map((entry) => source.indexOf(`append_variable(L"${entry}`));

  expect(positions.every((position) => position >= 0)).toBe(true);
  expect(positions).toEqual([...positions].sort((left, right) => left - right));
  expect(source).toContain('append_variable(L"LOCALAPPDATA=" + workspace);');
});

it("accepts recursive cleanup only for a canonical AppContainer AC root", () => {
  const packagesRoot = String.raw`C:\Users\Alice\AppData\Local\Packages`;

  expect(
    isExpectedWindowsProfileRoot(
      String.raw`C:\Users\Alice\AppData\Local\Packages\OpenChords.Analysis_hash\AC`,
      packagesRoot,
    ),
  ).toBe(true);
  expect(isExpectedWindowsProfileRoot(packagesRoot, packagesRoot)).toBe(false);
  expect(isExpectedWindowsProfileRoot(String.raw`D:\AC`, packagesRoot)).toBe(false);
  expect(isExpectedWindowsProfileRoot(String.raw`\\server\share\profile\AC`, packagesRoot)).toBe(
    false,
  );
  expect(
    isExpectedWindowsProfileRoot(String.raw`C:\Users\Alice\AppData\Local\AC`, packagesRoot),
  ).toBe(false);
  expect(isExpectedWindowsProfileRoot(String.raw`C:\Users\Alice\Documents\AC`, packagesRoot)).toBe(
    false,
  );
  expect(
    isExpectedWindowsProfileRoot(
      String.raw`C:\Users\Alice\AppData\Local\Packages\profile\AC\nested`,
      packagesRoot,
    ),
  ).toBe(false);
  expect(
    isExpectedWindowsProfileRoot(
      String.raw`C:\Users\Alice\AppData\Local\Packages\profile\..\..\Documents\AC`,
      packagesRoot,
    ),
  ).toBe(false);
  expect(isExpectedWindowsProfileRoot("relative\\profile\\AC", packagesRoot)).toBe(false);
});

it("surfaces bounded native containment failure reasons", () => {
  expect(parseNativeContainmentFailure('{"error":"helper_signature_create_failed"}')).toBe(
    "helper_signature_create_failed",
  );
  expect(parseNativeContainmentFailure('{"error":"service_bundle_validation_failed_-67030"}')).toBe(
    "service_bundle_validation_failed_-67030",
  );
  expect(parseNativeContainmentFailure('{"error":"invalid reason"}')).toBeNull();
});

it("does not log raw packaged-proof errors or paths", () => {
  const source = readFileSync("apps/desktop/src/main/index.ts", "utf8");

  expect(source).toContain("packagedProofFailureCode(cause)");
  expect(source).not.toContain("cause.stack");
  expect(source).not.toContain("cause.message");
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
  let brokerCalls = 0;
  const broker: NativeContainmentBroker = {
    async launchAndVerify() {
      brokerCalls += 1;
      throw new SidecarSessionError("launch_failure", "Native setup failed");
    },
  };
  const launcher = createNativeContainmentLauncher(broker, testPlatform());

  await expect(launcher.launch(request(), new AbortController().signal)).rejects.toMatchObject({
    code: "launch_failure",
  });
  expect(brokerCalls).toBe(1);
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

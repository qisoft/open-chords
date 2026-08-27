import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { expect, it } from "vitest";

import {
  createNativeContainmentLauncher,
  type NativeContainmentBroker,
  type NativeContainmentEvidence,
  type NativeContainmentPlatform,
} from "../apps/desktop/src/main/sidecar-containment-launcher.ts";
import {
  containedExitWasAccepted,
  createBoundedSidecarStderrCapture,
  parseNativeContainmentFailure,
  parseSidecarProcessFailure,
} from "../apps/desktop/src/main/sidecar-native-broker.ts";
import {
  createPromiseSidecarClient,
  createUncontainedSpawnLauncherForProof,
  parseSidecarSessionRequest,
  SidecarSessionError,
} from "../apps/desktop/src/main/sidecar-session.ts";
import {
  isExpectedWindowsProfileRoot,
  isExpectedWindowsRuntimeRoot,
} from "../apps/desktop/src/main/windows-app-container-path.ts";

const fixtureRoot = resolve("tests/fixtures");

it("assigns the Windows containment job atomically during process creation", () => {
  const source = readFileSync("native/windows/containment-launcher.cpp", "utf8");

  expect(source).toContain("PROC_THREAD_ATTRIBUTE_JOB_LIST");
  expect(source).not.toContain("AssignProcessToJobObject(");
});

it("keeps required helpers inside the inherited AppContainer and job", () => {
  const source = readFileSync("native/windows/containment-launcher.cpp", "utf8");

  expect(source).toContain("PROC_THREAD_ATTRIBUTE_CHILD_PROCESS_POLICY");
  expect(source).toContain("PROCESS_CREATION_CHILD_PROCESS_OVERRIDE");
  expect(source).toContain("PROC_THREAD_ATTRIBUTE_JOB_LIST");
  expect(source).toContain("JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE");
  expect(source).toContain("JOB_OBJECT_LIMIT_ACTIVE_PROCESS");
  expect(source).not.toContain("CREATE_BREAKAWAY_FROM_JOB");
});

it("accepts only the exact per-profile Windows runtime staging root", () => {
  const localAppData = String.raw`C:\Users\Alice\AppData\Local`;
  const profile = "OpenChords.Analysis.1234";

  expect(
    isExpectedWindowsRuntimeRoot(
      String.raw`C:\Users\Alice\AppData\Local\OpenChords\ContainmentRuntime\OpenChords.Analysis.1234`,
      localAppData,
      profile,
    ),
  ).toBe(true);
  expect(
    isExpectedWindowsRuntimeRoot(
      String.raw`C:\Users\Alice\AppData\Local\OpenChords\ContainmentRuntime\other`,
      localAppData,
      profile,
    ),
  ).toBe(false);
  expect(
    isExpectedWindowsRuntimeRoot(
      String.raw`C:\Users\Alice\AppData\Local\OpenChords\..\Secrets\OpenChords.Analysis.1234`,
      localAppData,
      profile,
    ),
  ).toBe(false);
});

it("releases the Windows attribute list at every initialized failure seam", () => {
  const source = readFileSync("native/windows/containment-launcher.cpp", "utf8");
  const firstUpdateFailure = source.slice(
    source.indexOf("if (!UpdateProcThreadAttribute(attributes"),
    source.indexOf("STARTUPINFOEXW startup"),
  );

  expect(firstUpdateFailure).toContain("DeleteProcThreadAttributeList(attributes);");
  expect(firstUpdateFailure).toContain("HeapFree(GetProcessHeap(), 0, attributes);");
});

it("makes Windows AppContainer profile destruction idempotent", () => {
  const source = readFileSync("native/windows/containment-launcher.cpp", "utf8");

  expect(source).toContain("HRESULT_FROM_WIN32(ERROR_NOT_FOUND)");
  expect(source).toContain("HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND)");
  expect(source).toContain("remove_runtime_staging_root(profile)");
  expect(source).toContain("reject_reparse_points(root);");
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

it("grants the AppContainer read and execute access only to its verified runtime tree", () => {
  const source = readFileSync("native/windows/containment-launcher.cpp", "utf8");

  expect(source).toContain("grant_runtime_read_execute(runtime_root, sid);");
  expect(source).toContain("FILE_GENERIC_READ | FILE_GENERIC_EXECUTE");
  expect(source).toContain("SUB_CONTAINERS_AND_OBJECTS_INHERIT");
  expect(source).toContain("SET_ACCESS");
  expect(source).toContain("PROTECTED_DACL_SECURITY_INFORMATION");
  expect(source).toContain("SetNamedSecurityInfoW");
  expect(source).not.toContain("FILE_GENERIC_WRITE");
  expect(source.indexOf("reject_reparse_points(runtime_root);")).toBeLessThan(
    source.indexOf("grant_runtime_read_execute(runtime_root, sid);"),
  );
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

it("surfaces only allowlisted bounded sidecar crash reasons", () => {
  expect(
    parseSidecarProcessFailure(
      "Open Chords analysis sidecar failed safely: sidecar_protocol_error\n",
    ),
  ).toBe("sidecar_protocol_error");
  expect(
    parseSidecarProcessFailure("Open Chords analysis sidecar failed safely: sidecar_secret_path\n"),
  ).toBeNull();
});

it("caps sidecar stderr and rejects markers after overflow even when kill does not finish", () => {
  let killRequests = 0;
  const capture = createBoundedSidecarStderrCapture(() => {
    killRequests += 1;
  });
  capture.append(Buffer.alloc(64 * 1024 - 8, 0x78));
  capture.append(
    Buffer.from("overflow\nOpen Chords analysis sidecar failed safely: sidecar_protocol_error\n"),
  );
  capture.append(Buffer.alloc(128 * 1024, 0x79));

  const snapshot = capture.snapshot();
  expect(snapshot.bytes.byteLength).toBe(64 * 1024);
  expect(snapshot.exceeded).toBe(true);
  expect(killRequests).toBe(1);
  expect(parseSidecarProcessFailure(snapshot.bytes.toString("utf8"), snapshot.exceeded)).toBeNull();
});

it("accepts the intentional crash code only when the main-owned probe declares it", () => {
  const status = { code: 73, signal: null };
  expect(containedExitWasAccepted(status, [0])).toBe(false);
  expect(containedExitWasAccepted(status, [73])).toBe(true);
  expect(containedExitWasAccepted({ code: 0, signal: null }, [73])).toBe(false);
  expect(containedExitWasAccepted({ code: null, signal: "SIGKILL" }, [73])).toBe(false);
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

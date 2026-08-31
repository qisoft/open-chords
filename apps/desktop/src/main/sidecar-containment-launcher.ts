import {
  SidecarSessionError,
  type SidecarProcess,
  type SidecarProcessLauncher,
  type SidecarSessionRequest,
} from "./sidecar-protocol.ts";

export type NativeContainmentPlatform = "darwin" | "linux" | "win32";

export type NativeContainmentEvidence =
  | {
      readonly appSandbox: true;
      readonly backend: "macos-xpc-app-sandbox";
      readonly helperInheritance: true;
      readonly networkClient: false;
      readonly networkServer: false;
    }
  | {
      readonly appContainer: true;
      readonly backend: "windows-appcontainer-job";
      readonly breakawayDisabled: true;
      readonly jobObject: true;
      readonly networkCapabilityCount: 0;
    }
  | {
      readonly backend: "linux-landlock-seccomp";
      readonly cgroupDelegated: boolean;
      readonly landlockAbi: number;
      readonly noNewPrivileges: true;
      readonly seccompFilter: true;
    }
  | { readonly backend: "uncontained" };

export interface NativeContainmentBroker {
  launchAndVerify(
    request: SidecarSessionRequest,
    signal: AbortSignal,
  ): Promise<{ evidence: NativeContainmentEvidence; process: SidecarProcess }>;
}

/**
 * Production boundary. The native broker must establish and inspect the OS
 * containment domain before returning its process. There is deliberately no
 * generic-spawn implementation or compatibility fallback in this module.
 */
export function createNativeContainmentLauncher(
  broker: NativeContainmentBroker,
  platform: NativeContainmentPlatform,
): SidecarProcessLauncher {
  return {
    async launch(request, signal) {
      const launched = await broker.launchAndVerify(request, signal);
      if (!evidenceSatisfiesPlatform(launched.evidence, platform)) {
        await launched.process.stop("launch_failure").catch(() => undefined);
        throw new SidecarSessionError(
          "launch_failure",
          "Native containment could not be established and verified",
        );
      }
      return launched.process;
    },
  };
}

function evidenceSatisfiesPlatform(
  evidence: NativeContainmentEvidence,
  platform: NativeContainmentPlatform,
): boolean {
  if (platform === "darwin") {
    return (
      evidence.backend === "macos-xpc-app-sandbox" &&
      evidence.appSandbox &&
      evidence.helperInheritance &&
      !evidence.networkClient &&
      !evidence.networkServer
    );
  }
  if (platform === "win32") {
    return (
      evidence.backend === "windows-appcontainer-job" &&
      evidence.appContainer &&
      evidence.jobObject &&
      evidence.breakawayDisabled &&
      evidence.networkCapabilityCount === 0
    );
  }
  return (
    evidence.backend === "linux-landlock-seccomp" &&
    evidence.cgroupDelegated &&
    evidence.landlockAbi >= 3 &&
    evidence.noNewPrivileges &&
    evidence.seccompFilter
  );
}

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  isExpectedWindowsProfileRoot,
  isExpectedWindowsRuntimeRoot,
} from "./windows-app-container-path.ts";

const WORKSPACE_FAILURE_CODES = [
  "cleanup_failed",
  "setup_prepare_failed",
  "setup_response_failed",
  "setup_validation_failed",
  "setup_workspace_failed",
] as const;

type WorkspaceFailureCode = (typeof WORKSPACE_FAILURE_CODES)[number];

class PackagedWorkspaceFailure extends Error {
  readonly code: WorkspaceFailureCode;

  constructor(code: WorkspaceFailureCode) {
    super(code);
    this.name = "PackagedWorkspaceFailure";
    this.code = code;
  }
}

export interface PreparedPackagedWorkspace {
  cleanup(): void;
  runtimeRoot: string;
  windowsProfile?: string;
  workspace: string;
}

export function packagedWorkspaceFailureCode(cause: unknown): WorkspaceFailureCode | undefined {
  return cause instanceof PackagedWorkspaceFailure ? cause.code : undefined;
}

export function preparePackagedWorkspace(
  platform: "darwin" | "win32",
  helperPath: string,
  packagedRuntimeRoot: string,
): PreparedPackagedWorkspace {
  const identifier = randomUUID();
  if (platform === "darwin") {
    const workspace = join(
      homedir(),
      "Library",
      "Containers",
      "io.github.qisoft.open-chords.analysis-service",
      "Data",
      "jobs",
      identifier,
    );
    mkdirSync(workspace, { recursive: true, mode: 0o700 });
    return {
      cleanup: () => rmSync(workspace, { force: true, recursive: true }),
      runtimeRoot: packagedRuntimeRoot,
      workspace,
    };
  }
  const profile = `OpenChords.Analysis.${identifier}`;
  let reportedRoots: string[];
  try {
    reportedRoots = execFileSync(helperPath, [`--prepare=${profile}`], {
      encoding: "utf8",
      env: {},
      windowsHide: true,
    })
      .trim()
      .split(/\r?\n/);
  } catch {
    throwWorkspaceFailures(
      "AppContainer profile preparation and cleanup failed",
      { cause: new PackagedWorkspaceFailure("setup_prepare_failed") },
      privateCleanupFailures(destroyWindowsProfile(helperPath, profile)),
    );
    throw new PackagedWorkspaceFailure("setup_prepare_failed");
  }
  if (reportedRoots.length !== 3) {
    throwWorkspaceFailures(
      "AppContainer profile response and cleanup failed",
      { cause: new PackagedWorkspaceFailure("setup_response_failed") },
      privateCleanupFailures(destroyWindowsProfile(helperPath, profile)),
    );
    throw new PackagedWorkspaceFailure("setup_response_failed");
  }
  const reportedProfileRoot = reportedRoots[0]!;
  const reportedLocalAppDataRoot = reportedRoots[1]!;
  const reportedRuntimeRoot = reportedRoots[2]!;
  const localAppDataRoot = canonicalWindowsLocalAppDataRoot(reportedLocalAppDataRoot);
  const profileRoot = canonicalWindowsProfileRoot(reportedProfileRoot, localAppDataRoot);
  const runtimeRoot = canonicalWindowsRuntimeRoot(reportedRuntimeRoot, localAppDataRoot, profile);
  if (profileRoot === null || runtimeRoot === null) {
    throwWorkspaceFailures(
      "AppContainer profile validation and cleanup failed",
      { cause: new PackagedWorkspaceFailure("setup_validation_failed") },
      privateCleanupFailures(destroyWindowsProfile(helperPath, profile)),
    );
    throw new PackagedWorkspaceFailure("setup_validation_failed");
  }
  const workspace = join(profileRoot, "jobs", identifier);
  try {
    cpSync(packagedRuntimeRoot, runtimeRoot, { recursive: true });
    mkdirSync(workspace, { recursive: true });
  } catch {
    throwWorkspaceFailures(
      "AppContainer workspace setup and cleanup failed",
      { cause: new PackagedWorkspaceFailure("setup_workspace_failed") },
      privateCleanupFailures(destroyWindowsProfile(helperPath, profile)),
    );
  }
  return {
    cleanup() {
      throwWorkspaceFailures(
        "AppContainer profile cleanup failed",
        undefined,
        destroyWindowsProfile(helperPath, profile),
      );
    },
    runtimeRoot,
    windowsProfile: profile,
    workspace,
  };
}

function canonicalWindowsLocalAppDataRoot(reportedRoot: string): string | null {
  try {
    return realpathSync(reportedRoot);
  } catch {
    return null;
  }
}

function canonicalWindowsProfileRoot(
  reportedRoot: string,
  localAppDataRoot: string | null,
): string | null {
  if (localAppDataRoot === null) return null;
  try {
    const packagesRoot = realpathSync(join(localAppDataRoot, "Packages"));
    const profileRoot = realpathSync(reportedRoot);
    return isExpectedWindowsProfileRoot(profileRoot, packagesRoot) ? profileRoot : null;
  } catch {
    return null;
  }
}

function canonicalWindowsRuntimeRoot(
  reportedRoot: string,
  localAppDataRoot: string | null,
  profile: string,
): string | null {
  if (localAppDataRoot === null) return null;
  try {
    const runtimeRoot = realpathSync(reportedRoot);
    return isExpectedWindowsRuntimeRoot(runtimeRoot, localAppDataRoot, profile)
      ? runtimeRoot
      : null;
  } catch {
    return null;
  }
}

function privateCleanupFailures(failures: readonly unknown[]): PackagedWorkspaceFailure[] {
  return failures.map(() => new PackagedWorkspaceFailure("cleanup_failed"));
}

function destroyWindowsProfile(helperPath: string, profile: string): unknown[] {
  const failures: unknown[] = [];
  try {
    execFileSync(helperPath, [`--destroy=${profile}`], {
      env: {},
      windowsHide: true,
    });
  } catch (cause) {
    failures.push(cause);
  }
  return failures;
}

function throwWorkspaceFailures(
  message: string,
  primaryFailure: { cause: unknown } | undefined,
  cleanupFailures: readonly unknown[],
): void {
  const failures = [
    ...(primaryFailure === undefined ? [] : [primaryFailure.cause]),
    ...cleanupFailures,
  ];
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, message);
}

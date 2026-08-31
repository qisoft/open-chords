import { beforeAll, expect, it, vi } from "vitest";

import { SidecarSessionError } from "../apps/desktop/src/main/sidecar-session.ts";

type PackagedProofModule = typeof import("../apps/desktop/src/main/packaged-sidecar-proof.ts");

let packagedProofModule: PackagedProofModule | undefined;

beforeAll(async () => {
  vi.stubGlobal("OPEN_CHORDS_EMBEDDED_CONTAINMENT_MANIFEST_SHA256", "0".repeat(64));
  vi.stubGlobal("OPEN_CHORDS_EMBEDDED_SIDECAR_MANIFEST_SHA256", "0".repeat(64));
  packagedProofModule = await import("../apps/desktop/src/main/packaged-sidecar-proof.ts");
});

function packagedProof(): PackagedProofModule {
  if (packagedProofModule === undefined) throw new Error("Packaged proof module was not loaded");
  return packagedProofModule;
}

it("classifies a packaged session dispose failure without masking it as evidence", async () => {
  const { packagedProofFailureCode, runWithPackagedSessionCleanup } = packagedProof();
  const failure = await runWithPackagedSessionCleanup(
    async () => undefined,
    async () => {
      throw new SidecarSessionError("cleanup_failure", "injected cleanup failure");
    },
  ).catch((cause: unknown) => cause);

  expect(packagedProofFailureCode(failure)).toBe("session_cleanup_failure");
});

it("preserves a packaged session primary failure alongside dispose failure", async () => {
  const { packagedProofFailureCode, runWithPackagedSessionCleanup } = packagedProof();
  const primary = new SidecarSessionError("unexpected_eof", "injected session failure");
  const failure = await runWithPackagedSessionCleanup(
    async () => {
      throw primary;
    },
    async () => {
      throw new SidecarSessionError("cleanup_failure", "injected cleanup failure");
    },
  ).catch((cause: unknown) => cause);

  expect(failure).toBeInstanceOf(AggregateError);
  if (!(failure instanceof AggregateError)) throw new Error("Expected combined failure");
  expect(failure.errors).toContain(primary);
  expect(packagedProofFailureCode(failure)).toBe("proof_and_cleanup_failed");
});

it("preserves a safe sidecar process marker during adversarial probes", () => {
  const { sessionFailureCode } = packagedProof();
  const failure = new SidecarSessionError("process_failure", "sidecar exited", {
    remoteCode: "sidecar_runtime_root_permission_denied",
  });

  expect(sessionFailureCode("adversarial_probe_failed", failure)).toBe(
    "session_sidecar_runtime_root_permission_denied",
  );
});

it.each([
  "adversarial_launch_failed",
  "adversarial_output_failed",
  "adversarial_output_invalid",
  "adversarial_evidence_invalid",
] as const)("preserves the adversarial stage marker %s for generic failures", (stage) => {
  const { sessionFailureCode } = packagedProof();

  expect(sessionFailureCode(stage, new Error("private diagnostic"))).toBe(stage);
});

it("preserves a validated native containment launch marker", () => {
  const { sessionFailureCode } = packagedProof();
  const failure = new SidecarSessionError("launch_failure", "native launch rejected", {
    remoteCode: "containment_setup_failed_create_contained_process-5",
  });

  expect(sessionFailureCode("adversarial_launch_failed", failure)).toBe(
    "adversarial_containment_setup_failed_create_contained_process-5",
  );
});

it("does not expose an unvalidated native containment launch marker", () => {
  const { sessionFailureCode } = packagedProof();
  const failure = new SidecarSessionError("launch_failure", "native launch rejected", {
    remoteCode: "private diagnostic",
  });

  expect(sessionFailureCode("adversarial_launch_failed", failure)).toBe(
    "adversarial_launch_failed",
  );
});

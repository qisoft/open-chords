import { expect, it } from "vitest";

import {
  acquisitionProofFailureChain,
  acquisitionProofFailureCode,
} from "../apps/desktop/src/main/acquisition-proof-diagnostics.ts";
import { AcquisitionSessionError } from "../apps/desktop/src/main/acquisition-session.ts";
import { SidecarSessionError } from "../apps/desktop/src/main/sidecar-protocol.ts";

it("reports fixed failure categories without leaking messages, arbitrary codes or cause data", () => {
  expect(acquisitionProofFailureCode(new AcquisitionSessionError("protocol_violation"))).toBe(
    "protocol_violation",
  );
  expect(
    acquisitionProofFailureCode(
      new SidecarSessionError("process_failure", "private-path private-token"),
    ),
  ).toBe("process_failure");
  expect(acquisitionProofFailureCode(new Error("acquisition_runtime_unavailable"))).toBe(
    "runtime_unavailable",
  );
  expect(
    acquisitionProofFailureCode(Object.assign(new Error("private-path"), { code: "ENOENT" })),
  ).toBe("ENOENT");
  expect(
    acquisitionProofFailureCode(Object.assign(new Error("private-token"), { code: "private-url" })),
  ).toBe("unknown");
  expect(acquisitionProofFailureCode(new Error("private-path private-token"))).toBe("unknown");
});

it("retains primary failure categories behind cleanup without exposing private cause details", () => {
  const primary = new Error("acquisition_runtime_unavailable");
  const failure = new AcquisitionSessionError("cleanup_failure", { cause: primary });
  expect(acquisitionProofFailureChain(failure)).toBe("cleanup_failure[runtime_unavailable]");
  expect(
    acquisitionProofFailureChain(
      new AggregateError([failure, new Error("private-path private-token")], "private-response"),
    ),
  ).toBe("unknown[cleanup_failure[runtime_unavailable],unknown]");
  expect(
    acquisitionProofFailureChain(
      new Error("private-helper", { cause: { exitCode: -1073741515, stderr: "private-response" } }),
    ),
  ).toBe("unknown[exit_-1073741515]");
  const cyclic = new Error("private-path");
  Object.defineProperty(cyclic, "cause", { value: cyclic });
  expect(acquisitionProofFailureChain(cyclic)).toBe(
    "unknown[unknown[unknown[unknown[truncated]]]]",
  );
});

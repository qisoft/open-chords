import { expect, it } from "vitest";

import { acquisitionProofFailureCode } from "../apps/desktop/src/main/acquisition-proof-diagnostics.ts";
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

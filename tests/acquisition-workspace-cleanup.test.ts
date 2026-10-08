import { expect, it } from "vitest";

import { rethrowAfterAcquisitionCleanup } from "../apps/desktop/src/main/acquisition-workspace-cleanup.ts";

it("preserves an initialization failure behind the public cleanup refusal", () => {
  const primary = new Error("private-runtime-failure");
  let received: unknown;
  try {
    rethrowAfterAcquisitionCleanup(primary, {
      cleanup() {
        throw new Error("private-cleanup-path");
      },
    });
  } catch (error) {
    received = error;
  }
  expect(received).toMatchObject({
    code: "cleanup_failure",
    message: "cleanup_failure",
    cause: primary,
  });
});

it("rethrows the original initialization failure when cleanup succeeds", () => {
  const primary = new Error("private-runtime-failure");
  expect(() => rethrowAfterAcquisitionCleanup(primary, { cleanup() {} })).toThrow(primary);
});

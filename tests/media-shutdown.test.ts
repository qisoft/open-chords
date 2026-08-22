import { expect, it } from "vitest";

import { createMediaCleanupBeforeQuitHandler } from "../apps/desktop/src/main/media-shutdown.ts";

it("prevents repeated quit attempts until media cleanup completes", async () => {
  let completeCleanup!: () => void;
  const cleanup = new Promise<void>((resolve) => {
    completeCleanup = resolve;
  });
  let exitCalls = 0;
  let quitCalls = 0;
  const handler = createMediaCleanupBeforeQuitHandler({
    dispose: () => cleanup,
    exitWithFailure: () => {
      exitCalls += 1;
    },
    quit: () => {
      quitCalls += 1;
    },
    timeoutMs: 5_000,
  });
  let firstPrevented = 0;
  let secondPrevented = 0;
  handler({ preventDefault: () => (firstPrevented += 1) });
  handler({ preventDefault: () => (secondPrevented += 1) });

  expect(firstPrevented).toBe(1);
  expect(secondPrevented).toBe(1);
  expect(quitCalls).toBe(0);
  completeCleanup();
  await cleanup;
  await Promise.resolve();
  expect(quitCalls).toBe(1);
  expect(exitCalls).toBe(0);

  let finalPrevented = 0;
  handler({ preventDefault: () => (finalPrevented += 1) });
  expect(finalPrevented).toBe(0);
});

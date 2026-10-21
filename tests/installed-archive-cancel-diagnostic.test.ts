import { afterEach, expect, it, vi } from "vitest";

import { installedArchiveCancelDiagnostic } from "./support/installed-archive-cancel-diagnostic.ts";

afterEach(() => vi.useRealTimers());
it.each([true, false, "unknown"] as const)(
  "reports only the fixed Cancel observation %s",
  async (cancelled) => {
    const read = vi.fn<() => Promise<unknown>>(async () => ({ cancelled, buttonEnabled: true }));
    expect(await installedArchiveCancelDiagnostic(read)).toBe(
      `Native archive Cancel result probe: status=complete cancelled=${String(cancelled)} button_enabled=true`,
    );
    expect(read).toHaveBeenCalledTimes(1);
  },
);
it.each([
  null,
  [],
  "deadline",
  { cancelled: "private", buttonEnabled: true },
  { cancelled: true },
  { cancelled: true, buttonEnabled: true, path: "/private/path" },
])("refuses malformed renderer observation %j without leaking its values", async (value) => {
  expect(await installedArchiveCancelDiagnostic(async () => value)).toBe(
    "Native archive Cancel result probe: status=unavailable cancelled=unknown button_enabled=unknown",
  );
});
it("redacts renderer read failures", async () => {
  expect(
    await installedArchiveCancelDiagnostic(async () => {
      throw new Error("/private/path");
    }),
  ).toBe(
    "Native archive Cancel result probe: status=unavailable cancelled=unknown button_enabled=unknown",
  );
});
it("bounds a stalled read at one second without another read", async () => {
  vi.useFakeTimers();
  const read = vi.fn<() => Promise<unknown>>(() => new Promise<unknown>(() => {}));
  const result = installedArchiveCancelDiagnostic(read);
  await vi.advanceTimersByTimeAsync(1000);
  expect(await result).toBe(
    "Native archive Cancel result probe: status=deadline cancelled=unknown button_enabled=unknown",
  );
  expect(read).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});
it("clears the timer after a successful observation", async () => {
  vi.useFakeTimers();
  await installedArchiveCancelDiagnostic(async () => ({
    cancelled: false,
    buttonEnabled: "unknown",
  }));
  expect(vi.getTimerCount()).toBe(0);
});

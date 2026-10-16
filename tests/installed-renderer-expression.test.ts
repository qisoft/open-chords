import { runInNewContext } from "node:vm";

import { expect, it, vi } from "vitest";

import { installedRendererExpression } from "./support/installed-renderer-expression.ts";

function evaluate(expression: string, window: object, document: object): Promise<unknown> {
  const result: unknown = runInNewContext(installedRendererExpression(expression), {
    window,
    document,
    Date,
    setTimeout,
  });
  return Promise.resolve(result);
}

it("waits for a late DOM root even when preload is already exposed", async () => {
  vi.useFakeTimers();
  try {
    const window = { openChords: {} };
    const document: { documentElement: null | { dataset: { marker: string } } } = {
      documentElement: null,
    };
    const result = evaluate("document.documentElement.dataset.marker", window, document).then(
      (value) => value,
      () => "failed",
    );
    await vi.advanceTimersByTimeAsync(20);
    document.documentElement = { dataset: { marker: "ready" } };
    await vi.advanceTimersByTimeAsync(25);
    expect(await result).toBe("ready");
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});

it("fails within the existing prerequisite budget without evaluating an unsafe body", async () => {
  vi.useFakeTimers();
  try {
    const window = { openChords: {}, bodyRan: false };
    const result = evaluate("(window.bodyRan = true)", window, { documentElement: null }).then(
      () => "completed",
      () => "failed",
    );
    await vi.advanceTimersByTimeAsync(10000);
    expect(await result).toBe("failed");
    expect(window.bodyRan).toBe(false);
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});

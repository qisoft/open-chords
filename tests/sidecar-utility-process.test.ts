import { EventEmitter } from "node:events";

import { describe, expect, it } from "vitest";

import {
  observeUtilityExit,
  waitForUtilitySpawn,
  type UtilityProcessHandle,
} from "../apps/desktop/src/main/sidecar-utility-process.ts";

class DelayedUtilityProcess extends EventEmitter implements UtilityProcessHandle {
  pid: number | undefined;
  killCalls = 0;

  kill(): boolean {
    this.killCalls += 1;
    if (this.pid === undefined) return false;
    this.pid = undefined;
    queueMicrotask(() => this.emit("exit", 0));
    return true;
  }

  spawn(): void {
    this.pid = 42;
    this.emit("spawn");
  }
}

describe("utility-process lifecycle", () => {
  it("kills on delayed spawn and awaits reap after an acquisition abort", async () => {
    const child = new DelayedUtilityProcess();
    const controller = new AbortController();
    const exited = observeUtilityExit(child);
    let settled = false;
    const result = waitForUtilitySpawn(child, exited, controller.signal, 100)
      .catch((error: unknown) => error)
      .finally(() => {
        settled = true;
      });

    controller.abort(new Error("cancelled"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    child.spawn();

    await expect(result).resolves.toMatchObject({ message: "cancelled" });
    expect(child.killCalls).toBeGreaterThan(0);
    expect(child.pid).toBeUndefined();
  });

  it("bounds an aborted launch that emits neither spawn nor exit", async () => {
    const child = new DelayedUtilityProcess();
    const controller = new AbortController();
    const exited = observeUtilityExit(child);
    const result = waitForUtilitySpawn(child, exited, controller.signal, 5).catch(
      (error: unknown) => error,
    );

    controller.abort(new Error("cancelled"));

    await expect(result).resolves.toMatchObject({ code: "cleanup_failure" });
    child.spawn();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(child.killCalls).toBeGreaterThan(0);
    expect(child.pid).toBeUndefined();
  });
});

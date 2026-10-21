import { EventEmitter } from "node:events";

import type { ElectronApplication } from "@playwright/test";
import { expect, it, vi } from "vitest";

import {
  rendererShutdownCollector,
  installRendererShutdownProbe,
} from "./support/renderer-shutdown-probe.ts";

it("reassembles split fixed events and never prints private process output", () => {
  const output: string[] = [];
  const collect = rendererShutdownCollector((line) => output.push(line));
  collect("/private/path\nYouTube shutdown ev");
  collect("ent: event=before_quit kind=app\r\n");
  collect("YouTube shutdown event: event=private kind=app\n");
  collect("YouTube shutdown event: event=quit kind=/private/window\n");
  collect("YouTube shutdown event: event=quit kind=app /private/path\n");
  collect("/private/unterminated");
  collect("\nYouTube shutdown event: event=process_exit kind=process\n");
  expect(output).toEqual([
    "YouTube shutdown event: event=before_quit kind=app",
    "YouTube shutdown event: event=process_exit kind=process",
  ]);
});

it("discards an oversized line and its apparently valid suffix, then recovers", () => {
  const output: string[] = [];
  const collect = rendererShutdownCollector((line) => output.push(line));
  const line = "YouTube shutdown event: event=quit kind=app";
  collect("x".repeat(4097));
  collect(line + "\n" + line + "\n");
  expect(output).toEqual([line]);
});

it("bounds retained events even across many chunks", () => {
  const output: string[] = [];
  const collect = rendererShutdownCollector((line) => output.push(line));
  for (let i = 0; i < 50; i++)
    collect("YouTube shutdown event: event=window_closed kind=created\n");
  expect(output).toHaveLength(32);
});

it("accepts only fixed quit prevention and event-loop checkpoints", () => {
  const output: string[] = [];
  const collect = rendererShutdownCollector((line) => output.push(line));
  const events = [
    "quit_call",
    "quit_return",
    "exit_call",
    "exit_return",
    "quit_prevented",
    "quit_allowed",
    "quit_loop_100ms",
    "quit_loop_1s",
    "quit_loop_5s",
  ];
  for (const event of events) {
    collect(`YouTube shutdown event: event=${event} kind=app\n`);
    collect(`YouTube shutdown event: event=${event} kind=app /private/path\n`);
  }
  collect("YouTube shutdown event: event=quit_loop_30s kind=app\n");
  expect(output).toEqual(events.map((event) => `YouTube shutdown event: event=${event} kind=app`));
});

it("observes window close/destroy without retrying or swallowing native failures", async () => {
  const nativeFailure = new Error("native-close-failure");
  const nativePromise = Promise.resolve();
  class Window extends EventEmitter {
    session = {
      calls: 0,
      closeAllConnections() {
        this.calls++;
        return nativePromise;
      },
      clearStorageData(options?: { storages: string[] }) {
        this.calls++;
        return options;
      },
      clearCache() {
        this.calls++;
        throw nativeFailure;
      },
    };
    webContents = Object.assign(new EventEmitter(), { session: this.session });
    closes = 0;
    destroys = 0;
    failClose = false;
    close() {
      this.closes++;
      if (this.failClose) throw nativeFailure;
    }
    destroy() {
      this.destroys++;
    }
    static getAllWindows() {
      return [window];
    }
  }
  const window = new Window();
  const app = Object.assign(new EventEmitter(), { quit() {}, exit() {} });
  const child = Object.assign(new EventEmitter(), { stderr: new EventEmitter() });
  const application = Object.assign(new EventEmitter(), {
    process: () => child,
    evaluate: async (
      callback: (context: { app: typeof app; BrowserWindow: typeof Window }) => unknown,
    ) => callback({ app, BrowserWindow: Window }),
  });
  const output: string[] = [];
  const write = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    output.push(String(chunk));
    return true;
  });
  try {
    // The structural test double executes the probe callback without starting Electron.
    // eslint-disable-next-line typescript/no-unsafe-type-assertion
    await installRendererShutdownProbe(application as unknown as ElectronApplication);
    window.close();
    window.destroy();
    window.failClose = true;
    expect(() => window.close()).toThrow(nativeFailure);
    expect(window.closes).toBe(2);
    expect(window.destroys).toBe(1);
    expect(output).toEqual(
      [
        "window_close_call",
        "window_close_return",
        "window_destroy_call",
        "window_destroy_return",
        "window_close_call",
        "window_close_return",
      ].map((event) => `YouTube shutdown event: event=${event} kind=initial\n`),
    );
    const retained: string[] = [];
    const collect = rendererShutdownCollector((line) => retained.push(line));
    collect(output.join(""));
    expect(retained).toHaveLength(6);
    const connections = window.session.closeAllConnections();
    expect(connections).toBe(nativePromise);
    const options = { storages: ["private-test-value"] };
    expect(window.session.clearStorageData(options)).toBe(options);
    expect(() => window.session.clearCache()).toThrow(nativeFailure);
    expect(window.session.calls).toBe(3);
    collect(output.slice(6).join(""));
    expect(retained.slice(6)).toEqual(
      [
        "session_connections_call",
        "session_connections_return",
        "session_storage_call",
        "session_storage_return",
        "session_cache_call",
        "session_cache_return",
      ].map((event) => `YouTube shutdown event: event=${event} kind=initial`),
    );
    expect(retained.join("\n")).not.toContain("private-test-value");
    expect(retained.join("\n")).not.toContain("native-close-failure");
    await nativePromise;
  } finally {
    write.mockRestore();
  }
});

it("observes cleanup promise settlement without replacing results or rejection reasons", async () => {
  const failure = new Error("/private/native/session");
  let complete: (() => void) | undefined;
  let fail: ((reason: unknown) => void) | undefined;
  const resolved = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const rejected = new Promise<void>((_resolve, reject) => {
    fail = reject;
  });
  let calls = 0;
  const session = {
    closeAllConnections() {
      calls++;
      return resolved;
    },
    clearStorageData() {
      calls++;
      return rejected;
    },
    clearCache() {
      calls++;
      return Promise.resolve();
    },
  };
  class Window extends EventEmitter {
    webContents = Object.assign(new EventEmitter(), { session });
    close() {}
    destroy() {}
    static getAllWindows() {
      return [window];
    }
  }
  const window = new Window();
  const app = Object.assign(new EventEmitter(), { quit() {}, exit() {} });
  const child = Object.assign(new EventEmitter(), { stderr: new EventEmitter() });
  const application = Object.assign(new EventEmitter(), {
    process: () => child,
    evaluate: async (
      callback: (context: { app: typeof app; BrowserWindow: typeof Window }) => unknown,
    ) => callback({ app, BrowserWindow: Window }),
  });
  const output: string[] = [];
  const write = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    output.push(String(chunk));
    return true;
  });
  try {
    // Structural double only: no Electron process is started.
    // eslint-disable-next-line typescript/no-unsafe-type-assertion
    await installRendererShutdownProbe(application as unknown as ElectronApplication);
    expect(session.closeAllConnections()).toBe(resolved);
    expect(session.clearStorageData()).toBe(rejected);
    const observedRejection = rejected.catch((error: unknown) => error);
    expect(output.join("")).not.toMatch(/resolved|rejected/);
    complete!();
    fail!(failure);
    await resolved;
    expect(await observedRejection).toBe(failure);
    expect(calls).toBe(2);
    const retained: string[] = [];
    rendererShutdownCollector((line) => retained.push(line))(output.join(""));
    expect(retained).toEqual([
      "YouTube shutdown event: event=session_connections_call kind=initial",
      "YouTube shutdown event: event=session_connections_return kind=initial",
      "YouTube shutdown event: event=session_storage_call kind=initial",
      "YouTube shutdown event: event=session_storage_return kind=initial",
      "YouTube shutdown event: event=session_connections_resolved kind=initial",
      "YouTube shutdown event: event=session_storage_rejected kind=initial",
    ]);
    expect(retained.join("")).not.toContain("private");
  } finally {
    write.mockRestore();
  }
});

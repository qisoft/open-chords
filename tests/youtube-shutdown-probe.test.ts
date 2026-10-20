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
  class Window extends EventEmitter {
    webContents = new EventEmitter();
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
    expect(retained.join("\n")).not.toContain("native-close-failure");
  } finally {
    write.mockRestore();
  }
});

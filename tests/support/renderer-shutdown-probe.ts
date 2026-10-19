import type { ElectronApplication } from "@playwright/test";

const shutdownLine =
  /^YouTube shutdown event: event=(?:before_quit|quit_prevented|quit_allowed|quit_loop_100ms|quit_loop_1s|quit_loop_5s|will_quit|quit|window_close|window_closed|window_unresponsive|contents_destroyed|render_gone|process_exit|process_closed|application_closed) kind=(?:app|initial|created|process)$/;

export function rendererShutdownCollector(report: (line: string) => void) {
  let pending = "";
  let discarded = false;
  let reported = 0;
  return (chunk: string) => {
    for (const part of chunk.split(/(?<=\n)/u)) {
      pending += part;
      if (pending.length > 4096) {
        pending = "";
        discarded = true;
      }
      if (part.endsWith("\n")) {
        const line = pending.replace(/\r?\n$/u, "");
        if (!discarded && reported < 32 && shutdownLine.test(line)) {
          report(line);
          reported++;
        }
        pending = "";
        discarded = false;
      }
    }
  };
}

export async function installRendererShutdownProbe(application: ElectronApplication) {
  const collect = rendererShutdownCollector((line) => console.log(line));
  const child = application.process();
  child.stderr?.on("data", (chunk: Buffer) => collect(chunk.toString()));
  child.once("exit", () => collect("\nYouTube shutdown event: event=process_exit kind=process\n"));
  child.once("close", () =>
    collect("\nYouTube shutdown event: event=process_closed kind=process\n"),
  );
  application.once("close", () =>
    collect("\nYouTube shutdown event: event=application_closed kind=app\n"),
  );
  await application.evaluate(({ app, BrowserWindow }) => {
    let emitted = 0;
    const report = (event: string, kind: string) => {
      if (emitted++ < 32)
        process.stderr.write(`YouTube shutdown event: event=${event} kind=${kind}\n`);
    };
    let quitObserved = false;
    app.on("before-quit", (event) => {
      report("before_quit", "app");
      report(event.defaultPrevented ? "quit_prevented" : "quit_allowed", "app");
      if (quitObserved) return;
      quitObserved = true;
      for (const [delay, marker] of [
        [100, "quit_loop_100ms"],
        [1000, "quit_loop_1s"],
        [5000, "quit_loop_5s"],
      ] as const)
        setTimeout(() => report(marker, "app"), delay).unref();
    });
    app.on("will-quit", () => report("will_quit", "app"));
    app.on("quit", () => report("quit", "app"));
    const observed = new WeakSet();
    const watch = (window: InstanceType<typeof BrowserWindow>, kind: "initial" | "created") => {
      if (observed.has(window)) return;
      observed.add(window);
      window.on("close", () => report("window_close", kind));
      window.on("closed", () => report("window_closed", kind));
      window.on("unresponsive", () => report("window_unresponsive", kind));
      window.webContents.on("destroyed", () => report("contents_destroyed", kind));
      window.webContents.on("render-process-gone", () => report("render_gone", kind));
    };
    for (const window of BrowserWindow.getAllWindows()) watch(window, "initial");
    app.on("browser-window-created", (_event, window) => watch(window, "created"));
  });
}

import { execFile } from "node:child_process";

import { afterEach, expect, it, vi } from "vitest";

import {
  observeSlowYouTubeClose,
  youtubeShutdownSampleDiagnostic,
  youtubeShutdownThreadDiagnostic,
  youtubeShutdownMainLoopDiagnostic,
  youtubeShutdownSampleFailureDiagnostic,
} from "./support/youtube-shutdown-sample.ts";

vi.mock("node:child_process", () => ({ execFile: vi.fn<typeof execFile>() }));
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});
const sample =
  "Process: /private/path\nCall graph:\n    100 Thread_123 DispatchQueue_1: com.apple.main-thread (serial)\n    + 100 mach_msg_trap (in libsystem_kernel.dylib) + 8\n    +   100 base::WaitableEvent::Wait() (in Electron Framework) + 42\n    +     100 base::RunLoop::Run() (in Electron Framework) + 7\n    100 Thread_456: worker\n    + 100 sqlite3_step (in libsqlite3.dylib) + 9\n";
it("reports only bounded main-thread frame categories", () => {
  expect(youtubeShutdownSampleDiagnostic(sample)).toBe(
    "YouTube shutdown sample: main_thread=true frames=3 category_mask=17 truncated=false main_samples=100 mutex_max_samples=0",
  );
});
it.each(["/private/path", sample.replace("com.apple.main-thread", "worker"), "x".repeat(262145)])(
  "refuses missing or oversized main-thread samples",
  (raw) => {
    expect(youtubeShutdownSampleDiagnostic(raw)).toBe("YouTube shutdown sample: invalid_evidence");
  },
);
it("caps main-thread inventory and does not output symbols or paths", () => {
  const raw =
    " 100 Thread_1: CrBrowserMain\n" +
    " + 100 private_runtime_symbol (in /private/library) + 1\n".repeat(200);
  expect(youtubeShutdownSampleDiagnostic(raw)).toBe(
    "YouTube shutdown sample: main_thread=true frames=128 category_mask=0 truncated=true main_samples=100 mutex_max_samples=0",
  );
});
it("cancels before the threshold without executing a sampler", async () => {
  vi.useFakeTimers();
  const stop = observeSlowYouTubeClose(42, "darwin");
  stop();
  await vi.advanceTimersByTimeAsync(5000);
  expect(execFile).not.toHaveBeenCalled();
});
it("samples once only on macOS after five seconds with a bounded separate process", async () => {
  vi.useFakeTimers();
  const stop = observeSlowYouTubeClose(42, "darwin");
  await vi.advanceTimersByTimeAsync(4999);
  expect(execFile).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(execFile).toHaveBeenCalledWith(
    "/usr/bin/sample",
    ["42", "1", "10", "-file", "/dev/stdout"],
    { env: { PATH: "/usr/bin:/bin", LANG: "C" }, timeout: 4000, maxBuffer: 262144 },
    expect.any(Function),
  );
  await vi.advanceTimersByTimeAsync(5000);
  expect(execFile).toHaveBeenCalledTimes(1);
  stop();
});
it.each(["win32", "linux"] as const)("does not sample on %s", async (platform) => {
  vi.useFakeTimers();
  observeSlowYouTubeClose(42, platform)();
  await vi.advanceTimersByTimeAsync(5000);
  expect(execFile).not.toHaveBeenCalled();
});

it.each([undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2147483648])(
  "does not sample invalid PID %s",
  async (pid) => {
    vi.useFakeTimers();
    observeSlowYouTubeClose(pid, "darwin")();
    await vi.advanceTimersByTimeAsync(5000);
    expect(execFile).not.toHaveBeenCalled();
  },
);
it("never logs raw sampler failures or stderr", async () => {
  vi.useFakeTimers();
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const stop = observeSlowYouTubeClose(42, "darwin");
  try {
    await vi.advanceTimersByTimeAsync(5000);
    const callback = vi.mocked(execFile).mock.calls[0]?.[3];
    if (typeof callback !== "function") throw new Error("Sample callback missing");
    callback(
      Object.assign(new Error("/private/native/failure"), { cmd: "/private/command" }),
      "/private/stdout",
      "/private/stderr",
    );
    expect(log).toHaveBeenCalledExactlyOnceWith(
      expect.stringMatching(
        /^YouTube shutdown sample: unavailable code=unknown killed=false exit_code=none signal=none duration_ms=[0-9]{1,6}$/,
      ),
    );
  } finally {
    stop();
    log.mockRestore();
  }
});

it("reports the maximum mutex sample count rather than double-counting nested frames", () => {
  const raw =
    " 100 Thread_1: CrBrowserMain\n + 100 uv_run (in private_library) + 1\n +   99 pthread_mutex_lock (in private_library) + 2\n +     98 __psynch_mutexwait (in private_library) + 3\n";
  expect(youtubeShutdownSampleDiagnostic(raw)).toBe(
    "YouTube shutdown sample: main_thread=true frames=3 category_mask=132 truncated=false main_samples=100 mutex_max_samples=99",
  );
});
it("bounds numeric sample evidence without retaining names, paths or oversized counts", () => {
  const raw =
    " 999999999 Thread_123: CrBrowserMain\n + 999999999 __psynch_mutexwait (in /private/path) + 1\n";
  expect(youtubeShutdownSampleDiagnostic(raw)).toBe(
    "YouTube shutdown sample: main_thread=true frames=1 category_mask=4 truncated=false main_samples=10000 mutex_max_samples=10000",
  );
});

it("classifies all bounded sampler threads without retaining thread names or frames", () => {
  const raw =
    sample +
    " 100 Thread_789: Chrome_IOThread\n + 100 base::WaitableEvent::Wait() (in /private/lib) + 1\n" +
    " 100 Thread_999: ThreadPoolForegroundWorker\n + 100 pthread_cond_wait (in /private/lib) + 1\n";
  expect(youtubeShutdownThreadDiagnostic(raw)).toBe(
    "YouTube shutdown threads: threads=4 frames=6 main=1 io=1 pool=1 other=1 io_mask=16 pool_mask=8 other_mask=1024 category_threads=1,0,0,1,2,0,0,0,0,0,1,0 truncated=false",
  );
});
it("counts each category once per thread rather than once per stack frame", () => {
  const raw =
    " 100 Thread_1: CrBrowserMain\n + 100 uv_run (in private) + 1\n" +
    " 100 Thread_2: ThreadPoolForegroundWorker\n + 100 pthread_mutex_lock (in private) + 1\n + 99 __psynch_mutexwait (in private) + 2\n";
  const result = youtubeShutdownThreadDiagnostic(raw);
  expect(result).toContain("pool_mask=4");
  expect(result).toContain("category_threads=0,0,1,0,0,0,0,1,0,0,0,0");
});
it("caps per-thread frames and marks an incomplete inventory", () => {
  const result = youtubeShutdownThreadDiagnostic(
    " 100 Thread_1: CrBrowserMain\n" + " + 100 private_symbol (in /private/lib) + 1\n".repeat(129),
  );
  expect(result).toContain("threads=1 frames=128");
  expect(result).toContain("truncated=true");
  expect(result).not.toContain("private");
});
it("caps thread count without emitting arbitrary names or identifiers", () => {
  const raw =
    " 1 Thread_1: CrBrowserMain\n + 1 uv_run (in private) + 1\n" +
    Array.from(
      { length: 100 },
      (_, i) => ` 1 Thread_${i + 2}: private_name\n + 1 private_symbol (in /private/lib) + 1\n`,
    ).join("");
  const result = youtubeShutdownThreadDiagnostic(raw);
  expect(result).toContain("threads=64 frames=64");
  expect(result).toContain("truncated=true");
  expect(result).not.toContain("private");
  expect(result).not.toContain("Thread_");
});
it("caps the combined frame inventory", () => {
  const raw = Array.from(
    { length: 20 },
    (_, i) =>
      ` 1 Thread_${i}: ${i === 0 ? "CrBrowserMain" : "worker"}\n` +
      " + 1 private_symbol (in lib) + 1\n".repeat(128),
  ).join("");
  expect(youtubeShutdownThreadDiagnostic(raw)).toContain("frames=2048");
  expect(youtubeShutdownThreadDiagnostic(raw)).toContain("truncated=true");
});
it.each(["private", " 1 Thread_2: worker\n + 1 uv_run (in private) + 1", "x".repeat(262145)])(
  "refuses missing main-thread or oversized thread evidence",
  (raw) => {
    expect(youtubeShutdownThreadDiagnostic(raw)).toBe("YouTube shutdown threads: invalid_evidence");
  },
);

it("does not treat post-callgraph summary lines as another thread's frames", () => {
  const suffix =
    "Total number in stack (recursive counted multiple):\n + 1 pthread_mutex_lock (in private) + 1\n";
  expect(youtubeShutdownThreadDiagnostic(sample + suffix)).toBe(
    youtubeShutdownThreadDiagnostic(sample),
  );
});
it("reports all fixed summaries from the same single sampler response", async () => {
  vi.useFakeTimers();
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const stop = observeSlowYouTubeClose(42, "darwin");
  try {
    await vi.advanceTimersByTimeAsync(5000);
    const callback = vi.mocked(execFile).mock.calls[0]?.[3];
    if (typeof callback !== "function") throw new Error("Sample callback missing");
    callback(null, sample, "/private/stderr");
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(log.mock.calls).toEqual([
      [youtubeShutdownSampleDiagnostic(sample)],
      [youtubeShutdownThreadDiagnostic(sample)],
      [youtubeShutdownMainLoopDiagnostic(sample)],
    ]);
    expect(JSON.stringify(log.mock.calls)).not.toContain("private");
  } finally {
    stop();
    log.mockRestore();
  }
});
it("suppresses all summaries when the close completed before the sampler callback", async () => {
  vi.useFakeTimers();
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const stop = observeSlowYouTubeClose(42, "darwin");
  try {
    await vi.advanceTimersByTimeAsync(5000);
    stop();
    const callback = vi.mocked(execFile).mock.calls[0]?.[3];
    if (typeof callback !== "function") throw new Error("Sample callback missing");
    callback(null, sample, "/private/stderr");
    expect(log).not.toHaveBeenCalled();
  } finally {
    stop();
    log.mockRestore();
  }
});

it("continues to IO and pool threads after truncating one overlong main stack", () => {
  const raw =
    " 100 Thread_1: CrBrowserMain\n" +
    " + 100 uv_run (in /private/lib) + 1\n".repeat(128) +
    " + 100 sqlite3_step (in /private/overflow) + 1\n" +
    " 100 Thread_2: Chrome_IOThread\n + 100 base::WaitableEvent::Wait() (in /private/lib) + 1\n" +
    " 100 Thread_3: ThreadPoolForegroundWorker\n + 100 pthread_cond_wait (in /private/lib) + 1\n";
  expect(youtubeShutdownThreadDiagnostic(raw)).toBe(
    "YouTube shutdown threads: threads=3 frames=130 main=1 io=1 pool=1 other=0 io_mask=16 pool_mask=8 other_mask=0 category_threads=0,0,0,1,1,0,0,1,0,0,0,0 truncated=true",
  );
});

it.each([
  [{ killed: true, signal: "SIGTERM" }, "unknown", "none", "SIGTERM"],
  [
    { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", killed: true, signal: "SIGTERM" },
    "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
    "none",
    "SIGTERM",
  ],
  [{ code: 1, signal: null }, "exit", "1", "none"],
  [{ code: "EACCES" }, "EACCES", "none", "none"],
  [{ code: "ENOENT" }, "ENOENT", "none", "none"],
  [{ code: "private", signal: "private" }, "unknown", "none", "none"],
  [{ code: 256 }, "unknown", "none", "none"],
])("reports only fixed sampler failure metadata", (error, code, exit, signal) => {
  const value = {
    ...error,
    message: "/private/message",
    cmd: "/private/command",
    stdout: "private",
    stderr: "private",
  };
  expect(youtubeShutdownSampleFailureDiagnostic(value, 123.9)).toBe(
    `YouTube shutdown sample: unavailable code=${code} killed=${"killed" in error && error.killed} exit_code=${exit} signal=${signal} duration_ms=123`,
  );
});
it("does not invoke failure-property getters or leak proxy exceptions", () => {
  const error = {
    get code() {
      throw new Error("private");
    },
    get signal() {
      throw new Error("private");
    },
    get killed() {
      throw new Error("private");
    },
  };
  expect(youtubeShutdownSampleFailureDiagnostic(error, 0)).toContain(
    "code=unknown killed=false exit_code=none signal=none",
  );
  expect(
    youtubeShutdownSampleFailureDiagnostic(
      new Proxy(
        {},
        {
          getOwnPropertyDescriptor() {
            throw new Error("private");
          },
        },
      ),
      0,
    ),
  ).not.toContain("private");
});
it.each([
  [Number.NaN, "unknown"],
  [Number.POSITIVE_INFINITY, "unknown"],
  [-1, "0"],
  [10000000, "999999"],
])("bounds sampler failure duration", (duration, expected) => {
  expect(youtubeShutdownSampleFailureDiagnostic(null, duration)).toContain(
    `duration_ms=${expected}`,
  );
});

it("separates fixed main-loop frame categories without exposing symbols, paths or other threads", () => {
  const raw =
    "Process: /private/app\n100 Thread_1 com.apple.main-thread\n" +
    [
      "-[NSApplication run]",
      "-[NSRunLoop runMode:]",
      "CFRunLoopRunSpecific",
      "base::MessagePump::Run",
      "uv_run",
      "dispatch_sync",
      "electron::BrowserWindow::Close",
      "StoragePartition::ClearData",
      "private_symbol",
    ]
      .map((name) => ` + 100 ${name} (in /private/lib) [0xprivate]\n`)
      .join("") +
    "100 Thread_2 private_worker\n + 100 CFRunLoopRun (in private)\n";
  expect(youtubeShutdownMainLoopDiagnostic(raw)).toBe(
    "YouTube shutdown main loop: frames=9 app_run=1 ns_loop=1 cf_loop=1 chromium_pump=1 node_loop=1 dispatch=1 window_teardown=1 session_cleanup=1 truncated=false",
  );
});
it("bounds main-loop classification and excludes post-callgraph summaries", () => {
  const header = "100 Thread_1 com.apple.main-thread\n";
  const frame = " + 100 CFRunLoopRunSpecific (in private)\n";
  expect(youtubeShutdownMainLoopDiagnostic(header + frame.repeat(129))).toContain(
    "frames=128 app_run=0 ns_loop=0 cf_loop=128",
  );
  expect(youtubeShutdownMainLoopDiagnostic(header + frame.repeat(129))).toContain("truncated=true");
  expect(youtubeShutdownMainLoopDiagnostic(header + frame + "Binary Images:\n" + frame)).toContain(
    "frames=1 app_run=0 ns_loop=0 cf_loop=1",
  );
});
it.each([
  "private",
  "x".repeat(262145),
  "100 Thread_2 other\n + 100 uv_run (in private)\n",
  "100 Thread_1 com.apple.main-thread\nprivate",
])("refuses incomplete or oversized main-loop input", (raw) => {
  expect(youtubeShutdownMainLoopDiagnostic(raw)).toBe(
    "YouTube shutdown main loop: invalid_evidence",
  );
});

import { execFile } from "node:child_process";

import { afterEach, expect, it, vi } from "vitest";

import {
  observeSlowYouTubeClose,
  youtubeShutdownSampleDiagnostic,
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
    expect(log).toHaveBeenCalledExactlyOnceWith("YouTube shutdown sample: unavailable");
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

import { execFile } from "node:child_process";

const symbols = [
  /mach_msg/,
  /(?:kevent|__select|poll\()/,
  /(?:__psynch_mutexwait|pthread_mutex)/,
  /(?:pthread_cond|ConditionVariable.*Wait)/,
  /WaitableEvent.*Wait/,
  /(?:SyncChannel|SyncMessage|SyncCall|WaitForSync)/,
  /(?:CFRunLoop|NSRunLoop|MessagePump)/,
  /uv_run/,
  /(?:StoragePartition|BrowserContext)/,
  /(?:ClearHttpCache|clearCache)/,
  /(?:SQLite|sqlite3)/,
  /(?:fsync|pread|pwrite|read\(|write\()/,
] as const;

export function youtubeShutdownSampleDiagnostic(raw: string) {
  if (raw.length > 262144) return "YouTube shutdown sample: invalid_evidence";
  let main = false;
  let frames = 0;
  let mask = 0;
  let truncated = false;
  let mainSamples = 0;
  let mutexSamples = 0;
  for (const line of raw.split(/\r?\n/)) {
    if (/^\s*[0-9]{1,9}\s+Thread_/.test(line)) {
      if (main) break;
      main = /(?:com\.apple\.main-thread|CrBrowserMain)\b/.test(line);
      if (main) mainSamples = Math.min(10000, Number(/^\s*([0-9]{1,9})/.exec(line)?.[1] ?? 0));
      continue;
    }
    if (!main) continue;
    const frame = /^\s*[+!:| ]*[0-9]{1,9}\s+(.+?)\s+\(in [^)]+\)/.exec(line);
    if (!frame) continue;
    if (frames === 128) {
      truncated = true;
      break;
    }
    frames++;
    if (symbols[2].test(frame[1]!)) {
      const count = /^\s*[+!:| ]*([0-9]{1,9})\s+/.exec(line)?.[1];
      mutexSamples = Math.max(mutexSamples, Math.min(10000, Number(count ?? 0)));
    }
    for (const [bit, expression] of symbols.entries())
      if (expression.test(frame[1]!)) mask |= 1 << bit;
  }
  if (!main || frames === 0) return "YouTube shutdown sample: invalid_evidence";
  return `YouTube shutdown sample: main_thread=true frames=${String(frames)} category_mask=${String(mask)} truncated=${String(truncated)} main_samples=${String(mainSamples)} mutex_max_samples=${String(mutexSamples)}`;
}

// Classify only the same bounded sample response already captured for the main
// thread. No additional sampler, native read, process discovery or raw output.
export function youtubeShutdownThreadDiagnostic(raw: string) {
  if (raw.length > 262144) return "YouTube shutdown threads: invalid_evidence";
  const categoryThreads = symbols.map(() => 0);
  const groups = [0, 0, 0, 0]; // main, IO, thread pool, other
  const masks = [0, 0, 0, 0];
  let threads = 0,
    frames = 0,
    mainFrames = 0,
    threadFrames = 0,
    mask = 0;
  let group: number | undefined;
  let truncated = false;
  const finishThread = () => {
    if (group === undefined) return;
    masks[group]! |= mask;
    for (let bit = 0; bit < symbols.length; bit++)
      if ((mask & (1 << bit)) !== 0) categoryThreads[bit]!++;
  };
  for (const line of raw.split(/\r?\n/)) {
    if (/^\s*(?:Total number in stack|Sort by top of stack|Binary Images:)/.test(line)) break;
    if (/^\s*[0-9]{1,9}\s+Thread_/.test(line)) {
      finishThread();
      group = undefined;
      if (threads === 64) {
        truncated = true;
        break;
      }
      group = /(?:com\.apple\.main-thread|CrBrowserMain)\b/.test(line)
        ? 0
        : /\bChrome_IOThread\b/.test(line)
          ? 1
          : /\bThreadPool[A-Za-z0-9_]*/.test(line)
            ? 2
            : 3;
      groups[group]!++;
      threads++;
      mask = 0;
      threadFrames = 0;
      continue;
    }
    if (group === undefined) continue;
    const frame = /^\s*[+!:| ]*[0-9]{1,9}\s+(.+?)\s+\(in [^)]+\)/.exec(line);
    if (!frame) continue;
    if (frames === 2048) {
      truncated = true;
      break;
    }
    if (threadFrames === 128) {
      truncated = true;
      continue;
    }
    frames++;
    threadFrames++;
    if (group === 0) mainFrames++;
    for (const [bit, expression] of symbols.entries())
      if (expression.test(frame[1]!)) mask |= 1 << bit;
  }
  finishThread();
  if (mainFrames === 0) return "YouTube shutdown threads: invalid_evidence";
  return `YouTube shutdown threads: threads=${threads} frames=${frames} main=${groups[0]} io=${groups[1]} pool=${groups[2]} other=${groups[3]} io_mask=${masks[1]} pool_mask=${masks[2]} other_mask=${masks[3]} category_threads=${categoryThreads.join(",")} truncated=${truncated}`;
}

export function youtubeShutdownSampleFailureDiagnostic(error: unknown, durationMs: number) {
  const own = (name: string): unknown => {
    try {
      return typeof error === "object" && error !== null
        ? Object.getOwnPropertyDescriptor(error, name)?.value
        : undefined;
    } catch {
      return undefined;
    }
  };
  const code = own("code");
  const exitCode =
    typeof code === "number" && Number.isSafeInteger(code) && code >= 0 && code <= 255
      ? code
      : "none";
  const category =
    exitCode !== "none"
      ? "exit"
      : typeof code === "string" &&
          [
            "ENOENT",
            "EACCES",
            "EPERM",
            "ETIMEDOUT",
            "ENOBUFS",
            "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
          ].includes(code)
        ? code
        : "unknown";
  const rawSignal = own("signal");
  const signal =
    typeof rawSignal === "string" &&
    ["SIGTERM", "SIGKILL", "SIGABRT", "SIGSEGV", "SIGHUP", "SIGINT", "SIGBUS"].includes(rawSignal)
      ? rawSignal
      : "none";
  const duration = Number.isFinite(durationMs)
    ? Math.min(999999, Math.max(0, Math.floor(durationMs)))
    : "unknown";
  return `YouTube shutdown sample: unavailable code=${category} killed=${own("killed") === true} exit_code=${exitCode} signal=${signal} duration_ms=${duration}`;
}

export function observeSlowYouTubeClose(
  pid: number | undefined,
  platform: NodeJS.Platform = process.platform,
) {
  if (
    platform !== "darwin" ||
    pid === undefined ||
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    pid > 2147483647
  )
    return () => {};
  let active = true;
  const timer = setTimeout(() => {
    const started = performance.now();
    execFile(
      "/usr/bin/sample",
      [String(pid), "1", "10", "-file", "/dev/stdout"],
      {
        env: { PATH: "/usr/bin:/bin", LANG: "C" },
        timeout: 4000,
        maxBuffer: 262144,
      },
      (error, stdout) => {
        if (!active) return;
        console.log(
          error === null
            ? youtubeShutdownSampleDiagnostic(stdout)
            : youtubeShutdownSampleFailureDiagnostic(error, performance.now() - started),
        );
        if (error === null) console.log(youtubeShutdownThreadDiagnostic(stdout));
      },
    );
  }, 5000);
  timer.unref();
  return () => {
    active = false;
    clearTimeout(timer);
  };
}

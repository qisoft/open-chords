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
  for (const line of raw.split(/\r?\n/)) {
    if (/^\s*[0-9]{1,9}\s+Thread_/.test(line)) {
      if (main) break;
      main = /(?:com\.apple\.main-thread|CrBrowserMain)\b/.test(line);
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
    for (const [bit, expression] of symbols.entries())
      if (expression.test(frame[1]!)) mask |= 1 << bit;
  }
  if (!main || frames === 0) return "YouTube shutdown sample: invalid_evidence";
  return `YouTube shutdown sample: main_thread=true frames=${String(frames)} category_mask=${String(mask)} truncated=${String(truncated)}`;
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
            : "YouTube shutdown sample: unavailable",
        );
      },
    );
  }, 5000);
  timer.unref();
  return () => {
    active = false;
    clearTimeout(timer);
  };
}

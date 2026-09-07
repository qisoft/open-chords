type Waiting = { start: () => void; cancel: () => void; block: () => void };
const waiting: Waiting[] = [];
let active = false;
let blocked = false;
export class CpuWorkCleanupFailure extends Error {
  constructor() {
    super("CPU work is blocked until restart after incomplete cleanup");
  }
}

export function blockCpuWorkAfterIncompleteCleanup() {
  blocked = true;
  for (const queued of waiting.splice(0)) queued.block();
}

function pump() {
  if (active) return;
  waiting.shift()?.start();
}

/** Shared ceiling for native analysis and alignment, including teardown. */
export function withCpuWork<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  if (blocked) return Promise.reject(new CpuWorkCleanupFailure());
  if (signal.aborted) return Promise.reject(new Error("CPU work cancelled"));
  if (waiting.length >= 32) return Promise.reject(new Error("CPU work queue is full"));
  return new Promise<T>((resolve, reject) => {
    const entry: Waiting = {
      block: () => {
        signal.removeEventListener("abort", entry.cancel);
        reject(new CpuWorkCleanupFailure());
      },
      cancel: () => {
        const index = waiting.indexOf(entry);
        if (index < 0) return;
        waiting.splice(index, 1);
        signal.removeEventListener("abort", entry.cancel);
        reject(new Error("CPU work cancelled"));
      },
      start: () => {
        active = true;
        signal.removeEventListener("abort", entry.cancel);
        void Promise.resolve()
          .then(() => {
            if (signal.aborted) throw new Error("CPU work cancelled");
            return operation();
          })
          .then(resolve, (error) => {
            if (error instanceof CpuWorkCleanupFailure) {
              blockCpuWorkAfterIncompleteCleanup();
            }
            reject(error);
          })
          .finally(() => {
            active = false;
            pump();
          });
      },
    };
    waiting.push(entry);
    signal.addEventListener("abort", entry.cancel, { once: true });
    pump();
  });
}

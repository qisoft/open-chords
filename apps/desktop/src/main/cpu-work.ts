type Waiting = { start: () => void; cancel: () => void };
const waiting: Waiting[] = [];
let active = false;

function pump() {
  if (active) return;
  waiting.shift()?.start();
}

/** Shared ceiling for native analysis and alignment, including teardown. */
export function withCpuWork<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("CPU work cancelled"));
  if (waiting.length >= 32) return Promise.reject(new Error("CPU work queue is full"));
  return new Promise<T>((resolve, reject) => {
    const entry: Waiting = {
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
          .then(resolve, reject)
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

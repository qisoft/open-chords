export type MediaCleanupBeforeQuitEvent = {
  preventDefault(): void;
};

export function createMediaCleanupBeforeQuitHandler(options: {
  dispose: () => Promise<void>;
  exitWithFailure: () => void;
  quit: () => void;
  timeoutMs: number;
}): (event: MediaCleanupBeforeQuitEvent) => void {
  let cleanupComplete = false;
  let cleanupStarted = false;
  return (event) => {
    if (cleanupComplete) return;
    event.preventDefault();
    if (cleanupStarted) return;
    cleanupStarted = true;
    let cleanupTimeout: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_resolve, reject) => {
      cleanupTimeout = setTimeout(
        () => reject(new Error("Local media cleanup timed out")),
        options.timeoutMs,
      );
    });
    void Promise.race([options.dispose(), timeout]).then(
      () => {
        clearTimeout(cleanupTimeout);
        cleanupComplete = true;
        options.quit();
        return undefined;
      },
      () => {
        clearTimeout(cleanupTimeout);
        options.exitWithFailure();
        return undefined;
      },
    );
  };
}

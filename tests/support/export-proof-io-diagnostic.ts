import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

// Pure-test diagnostics only. Calls retain their arguments, result and original rejection.
export function observeExportProofIO(write: (line: string) => void) {
  const started = performance.now();
  let active = true;
  let entries = 0;
  const pending = { open: 0, write: 0, sync: 0, close: 0, rename: 0 };
  type Operation = keyof typeof pending;
  const safeWrite = (line: string) => {
    try {
      write(line);
    } catch {
      /* Diagnostics cannot replace an I/O result. */
    }
  };
  const snapshots = [25000, 29000].map((delay) => {
    const timer = setTimeout(() => {
      if (active)
        safeWrite(
          `Export unit IO pending: ${Object.entries(pending)
            .map(([key, count]) => `${key}=${Math.min(9999, count)}`)
            .join(" ")} elapsed_ms=${delay}\n`,
        );
    }, delay);
    timer.unref();
    return timer;
  });
  const restores: (() => void)[] = [];
  const emit = (operation: string, state: string) => {
    if (!active || entries >= 128) return;
    entries++;
    safeWrite(
      `Export unit IO: operation=${operation} state=${state} elapsed_ms=${Math.min(999999, Math.max(0, Math.floor(performance.now() - started)))}\n`,
    );
  };
  const observe = async <T>(operation: Operation, call: () => Promise<T>): Promise<T> => {
    pending[operation]++;
    emit(operation, "started");
    try {
      const result = await call();
      emit(operation, "returned");
      return result;
    } catch (error) {
      emit(operation, "rejected");
      throw error;
    } finally {
      pending[operation]--;
    }
  };
  const originalOpen = fs.promises.open;
  const originalRename = fs.promises.rename;
  fs.promises.open = async (...args) => {
    const handle = await observe("open", () => originalOpen(...args));
    if (active) {
      // oxlint-disable-next-line typescript/unbound-method -- Preserve method identity for restoration; invoke with the original handle below.
      const writeFile = handle.writeFile;
      // oxlint-disable-next-line typescript/unbound-method -- Preserve method identity for restoration; invoke with the original handle below.
      const sync = handle.sync;
      // oxlint-disable-next-line typescript/unbound-method -- Preserve method identity for restoration; invoke with the original handle below.
      const close = handle.close;
      handle.writeFile = (...values) => observe("write", () => writeFile.apply(handle, values));
      handle.sync = () => observe("sync", () => sync.call(handle));
      handle.close = () => observe("close", () => close.call(handle));
      restores.push(() => {
        handle.writeFile = writeFile;
        handle.sync = sync;
        handle.close = close;
      });
    }
    return handle;
  };
  fs.promises.rename = (...args) => observe("rename", () => originalRename(...args));
  syncBuiltinESMExports();
  return () => {
    active = false;
    for (const timer of snapshots) clearTimeout(timer);
    fs.promises.open = originalOpen;
    fs.promises.rename = originalRename;
    for (const restore of restores) restore();
    syncBuiltinESMExports();
  };
}

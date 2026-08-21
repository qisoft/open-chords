import { describe, expect, it, vi } from "vitest";

import { presentDesktopWindow } from "../apps/desktop/src/main/window-lifecycle.ts";

describe("desktop window lifecycle", () => {
  it("restores and focuses a presented window", () => {
    const window = {
      focus: vi.fn<() => void>(),
      isMinimized: vi.fn<() => boolean>(() => true),
      restore: vi.fn<() => void>(),
    };

    presentDesktopWindow(window);

    expect(window.restore).toHaveBeenCalledOnce();
    expect(window.focus).toHaveBeenCalledOnce();
  });
});

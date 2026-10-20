import { expect, it } from "vitest";

import { windowsLocalVolumeCommand } from "../apps/desktop/src/main/windows-local-volume-command.ts";

it.each(["", "C:\\folder", "\\\\server\\share", "C:'; exit 0; #", "C:\n", "/tmp", "CC:"])(
  "rejects non-drive or injected roots: %s",
  (root) => {
    expect(() => windowsLocalVolumeCommand(root)).toThrow("Windows volume root unavailable");
  },
);

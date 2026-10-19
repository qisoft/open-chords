import { expect, it } from "vitest";

import { installedWindowsCleanupFailure } from "./support/installed-cleanup-windows-diagnostics.ts";

it("reports only fixed cleanup input stages from native failures", () => {
  for (const stage of ["target", "foreground", "hit_test", "cursor_position", "send_input"]) {
    expect(
      installedWindowsCleanupFailure({
        stderr: `private path Native cleanup input failure: ${stage}" private data`,
        message: "private command",
      }),
    ).toBe(`Native Windows cleanup driver failed: input_stage=${stage}`);
  }
});

it("redacts missing, malformed, ambiguous and out-of-bound evidence", () => {
  for (const error of [
    null,
    new Error("private"),
    { stderr: 42 },
    { stderr: "Native cleanup input failure: foreground_private" },
    { stderr: "Native cleanup input failure: private" },
    { stderr: "Native cleanup input failure: foreground\nNative cleanup input failure: hit_test" },
    { stderr: "Native cleanup input failure: foreground\n" + "x".repeat(16384) },
  ]) {
    expect(installedWindowsCleanupFailure(error)).toBe(
      "Native Windows cleanup driver failed: input_stage=unknown",
    );
  }
});

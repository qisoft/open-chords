import { afterEach, expect, it, vi } from "vitest";

const execute = vi.hoisted(() =>
  vi.fn<
    (
      command: string,
      args: string[],
      options: { timeout: number; env: NodeJS.ProcessEnv; maxBuffer: number },
    ) => Promise<{ stdout: string; stderr: string }>
  >(),
);
vi.mock("node:child_process", () => ({
  execFile: Object.assign(() => undefined, {
    [Symbol.for("nodejs.util.promisify.custom")]: execute,
  }),
}));
vi.mock("@playwright/test", () => ({ expect }));

import { installedMacPickerDriver } from "./support/installed-macos-picker-driver.ts";
import { MAC_AX_COUNT_FIELDS } from "./support/installed-picker-macos-ax-diagnostics.ts";

const probe = {
  format: "json",
  total: 1,
  unreadableRoles: 0,
  truncated: false,
  fields: [
    { role: "text_field", subrole: "empty", name: "save_as", value: "expected", enabled: "true" },
  ],
};
const prepared = {
  prepared: true,
  nativePress: false,
  navigationDismissed: true,
  directoryNavigationVerified: true,
  defaultFilenameVerified: true,
  saveFieldProbe: probe,
};
const snapshot = {
  trusted: true,
  complete: true,
  lastError: 0,
  dismissalLastError: 0,
  pressDurationMs: 0,
  pressSheetState: "not_checked",
  pressFollowupError: 0,
  firstOtherError: 0,
  firstOtherAttribute: "none",
  firstOtherStage: "none",
  firstOtherVisited: 0,
  firstCannotCompleteAttribute: "none",
  firstCannotCompleteStage: "none",
  firstCannotCompleteDurationMs: 0,
  verified: false,
  foreground: false,
  guardMask: 0,
  stage: "verification",
  action: { requested: "none", pressed: false, dismissed: false },
  counts: Object.fromEntries(MAC_AX_COUNT_FIELDS.map((key) => [key, 0])),
};
const cancelled = {
  action: "cancel_save_edited",
  nativePress: true,
  dialogDismissed: true,
  defaultFilenameVerified: true,
  filenameInputVerified: true,
  directoryNavigationVerified: false,
  saveFieldProbe: probe,
};

afterEach(() => {
  execute.mockReset();
  vi.restoreAllMocks();
});

it("shares one deadline across preparation, read-only snapshot and guarded cancellation", async () => {
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const responses = [prepared, snapshot, cancelled];
  execute.mockImplementation(async () => {
    now += 300;
    return { stdout: JSON.stringify(responses.shift()), stderr: "" };
  });
  await installedMacPickerDriver(
    "cancel_save_directory",
    "/private/directory",
    () => ({ LANG: "en_US.UTF-8" }),
    "json",
  )(42);
  expect(execute).toHaveBeenCalledTimes(3);
  expect(execute.mock.calls[0]?.[1]).toContain("prepare_save_directory");
  expect(execute.mock.calls[1]?.[1]).toEqual(["42", "/private/directory"]);
  expect(execute.mock.calls[2]?.[1]).toContain("cancel_save_edited");
  expect(execute.mock.calls.map((call) => call[2].timeout)).toEqual([100000, 7000, 99400]);
  for (const call of execute.mock.calls) expect(call[2].env).toEqual({ LANG: "en_US.UTF-8" });
  expect(output.mock.calls.flat().join("")).not.toContain("/private");
});

it("rejects malformed preparation before launching the native snapshot or continuation", async () => {
  execute.mockResolvedValue({
    stdout: JSON.stringify({ ...prepared, nativePress: true }),
    stderr: "",
  });
  await expect(
    installedMacPickerDriver("cancel_save_directory", "/private/directory", () => ({}), "json")(42),
  ).rejects.toThrow("directory preparation unavailable");
  expect(execute).toHaveBeenCalledTimes(1);
});

it("redacts snapshot process failures and never continues after them", async () => {
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  execute
    .mockResolvedValueOnce({ stdout: JSON.stringify(prepared), stderr: "" })
    .mockRejectedValueOnce({
      code: 1,
      message: "/private/command",
      stdout: "/private/output",
      stderr: "/private/error",
    });
  let failure: unknown;
  try {
    await installedMacPickerDriver(
      "cancel_save_directory",
      "/private/directory",
      () => ({}),
      "json",
    )(42);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  expect(String(failure)).toContain("exit_code=1");
  expect(String(failure)).not.toContain("private");
  expect(failure).not.toHaveProperty("cause");
  expect(execute).toHaveBeenCalledTimes(2);
});

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
import {
  installedMacAxProbeDiagnostic,
  MAC_AX_COUNT_FIELDS,
} from "./support/installed-picker-macos-ax-diagnostics.ts";

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
  firstOtherSelectedReference: false,
  firstOtherSelectedBranch: false,
  firstOtherAttribute: "none",
  firstOtherStage: "none",
  firstOtherVisited: 0,
  firstOtherOrigin: "none",
  firstOtherParentRole: "none",
  staleSnapshot: {
    eligible: false,
    traversalComplete: false,
    candidates: 0,
    allVanished: false,
    onlyInvalidChildErrors: false,
  },
  invalidChildParent: {
    status: "not_checked",
    role: "none",
    pidMatches: false,
    selectedReference: false,
    children: 0,
    containsFailedReference: "unknown",
    attribute: "none",
    error: 0,
  },
  selectedDirectory: {
    fields: 0,
    uniqueUrls: 0,
    terminalUrls: 0,
    terminalMatches: 0,
    validShape: false,
  },
  parentChain: {
    status: "not_checked",
    visited: 0,
    selected: 0,
    unknownSelected: 0,
    roleMask: 0,
    nodes: [],
  },
  firstExactURL: {
    role: "none",
    parentRole: "none",
    origin: "none",
    selected: "unknown",
    directory: false,
    kind: "none",
    titleCategory: "unavailable",
    valueCategory: "unavailable",
    traversalRoleMask: 0,
    traversalDepth: 0,
  },
  firstCannotCompleteAttribute: "none",
  firstCannotCompleteStage: "none",
  firstCannotCompleteDurationMs: 0,
  directoryVerified: false,
  verified: false,
  foreground: false,
  guardMask: 0,
  stage: "verification",
  action: { requested: "none", pressed: false, dismissed: false },
  counts: Object.fromEntries(MAC_AX_COUNT_FIELDS.map((key) => [key, 0])),
};
const directorySnapshot = {
  ...snapshot,
  trusted: true,
  complete: true,
  directoryVerified: true,
  foreground: true,
  guardMask: 255,
  stage: "directory_complete",
  verified: false,
  action: { requested: "directory_snapshot", pressed: false, dismissed: false },
  counts: {
    ...snapshot.counts,
    windows: 1,
    sheets: 1,
    buttons: 1,
    saveButtons: 1,
    selectedRoots: 8,
    urlObjects: 8,
    exactUrls: 1,
  },
  selectedDirectory: {
    fields: 8,
    uniqueUrls: 8,
    terminalUrls: 1,
    terminalMatches: 1,
    validShape: true,
  },
  firstExactURL: {
    ...snapshot.firstExactURL,
    role: "AXTextField",
    parentRole: "AXGroup",
    origin: "AXChildren",
    kind: "native",
    directory: true,
  },
  parentChain: {
    status: "captured_sheet",
    visited: 2,
    selected: 0,
    unknownSelected: 2,
    roleMask: 8,
    nodes: [
      { role: "AXGroup", selectedReference: true, selectedState: "unknown" },
      { role: "AXSheet", selectedReference: false, selectedState: "unknown" },
    ],
  },
};

const filenameSnapshot = {
  ...directorySnapshot,
  saveFilename: {
    status: "complete",
    fields: 11,
    matches: 1,
    absentValues: 1,
    enabled: true,
    labelMatched: true,
    fieldAttached: true,
    labelAttached: true,
    visited: 4,
    verified: true,
    error: 0,
    attribute: "none",
  },
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

const expanded = {
  trusted: true,
  complete: true,
  foreground: true,
  guardMask: 255,
  lastError: 0,
  firstErrorAttribute: "none",
  firstErrorDurationMs: 0,
  stage: "complete",
  pressed: true,
  expanded: true,
  initialValue: 0,
  finalValue: 1,
  windows: 1,
  sheets: 1,
  visited: 10,
  unsupported: 0,
  disclosures: 1,
  saveButtons: 1,
  cancelButtons: 1,
};
it("expands only in the isolated expanded journey before a fresh read-only snapshot and Cancel", async () => {
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const responses = [
    prepared,
    expanded,
    snapshot,
    directorySnapshot,
    filenameSnapshot,
    { ...expanded, expanded: false, initialValue: 1, finalValue: 0 },
    { ...cancelled, action: "cancel_save_restored" },
  ];
  execute.mockImplementation(async () => {
    now += 300;
    return { stdout: JSON.stringify(responses.shift()), stderr: "" };
  });
  await installedMacPickerDriver(
    "cancel_save_directory_expanded",
    "/private/directory",
    () => ({ LANG: "en_US.UTF-8" }),
    "json",
  )(42);
  expect(execute).toHaveBeenCalledTimes(7);
  expect(execute.mock.calls[0]?.[1]).toContain("prepare_save_directory_expanded");
  expect(execute.mock.calls[1]?.[0]).toContain("macos-save-expand");
  expect(execute.mock.calls[1]?.[1]).toEqual(["42"]);
  expect(execute.mock.calls[2]?.[1]).toEqual(["42", "/private/directory"]);
  expect(execute.mock.calls[3]?.[1]).toEqual([
    "42",
    "/private/directory",
    "directory_snapshot",
    "json",
  ]);
  expect(execute.mock.calls[4]?.[1]).toEqual([
    "42",
    "/private/directory",
    "directory_snapshot",
    "json",
    "--verify-filename",
  ]);
  expect(execute.mock.calls[5]?.[1]).toEqual(["42", "--collapse"]);
  expect(execute.mock.calls[6]?.[1]).toContain("cancel_save_restored");
  expect(execute.mock.calls.map((call) => call[2].timeout)).toEqual([
    100000, 7000, 7000, 7000, 7000, 7000, 98200,
  ]);
  for (const call of execute.mock.calls) expect(call[2].env).toEqual({ LANG: "en_US.UTF-8" });
  expect(output.mock.calls.flat().join("")).not.toContain("private");
});
it.each([
  { guardMask: 254 },
  { expanded: false },
  { pressed: false },
  { finalValue: 0 },
  { path: "/private/path" },
])("never snapshots or continues after refused expansion %j", async (change) => {
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  execute
    .mockResolvedValueOnce({ stdout: JSON.stringify(prepared), stderr: "" })
    .mockResolvedValueOnce({ stdout: JSON.stringify({ ...expanded, ...change }), stderr: "" });
  await expect(
    installedMacPickerDriver(
      "cancel_save_directory_expanded",
      "/private/directory",
      () => ({}),
      "json",
    )(42),
  ).rejects.toThrow("Native macOS Save expansion:");
  expect(execute).toHaveBeenCalledTimes(2);
});
it("redacts expansion process failures and retains no private cause or continuation", async () => {
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  execute
    .mockResolvedValueOnce({ stdout: JSON.stringify(prepared), stderr: "" })
    .mockRejectedValueOnce({ code: 1, message: "/private/command", stderr: "/private/error" });
  let failure: unknown;
  try {
    await installedMacPickerDriver(
      "cancel_save_directory_expanded",
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

it("stops before filename input when restoration cannot prove native collapse", async () => {
  execute
    .mockResolvedValueOnce({ stdout: JSON.stringify(prepared), stderr: "" })
    .mockResolvedValueOnce({ stdout: JSON.stringify(expanded), stderr: "" })
    .mockResolvedValueOnce({ stdout: JSON.stringify(snapshot), stderr: "" })
    .mockResolvedValueOnce({ stdout: JSON.stringify(directorySnapshot), stderr: "" })
    .mockResolvedValueOnce({ stdout: JSON.stringify(filenameSnapshot), stderr: "" })
    .mockResolvedValueOnce({
      stdout: JSON.stringify({ ...expanded, initialValue: 1, finalValue: 1 }),
      stderr: "",
    });
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  await expect(
    installedMacPickerDriver(
      "cancel_save_directory_expanded",
      "/private/directory",
      () => ({}),
      "json",
    )(42),
  ).rejects.toThrow("Native macOS Save expansion");
  expect(execute).toHaveBeenCalledTimes(6);
});

it("stops before restoration or filename input when selected-directory proof fails", async () => {
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  execute
    .mockResolvedValueOnce({ stdout: JSON.stringify(prepared), stderr: "" })
    .mockResolvedValueOnce({ stdout: JSON.stringify(expanded), stderr: "" })
    .mockResolvedValueOnce({ stdout: JSON.stringify(snapshot), stderr: "" })
    .mockResolvedValueOnce({
      stdout: JSON.stringify({ ...directorySnapshot, complete: false }),
      stderr: "",
    });
  await expect(
    installedMacPickerDriver(
      "cancel_save_directory_expanded",
      "/private/directory",
      () => ({}),
      "json",
    )(42),
  ).rejects.toThrow("Native macOS AX probe:");
  expect(execute).toHaveBeenCalledTimes(4);
});

it("redacts selected-directory process failures without continuation or a raw cause", async () => {
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  execute
    .mockResolvedValueOnce({ stdout: JSON.stringify(prepared), stderr: "" })
    .mockResolvedValueOnce({ stdout: JSON.stringify(expanded), stderr: "" })
    .mockResolvedValueOnce({ stdout: JSON.stringify(snapshot), stderr: "" })
    .mockRejectedValueOnce({ code: 1, message: "/private/command", stderr: "/private/error" });
  let failure: unknown;
  try {
    await installedMacPickerDriver(
      "cancel_save_directory_expanded",
      "/private/directory",
      () => ({}),
      "json",
    )(42);
  } catch (error) {
    failure = error;
  }
  expect(String(failure)).toContain("exit_code=1");
  expect(String(failure)).not.toContain("private");
  expect(failure).not.toHaveProperty("cause");
  expect(execute).toHaveBeenCalledTimes(4);
});

const vanishedSnapshot = {
  ...snapshot,
  complete: false,
  firstOtherVisited: 52,
  firstOtherError: -25202,
  firstOtherAttribute: "AXRole",
  firstOtherStage: "selection",
  firstOtherOrigin: "AXChildren",
  firstOtherParentRole: "AXScrollArea",
  action: { requested: "open", pressed: false, dismissed: false },
  invalidChildParent: {
    status: "complete",
    role: "AXScrollArea",
    pidMatches: true,
    selectedReference: false,
    children: 14,
    containsFailedReference: "false",
    attribute: "none",
    error: 0,
  },
  staleSnapshot: {
    eligible: true,
    traversalComplete: true,
    candidates: 2,
    allVanished: true,
    onlyInvalidChildErrors: true,
  },
  counts: {
    ...snapshot.counts,
    windows: 1,
    sheets: 1,
    buttons: 1,
    visited: 110,
    selectedRoots: 9,
    selectedUrls: 1,
    selectedExactUrls: 1,
    selectedLeaves: 1,
    leafMatches: 1,
    otherErrors: 16,
  },
};
const freshOpen = {
  ...snapshot,
  verified: true,
  foreground: true,
  guardMask: 255,
  stage: "complete",
  action: { requested: "open", pressed: true, dismissed: true },
  counts: { ...vanishedSnapshot.counts, otherErrors: 0 },
};
it("takes one complete fresh native snapshot before action when every invalid child is proven vanished", async () => {
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const responses = [
    { prepared: true, nativePress: false, navigationDismissed: true },
    vanishedSnapshot,
    freshOpen,
  ];
  execute.mockImplementation(async () => {
    now += 300;
    return { stdout: JSON.stringify(responses.shift()), stderr: "" };
  });
  await installedMacPickerDriver("open", "/private/fixture.wav", () => ({ LANG: "en_US.UTF-8" }))(
    42,
  );
  expect(execute).toHaveBeenCalledTimes(3);
  expect(execute.mock.calls[1]?.[1]).toEqual(["42", "/private/fixture.wav", "open"]);
  expect(execute.mock.calls[2]?.[1]).toEqual(execute.mock.calls[1]?.[1]);
  expect(execute.mock.calls.map((call) => call[2].timeout)).toEqual([100000, 7000, 6700]);
  for (const call of execute.mock.calls) expect(call[2].env).toEqual({ LANG: "en_US.UTF-8" });
});

it("does not refresh again if the complete second snapshot also fails", async () => {
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  execute
    .mockResolvedValueOnce({
      stdout: JSON.stringify({ prepared: true, nativePress: false, navigationDismissed: true }),
      stderr: "",
    })
    .mockResolvedValue({ stdout: JSON.stringify(vanishedSnapshot), stderr: "" });
  await expect(
    installedMacPickerDriver("open", "/private/fixture.wav", () => ({}))(42),
  ).rejects.toThrow("Native macOS AX probe:");
  expect(execute).toHaveBeenCalledTimes(3);
});
it("never refreshes after a native action has started", async () => {
  execute
    .mockResolvedValueOnce({
      stdout: JSON.stringify({ prepared: true, nativePress: false, navigationDismissed: true }),
      stderr: "",
    })
    .mockResolvedValue({
      stdout: JSON.stringify({
        ...vanishedSnapshot,
        guardMask: 255,
        stage: "press",
        pressDurationMs: 1,
      }),
      stderr: "",
    });
  await expect(
    installedMacPickerDriver("open", "/private/fixture.wav", () => ({}))(42),
  ).rejects.toThrow("Native macOS AX probe:");
  expect(execute).toHaveBeenCalledTimes(2);
});
it("uses the same bounded fresh-snapshot rule for selected-file Cancel", async () => {
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  execute
    .mockResolvedValueOnce({
      stdout: JSON.stringify({ prepared: true, nativePress: false, navigationDismissed: true }),
      stderr: "",
    })
    .mockResolvedValueOnce({
      stdout: JSON.stringify({
        ...vanishedSnapshot,
        action: { ...vanishedSnapshot.action, requested: "cancel_open_existing" },
      }),
      stderr: "",
    })
    .mockResolvedValueOnce({
      stdout: JSON.stringify({
        ...freshOpen,
        action: { ...freshOpen.action, requested: "cancel_open_existing" },
      }),
      stderr: "",
    });
  await installedMacPickerDriver("cancel_open_existing", "/private/fixture.wav", () => ({}))(42);
  expect(execute).toHaveBeenCalledTimes(3);
});
it.each([6999.6, 7001])(
  "refuses another snapshot with less than one millisecond remaining after %s ms",
  async (elapsed) => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    execute
      .mockResolvedValueOnce({
        stdout: JSON.stringify({ prepared: true, nativePress: false, navigationDismissed: true }),
        stderr: "",
      })
      .mockImplementationOnce(async () => {
        now = elapsed;
        return { stdout: JSON.stringify(vanishedSnapshot), stderr: "" };
      });
    await expect(
      installedMacPickerDriver("open", "/private/fixture.wav", () => ({}))(42),
    ).rejects.toThrow("AX probe deadline exceeded");
    expect(execute).toHaveBeenCalledTimes(2);
  },
);

it.each([
  { verified: false },
  { labelAttached: false },
  { fieldAttached: false },
  { error: -25202, status: "error", attribute: "pid" },
])(
  "stops before collapse or filename input after rejected native filename proof %j",
  async (change) => {
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const responses = [
      prepared,
      expanded,
      snapshot,
      directorySnapshot,
      { ...filenameSnapshot, saveFilename: { ...filenameSnapshot.saveFilename, ...change } },
    ];
    execute.mockImplementation(async () => ({
      stdout: JSON.stringify(responses.shift()),
      stderr: "",
    }));
    await expect(
      installedMacPickerDriver(
        "cancel_save_directory_expanded",
        "/private/directory",
        () => ({}),
        "json",
      )(42),
    ).rejects.toThrow("Native macOS AX probe:");
    expect(execute).toHaveBeenCalledTimes(5);
  },
);

const jsonSaved = {
  ...filenameSnapshot,
  saveTargetAbsent: true,
  stage: "complete",
  action: { requested: "save_new_json", pressed: true, dismissed: true },
};
it("saves JSON once after independent proofs without collapse, filename input or Cancel", async () => {
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const responses = [prepared, expanded, snapshot, directorySnapshot, filenameSnapshot, jsonSaved];
  execute.mockImplementation(async () => ({
    stdout: JSON.stringify(responses.shift()),
    stderr: "",
  }));
  await installedMacPickerDriver(
    "save_json",
    "/private/directory",
    () => ({ LANG: "en_US.UTF-8" }),
    "json",
  )(42);
  expect(execute).toHaveBeenCalledTimes(6);
  expect(execute.mock.calls[5]?.[1]).toEqual([
    "42",
    "/private/directory",
    "directory_snapshot",
    "json",
    "--save-new-json",
  ]);
  for (const call of execute.mock.calls) expect(call[2].env).toEqual({ LANG: "en_US.UTF-8" });
});
it.each([
  { saveTargetAbsent: false },
  { action: { requested: "save_new_json", pressed: true, dismissed: false } },
])("does not retry a refused JSON Save %j", async (change) => {
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const responses = [
    prepared,
    expanded,
    snapshot,
    directorySnapshot,
    filenameSnapshot,
    { ...jsonSaved, ...change },
  ];
  execute.mockImplementation(async () => ({
    stdout: JSON.stringify(responses.shift()),
    stderr: "",
  }));
  await expect(
    installedMacPickerDriver("save_json", "/private/directory", () => ({}), "json")(42),
  ).rejects.toThrow("Native macOS AX probe");
  expect(execute).toHaveBeenCalledTimes(6);
});
it("refuses non-JSON Save before starting any native process", async () => {
  await expect(
    installedMacPickerDriver("save_json", "/private/directory", () => ({}), "pdf")(42),
  ).rejects.toThrow("JSON Save target unavailable");
  expect(execute).not.toHaveBeenCalled();
});

it.each(["json", "lrc", "chordpro", "pdf", "archive"] as const)(
  "publishes %s once from a guarded retained expanded panel without collapse or input",
  async (format) => {
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const responses = [
      { ...prepared, saveFieldProbe: { ...probe, format } },
      { ...expanded, pressed: false, initialValue: 1, finalValue: 1 },
      snapshot,
      directorySnapshot,
      filenameSnapshot,
      { ...jsonSaved, action: { requested: `save_new_${format}`, pressed: true, dismissed: true } },
    ];
    execute.mockImplementation(async () => {
      now += 300;
      return { stdout: JSON.stringify(responses.shift()), stderr: "" };
    });
    await installedMacPickerDriver(
      `save_${format}`,
      "/private/directory",
      () => ({ LANG: "en_US.UTF-8" }),
      format,
    )(42);
    expect(execute).toHaveBeenCalledTimes(6);
    expect(execute.mock.calls[0]?.[1]).toContain("prepare_save_directory_retained");
    expect(execute.mock.calls[1]?.[1]).toEqual(["42", "--ensure-expanded"]);
    expect(execute.mock.calls[5]?.[1]).toEqual([
      "42",
      "/private/directory",
      "directory_snapshot",
      format,
      format === "json"
        ? "--save-new-json"
        : format === "pdf"
          ? "--save-new-pdf"
          : format === "archive"
            ? "--save-new-archive"
            : "--save-new-text",
    ]);
    expect(execute.mock.calls.map((call) => call[2].timeout)).toEqual([
      100000, 7000, 7000, 7000, 7000, 7000,
    ]);
    for (const call of execute.mock.calls) expect(call[2].env).toEqual({ LANG: "en_US.UTF-8" });
  },
);
it("refuses mismatched text format before any native process", async () => {
  await expect(
    installedMacPickerDriver("save_lrc", "/private/directory", () => ({}), "chordpro")(42),
  ).rejects.toThrow("text Save target unavailable");
  expect(execute).not.toHaveBeenCalled();
});

it.each(["json", "lrc", "chordpro", "archive", undefined] as const)(
  "refuses mismatched PDF format %s before starting a native process",
  async (format) => {
    await expect(
      installedMacPickerDriver("save_pdf", "/private/directory", () => ({}), format)(42),
    ).rejects.toThrow("PDF Save target unavailable");
    expect(execute).not.toHaveBeenCalled();
  },
);
it("refuses a missing PDF directory before starting a native process", async () => {
  await expect(
    installedMacPickerDriver("save_pdf", undefined, () => ({}), "pdf")(42),
  ).rejects.toThrow("PDF Save target unavailable");
  expect(execute).not.toHaveBeenCalled();
});
it.each([
  { saveTargetAbsent: false },
  { action: { requested: "save_new_json", pressed: true, dismissed: true } },
  { action: { requested: "save_new_pdf", pressed: true, dismissed: false } },
  { saveFilename: { ...filenameSnapshot.saveFilename, verified: false } },
])("does not retry a refused PDF Save %j", async (change) => {
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const responses = [
    { ...prepared, saveFieldProbe: { ...probe, format: "pdf" } },
    expanded,
    snapshot,
    directorySnapshot,
    filenameSnapshot,
    {
      ...jsonSaved,
      action: { requested: "save_new_pdf", pressed: true, dismissed: true },
      ...change,
    },
  ];
  execute.mockImplementation(async () => ({
    stdout: JSON.stringify(responses.shift()),
    stderr: "",
  }));
  await expect(
    installedMacPickerDriver("save_pdf", "/private/directory", () => ({}), "pdf")(42),
  ).rejects.toThrow("Native macOS AX probe");
  expect(execute).toHaveBeenCalledTimes(6);
});

it.each(["json", "lrc", "chordpro", "pdf", undefined] as const)(
  "refuses mismatched archive format %s before any native process",
  async (format) => {
    await expect(
      installedMacPickerDriver("save_archive", "/private/directory", () => ({}), format)(42),
    ).rejects.toThrow("archive Save target unavailable");
    expect(execute).not.toHaveBeenCalled();
  },
);
it("refuses a missing archive directory before any native process", async () => {
  await expect(
    installedMacPickerDriver("save_archive", undefined, () => ({}), "archive")(42),
  ).rejects.toThrow("archive Save target unavailable");
  expect(execute).not.toHaveBeenCalled();
});
it.each([
  { saveTargetAbsent: false },
  { action: { requested: "save_new_json", pressed: true, dismissed: true } },
  { action: { requested: "save_new_archive", pressed: true, dismissed: false } },
  { saveFilename: { ...filenameSnapshot.saveFilename, verified: false } },
])("does not retry a refused archive Save %j", async (change) => {
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const responses = [
    { ...prepared, saveFieldProbe: { ...probe, format: "archive" } },
    expanded,
    snapshot,
    directorySnapshot,
    filenameSnapshot,
    {
      ...jsonSaved,
      action: { requested: "save_new_archive", pressed: true, dismissed: true },
      ...change,
    },
  ];
  execute.mockImplementation(async () => ({
    stdout: JSON.stringify(responses.shift()),
    stderr: "",
  }));
  await expect(
    installedMacPickerDriver("save_archive", "/private/directory", () => ({}), "archive")(42),
  ).rejects.toThrow("Native macOS AX probe");
  expect(execute).toHaveBeenCalledTimes(6);
});

it.each(["not_checked", "true", "false", "unavailable"])(
  "reports the fixed guard enabled state %s without changing refusal",
  (guardEnabledState) => {
    const result = installedMacAxProbeDiagnostic(
      JSON.stringify({ ...snapshot, guardEnabledState, guardMask: 223 }),
      undefined,
      0,
    );
    expect(result).toContain(`guard_enabled=${guardEnabledState}`);
    expect(result).toContain("guard_mask=223");
  },
);
it("redacts unexpected guard enabled evidence", () => {
  const result = installedMacAxProbeDiagnostic(
    JSON.stringify({ ...snapshot, guardEnabledState: "/private/fixture" }),
    undefined,
    0,
  );
  expect(result).not.toContain("/private/fixture");
  expect(result).not.toContain("guard_enabled=");
});

it("reports a first failure parent independently from a later invalid-role candidate", () => {
  const result = installedMacAxProbeDiagnostic(
    JSON.stringify({
      ...snapshot,
      firstFailureParent: {
        ...snapshot.invalidChildParent,
        status: "complete",
        role: "AXScrollArea",
        pidMatches: true,
        children: 14,
        containsFailedReference: "false",
      },
    }),
    undefined,
    0,
  );
  expect(result).toContain("first_failure_parent_status=complete");
  expect(result).toContain("first_failure_parent_containsFailedReference=false");
  expect(result).toContain("invalid_child_parent_status=not_checked");
});
it("redacts private or unbounded first-failure parent evidence", () => {
  for (const bad of [
    { role: "/private/role" },
    { children: 258 },
    { containsFailedReference: "/private/ref" },
  ]) {
    const result = installedMacAxProbeDiagnostic(
      JSON.stringify({
        ...snapshot,
        firstFailureParent: { ...snapshot.invalidChildParent, ...bad },
      }),
      undefined,
      0,
    );
    expect(result).toBe("Native macOS AX probe: invalid_evidence");
  }
});

const replaceObserved = {
  ...filenameSnapshot,
  saveTargetExistingFixture: true,
  saveTargetAbsent: false,
  stage: "replace_observed",
  action: { requested: "observe_replace_json", pressed: true, dismissed: false },
  replaceContext: {
    status: "complete",
    visited: 20,
    windows: 1,
    sheets: 2,
    dialogs: 0,
    buttons: 4,
    cancel: 2,
    replace: 1,
    save: 1,
    other: 14,
    foreground: true,
    error: 0,
    modalCandidates: 1,
    modalStatus: "complete",
    modalError: 0,
    modalVisited: 6,
    modalButtons: 2,
    modalCancel: 1,
    modalReplace: 1,
    modalEnabledCancel: 1,
    modalEnabledReplace: 1,
    modalBindingStatus: "complete",
    modalBindingParent: "sheet",
    modalBindingMatches: 1,
    modalBindingSheetAttached: true,
    modalBindingForeground: true,
    modalBindingError: 0,
    modalBindingAttribute: "none",
  },
};
it("observes replacement with one guarded Save and no confirmation or Cancel action", async () => {
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const responses = [
    prepared,
    expanded,
    snapshot,
    directorySnapshot,
    filenameSnapshot,
    replaceObserved,
  ];
  execute.mockImplementation(async () => ({
    stdout: JSON.stringify(responses.shift()),
    stderr: "",
  }));
  await installedMacPickerDriver(
    "observe_replace_json",
    "/private/directory",
    () => ({}),
    "json",
  )(42);
  expect(execute).toHaveBeenCalledTimes(6);
  expect(execute.mock.calls[5]?.[1]).toEqual([
    "42",
    "/private/directory",
    "directory_snapshot",
    "json",
    "--observe-replace-json",
  ]);
});
it.each([
  { saveTargetExistingFixture: false },
  { guardMask: 254 },
  { replaceContext: { ...replaceObserved.replaceContext, status: "error", error: -25202 } },
  {
    replaceContext: {
      ...replaceObserved.replaceContext,
      modalCandidates: 0,
      modalStatus: "not_checked",
    },
  },
  { replaceContext: { ...replaceObserved.replaceContext, modalBindingSheetAttached: false } },
])("does not retry a refused replacement observation %j", async (change) => {
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const responses = [
    prepared,
    expanded,
    snapshot,
    directorySnapshot,
    filenameSnapshot,
    { ...replaceObserved, ...change },
  ];
  execute.mockImplementation(async () => ({
    stdout: JSON.stringify(responses.shift()),
    stderr: "",
  }));
  await expect(
    installedMacPickerDriver("observe_replace_json", "/private/directory", () => ({}), "json")(42),
  ).rejects.toThrow("Native macOS AX probe:");
  expect(execute).toHaveBeenCalledTimes(6);
});

it.each([
  { target: undefined, format: "json" as const },
  { target: "/private/directory", format: "lrc" as const },
])(
  "refuses replacement observation before native execution without a JSON target %j",
  async ({ target, format }) => {
    await expect(
      installedMacPickerDriver("observe_replace_json", target, () => ({}), format)(42),
    ).rejects.toThrow("Native macOS JSON Save target unavailable");
    expect(execute).not.toHaveBeenCalled();
  },
);

it("never retries failed Save despite a complete post-failure replacement snapshot", async () => {
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const responses = [
    prepared,
    expanded,
    snapshot,
    directorySnapshot,
    filenameSnapshot,
    {
      ...replaceObserved,
      lastError: -25205,
      stage: "press",
      pressDurationMs: 90,
      pressSheetState: "attached_sheet",
      action: { requested: "observe_replace_json", pressed: false, dismissed: false },
    },
  ];
  execute.mockImplementation(async () => ({
    stdout: JSON.stringify(responses.shift()),
    stderr: "",
  }));
  await expect(
    installedMacPickerDriver("observe_replace_json", "/private/directory", () => ({}), "json")(42),
  ).rejects.toThrow("last_error=-25205");
  expect(execute).toHaveBeenCalledTimes(6);
});

it("allows larger replacement evidence only for the final explicit observation process", async () => {
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const responses = [
    prepared,
    expanded,
    snapshot,
    directorySnapshot,
    filenameSnapshot,
    replaceObserved,
  ];
  execute.mockImplementation(async () => {
    const value = responses.shift();
    return {
      stdout: JSON.stringify(value).padEnd(value === replaceObserved ? 4878 : 0, " "),
      stderr: "",
    };
  });
  await installedMacPickerDriver(
    "observe_replace_json",
    "/private/directory",
    () => ({}),
    "json",
  )(42);
  expect(execute.mock.calls.map((call) => call[2].maxBuffer)).toEqual([
    65536, 4096, 4096, 4096, 4096, 8192,
  ]);
});

const cancelledReplacement = {
  ...replaceObserved,
  action: { requested: "cancel_replace_json", pressed: true, dismissed: false },
  replaceContext: {
    ...replaceObserved.replaceContext,
    cancelStatus: "complete",
    cancelGuardMask: 255,
    cancelPressed: true,
    cancelDismissed: true,
    cancelSheetRetained: true,
    cancelTargetUnchanged: true,
    cancelError: 0,
    cancelChainVisited: 3,
  },
};
it("uses the JSON-only replacement Cancel flag after fresh directory and filename proof", async () => {
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const responses = [
    prepared,
    expanded,
    snapshot,
    directorySnapshot,
    filenameSnapshot,
    cancelledReplacement,
  ];
  execute.mockImplementation(async () => ({
    stdout: JSON.stringify(responses.shift()),
    stderr: "",
  }));
  await installedMacPickerDriver(
    "cancel_replace_json",
    "/private/directory",
    () => ({}),
    "json",
  )(42);
  expect(execute).toHaveBeenCalledTimes(6);
  expect(execute.mock.calls[5]?.[1]).toEqual([
    "42",
    "/private/directory",
    "directory_snapshot",
    "json",
    "--cancel-replace-json",
  ]);
  expect(execute.mock.calls.map((call) => call[2].maxBuffer)).toEqual([
    65536, 4096, 4096, 4096, 4096, 8192,
  ]);
});
it.each([
  { cancelPressed: false },
  { cancelDismissed: false },
  { cancelSheetRetained: false },
  { cancelTargetUnchanged: false },
  { cancelGuardMask: 254 },
  { cancelError: -25205 },
])("does not retry failed replacement confirmation Cancel %j", async (change) => {
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const responses = [
    prepared,
    expanded,
    snapshot,
    directorySnapshot,
    filenameSnapshot,
    {
      ...cancelledReplacement,
      replaceContext: { ...cancelledReplacement.replaceContext, ...change },
    },
  ];
  execute.mockImplementation(async () => ({
    stdout: JSON.stringify(responses.shift()),
    stderr: "",
  }));
  await expect(
    installedMacPickerDriver("cancel_replace_json", "/private/directory", () => ({}), "json")(42),
  ).rejects.toThrow("Native macOS AX probe:");
  expect(execute).toHaveBeenCalledTimes(6);
});
it("rejects non-JSON replacement Cancel before any native process", async () => {
  await expect(
    installedMacPickerDriver(
      "cancel_replace_json",
      "/private/directory",
      () => ({}),
      "archive",
    )(42),
  ).rejects.toThrow("JSON Save target unavailable");
  expect(execute).not.toHaveBeenCalled();
});

const confirmedJsonReplacement = {
  ...replaceObserved,
  action: { requested: "replace_json", pressed: true, dismissed: false },
  replaceContext: {
    ...replaceObserved.replaceContext,
    saveActionStatus: "not_checked",
    savePressAction: "unknown",
    saveActionError: 0,
    replaceStatus: "complete",
    replaceGuardMask: 255,
    replacePressed: true,
    replaceDismissed: true,
    replaceSaveDismissed: true,
    replaceTargetFixtureVerified: true,
    replaceError: 0,
    replaceChainVisited: 2,
  },
};
it("uses JSON-only Replace after independent directory and filename verification", async () => {
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const responses = [
    prepared,
    expanded,
    snapshot,
    directorySnapshot,
    filenameSnapshot,
    confirmedJsonReplacement,
  ];
  execute.mockImplementation(async () => ({
    stdout: JSON.stringify(responses.shift()),
    stderr: "",
  }));
  await installedMacPickerDriver("replace_json", "/private/directory", () => ({}), "json")(42);
  expect(execute).toHaveBeenCalledTimes(6);
  expect(execute.mock.calls[5]?.[1]).toEqual([
    "42",
    "/private/directory",
    "directory_snapshot",
    "json",
    "--replace-json",
  ]);
  expect(execute.mock.calls.map((call) => call[2].maxBuffer)).toEqual([
    65536, 4096, 4096, 4096, 4096, 8192,
  ]);
});
it.each([
  { replaceGuardMask: 254 },
  { replacePressed: false },
  { replaceDismissed: false },
  { replaceSaveDismissed: false },
  { replaceTargetFixtureVerified: false },
  { replaceError: -25205 },
])("refuses failed Replace without another native action %j", async (change) => {
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const responses = [
    prepared,
    expanded,
    snapshot,
    directorySnapshot,
    filenameSnapshot,
    {
      ...confirmedJsonReplacement,
      replaceContext: { ...confirmedJsonReplacement.replaceContext, ...change },
    },
  ];
  execute.mockImplementation(async () => ({
    stdout: JSON.stringify(responses.shift()),
    stderr: "",
  }));
  await expect(
    installedMacPickerDriver("replace_json", "/private/directory", () => ({}), "json")(42),
  ).rejects.toThrow("Native macOS AX probe:");
  expect(execute).toHaveBeenCalledTimes(6);
});
it("rejects other formats for Replace before starting native processes", async () => {
  await expect(
    installedMacPickerDriver("replace_json", "/private/directory", () => ({}), "pdf")(42),
  ).rejects.toThrow("JSON Save target unavailable");
  expect(execute).not.toHaveBeenCalled();
});

import { expect, it } from "vitest";

import {
  WindowsReplacementDiagnosticSchema,
  WindowsReplacementObservationSchema,
} from "./support/installed-windows-replace-context.ts";

const evidence = () => ({
  action: "observe_replace",
  filenameSet: true,
  nativeClick: true,
  defaultNameValid: true,
  targetFixtureVerified: true,
  context: {
    status: "complete",
    capturedExists: true,
    capturedVisible: true,
    capturedEnabled: false,
    foregroundOwned: true,
    foregroundSave: false,
    windows: 2,
    otherDialogs: 1,
    ownedBySave: 1,
    buttons: 2,
    yes: 1,
    no: 1,
    cancel: 0,
    replace: 0,
    other: 0,
  },
});
it("retains only fixed observational fields, without authorizing any confirmation action", () => {
  expect(WindowsReplacementObservationSchema.parse(evidence())).toEqual(evidence());
});
it("can report a complete inventory without claiming that a confirmation was observed", () => {
  const value = evidence();
  Object.assign(value.context, {
    windows: 1,
    otherDialogs: 0,
    ownedBySave: 0,
    buttons: 0,
    yes: 0,
    no: 0,
  });
  expect(WindowsReplacementObservationSchema.safeParse(value).success).toBe(true);
});
it.each(["action", "filenameSet", "nativeClick", "defaultNameValid", "targetFixtureVerified"])(
  "rejects missing required %s",
  (field) => {
    const value: Record<string, unknown> = evidence();
    delete value[field];
    expect(WindowsReplacementObservationSchema.safeParse(value).success).toBe(false);
  },
);
it.each([
  ["status", "deadline"],
  ["status", "read_error"],
  ["capturedExists", false],
  ["foregroundOwned", false],
  ["windows", 17],
  ["windows", 0],
  ["otherDialogs", 2],
  ["ownedBySave", 2],
  ["buttons", 257],
  ["yes", 2],
  ["no", -1],
  ["cancel", 0.5],
  ["replace", "/private"],
] as const)("refuses incomplete or invalid %s evidence", (field, replacement) => {
  const value = evidence();
  Object.assign(value.context, { [field]: replacement });
  expect(WindowsReplacementObservationSchema.safeParse(value).success).toBe(false);
});
it("rejects untrusted raw paths, UI strings and identifiers at either level", () => {
  for (const field of ["path", "title", "pid", "handle", "error"]) {
    const value = evidence();
    expect(
      WindowsReplacementObservationSchema.safeParse({ ...value, [field]: "/private" }).success,
    ).toBe(false);
    expect(
      WindowsReplacementObservationSchema.safeParse({
        ...value,
        context: { ...value.context, [field]: "/private" },
      }).success,
    ).toBe(false);
  }
});

it("retains bounded refusal diagnostics while refusing them as accepted observations", () => {
  const value = evidence();
  Object.assign(value.context, {
    status: "read_error",
    capturedExists: false,
    foregroundOwned: false,
  });
  expect(WindowsReplacementDiagnosticSchema.safeParse(value).success).toBe(true);
  expect(WindowsReplacementObservationSchema.safeParse(value).success).toBe(false);
});

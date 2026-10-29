import { expect, it } from "vitest";

import {
  WindowsReplacementDiagnosticSchema,
  WindowsReplacementObservationSchema,
  WindowsReplacementBoundObservationSchema,
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

const boundEvidence = () => ({
  ...evidence(),
  binding: {
    status: "complete",
    guardMask: 255,
    yesRefusalMask: 0,
    noRefusalMask: 0,
    candidates: 1,
    buttons: 2,
    yes: 1,
    no: 1,
  },
});
it("requires a fresh bound snapshot in addition to the original complete inventory", () => {
  expect(WindowsReplacementBoundObservationSchema.parse(boundEvidence())).toEqual(boundEvidence());
  expect(WindowsReplacementBoundObservationSchema.safeParse(evidence()).success).toBe(false);
});
it.each([1, 2, 4, 8, 16, 32, 64, 128])("refuses a missing binding guard bit %i", (bit) => {
  const value = boundEvidence();
  value.binding.guardMask &= ~bit;
  expect(WindowsReplacementBoundObservationSchema.safeParse(value).success).toBe(false);
});
it.each([
  ["status", "refused"],
  ["status", "deadline"],
  ["status", "bound"],
  ["status", "read_error"],
  ["candidates", 0],
  ["candidates", 2],
  ["buttons", 3],
  ["yes", 0],
  ["yes", 2],
  ["no", 0],
  ["no", 2],
  ["yesRefusalMask", 239],
  ["noRefusalMask", 191],
] as const)("retains fixed refusal evidence but rejects it as bound: %s=%s", (field, value) => {
  const changed = boundEvidence();
  Object.assign(changed.binding, { [field]: value });
  expect(WindowsReplacementDiagnosticSchema.safeParse(changed).success).toBe(true);
  expect(WindowsReplacementBoundObservationSchema.safeParse(changed).success).toBe(false);
});

it.each(["yesRefusalMask", "noRefusalMask"])("rejects malformed %s diagnostics", (field) => {
  for (const value of [-1, 256, 0.5, "/private", null]) {
    const changed = boundEvidence();
    Object.assign(changed.binding, { [field]: value });
    expect(WindowsReplacementDiagnosticSchema.safeParse(changed).success).toBe(false);
  }
});
it.each([
  ["capturedVisible", false],
  ["capturedEnabled", true],
  ["foregroundSave", true],
  ["otherDialogs", 0],
  ["ownedBySave", 0],
  ["yes", 0],
  ["no", 0],
  ["cancel", 1],
  ["replace", 1],
  ["other", 1],
] as const)("refuses a bound claim inconsistent with prior context %s", (field, value) => {
  const changed = boundEvidence();
  Object.assign(changed.context, { [field]: value });
  expect(WindowsReplacementBoundObservationSchema.safeParse(changed).success).toBe(false);
});
it.each(["status", "guardMask", "candidates", "buttons", "yes", "no"])(
  "rejects incomplete binding evidence missing %s",
  (field) => {
    const changed = boundEvidence();
    delete (changed.binding as Record<string, unknown>)[field];
    expect(WindowsReplacementDiagnosticSchema.safeParse(changed).success).toBe(false);
  },
);
it("rejects raw native identities, titles, paths and action claims in binding output", () => {
  for (const field of ["pid", "handle", "title", "path", "error", "pressed"]) {
    const value = boundEvidence();
    expect(
      WindowsReplacementDiagnosticSchema.safeParse({
        ...value,
        binding: { ...value.binding, [field]: "/private" },
      }).success,
    ).toBe(false);
  }
});

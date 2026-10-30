import { expect, it } from "vitest";

import {
  WindowsReplacementCancellationDiagnosticSchema,
  WindowsReplacementCancellationSchema,
  WindowsReplacementPublicationDiagnosticSchema,
  WindowsReplacementPublicationSchema,
  WindowsReplacementDiagnosticSchema,
  WindowsReplacementObservationSchema,
  WindowsReplacementBoundObservationSchema,
  WindowsReplacementNoInputObservationSchema,
  WindowsReplacementYesInputObservationSchema,
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
    yesBinding: "classic_direct",
    noBinding: "classic_direct",
    recheckStatus: "complete",
    recheckButtons: 2,
    recheckYes: 1,
    recheckNo: 1,
    recheckMatches: true,
    candidates: 1,
    buttons: 2,
    yes: 1,
    no: 1,
  },
});
const noInputEvidence = () => {
  const value = boundEvidence();
  return {
    ...value,
    binding: { ...value.binding, noInputGuard: { status: "complete", guardMask: 255 } },
  };
};
it("requires an independently complete No input guard in addition to the complete binding", () => {
  expect(WindowsReplacementNoInputObservationSchema.safeParse(noInputEvidence()).success).toBe(
    true,
  );
  expect(WindowsReplacementNoInputObservationSchema.safeParse(boundEvidence()).success).toBe(false);
});
it.each([1, 2, 4, 8, 16, 32, 64, 128])("refuses missing No input guard bit %i", (bit) => {
  const value = noInputEvidence();
  value.binding.noInputGuard.guardMask &= ~bit;
  expect(WindowsReplacementNoInputObservationSchema.safeParse(value).success).toBe(false);
});
it.each(["not_checked", "refused", "deadline", "read_error"])(
  "retains fixed %s No guard refusal without accepting it",
  (status) => {
    const value = noInputEvidence();
    value.binding.noInputGuard.status = status;
    expect(WindowsReplacementDiagnosticSchema.safeParse(value).success).toBe(true);
    expect(WindowsReplacementNoInputObservationSchema.safeParse(value).success).toBe(false);
  },
);
it("rejects private fields and impossible masks in the No input probe", () => {
  for (const extra of [
    { x: 100 },
    { y: 200 },
    { handle: 123 },
    { pid: 123 },
    { title: "/private" },
    { guardMask: 256 },
    { guardMask: -1 },
  ]) {
    const value = noInputEvidence();
    Object.assign(value.binding.noInputGuard, extra);
    expect(WindowsReplacementDiagnosticSchema.safeParse(value).success).toBe(false);
  }
});
it("requires a fresh bound snapshot in addition to the original complete inventory", () => {
  expect(WindowsReplacementBoundObservationSchema.parse(boundEvidence())).toEqual(boundEvidence());
  expect(WindowsReplacementBoundObservationSchema.safeParse(evidence()).success).toBe(false);
});
it.each(["recheckStatus", "recheckButtons", "recheckYes", "recheckNo", "recheckMatches"])(
  "refuses an otherwise complete binding without fresh %s evidence",
  (field) => {
    const value = boundEvidence();
    delete (value.binding as Record<string, unknown>)[field];
    expect(WindowsReplacementBoundObservationSchema.safeParse(value).success).toBe(false);
  },
);
it("accepts a fully guarded modern-chain observation without treating control ID zero as identity", () => {
  const value = boundEvidence();
  Object.assign(value.binding, { yesBinding: "modern_chain", noBinding: "modern_chain" });
  expect(WindowsReplacementBoundObservationSchema.safeParse(value).success).toBe(true);
});
it.each(["yesBinding", "noBinding"])("rejects missing, refused or private %s", (field) => {
  for (const replacement of [undefined, "none", "/private"]) {
    const value = boundEvidence();
    Object.assign(value.binding, { [field]: replacement });
    expect(WindowsReplacementBoundObservationSchema.safeParse(value).success).toBe(false);
  }
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
  ["recheckStatus", "not_checked"],
  ["recheckStatus", "read_error"],
  ["recheckStatus", "deadline"],
  ["recheckStatus", "bound"],
  ["recheckStatus", "refused"],
  ["recheckButtons", 3],
  ["recheckButtons", 1],
  ["recheckYes", 0],
  ["recheckNo", 0],
  ["recheckMatches", false],
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

it("retains bounded button-parent evidence without accepting the original refused binding", () => {
  const value = boundEvidence();
  Object.assign(value.binding, {
    status: "refused",
    guardMask: 135,
    yesRefusalMask: 175,
    noRefusalMask: 175,
    yesFailure: { controlId: 100, parentStatus: "complete", parentDepth: 3, parentClassMask: 7 },
    noFailure: { controlId: 101, parentStatus: "complete", parentDepth: 3, parentClassMask: 7 },
  });
  expect(WindowsReplacementDiagnosticSchema.safeParse(value).success).toBe(true);
  expect(WindowsReplacementBoundObservationSchema.safeParse(value).success).toBe(false);
  Object.assign(value.binding, { yesBinding: "modern_chain", noBinding: "modern_chain" });
  expect(WindowsReplacementBoundObservationSchema.safeParse(value).success).toBe(false);
});
it("refuses contradictory failure-parent data in a complete binding claim", () => {
  const value = boundEvidence();
  Object.assign(value.binding, {
    yesFailure: { controlId: 100, parentStatus: "complete", parentDepth: 3, parentClassMask: 7 },
  });
  expect(WindowsReplacementDiagnosticSchema.safeParse(value).success).toBe(true);
  expect(WindowsReplacementBoundObservationSchema.safeParse(value).success).toBe(false);
});
it.each([
  ["controlId", -2],
  ["controlId", 65536],
  ["controlId", 1.5],
  ["parentStatus", "/private"],
  ["parentDepth", 17],
  ["parentDepth", -1],
  ["parentClassMask", 64],
  ["parentClassMask", 0.5],
  ["pid", 123],
  ["handle", 123],
  ["title", "private content"],
  ["path", "/private"],
] as const)("rejects malformed or private parent diagnostic %s", (field, replacement) => {
  const value = boundEvidence();
  Object.assign(value.binding, {
    yesFailure: {
      controlId: 0,
      parentStatus: "not_checked",
      parentDepth: 0,
      parentClassMask: 0,
      [field]: replacement,
    },
  });
  expect(WindowsReplacementDiagnosticSchema.safeParse(value).success).toBe(false);
});

const cancellationEvidence = () => ({
  action: "cancel_replace",
  observation: noInputEvidence(),
  cancellation: {
    status: "complete",
    guardMask: 255,
    freshNoInputGuard: { status: "complete", guardMask: 255 },
    censusMatches: true,
    pointUnchanged: true,
    cursorMatches: true,
    cursorMoved: true,
    attempted: true,
    sent: true,
    modalDismissed: true,
    saveRetained: true,
  },
});
it("requires fresh guarded No dispatch, strict modal disappearance and retained Save", () => {
  expect(WindowsReplacementCancellationSchema.parse(cancellationEvidence())).toEqual(
    cancellationEvidence(),
  );
  expect(WindowsReplacementCancellationSchema.safeParse(noInputEvidence()).success).toBe(false);
});
for (const field of [
  "censusMatches",
  "pointUnchanged",
  "cursorMatches",
  "cursorMoved",
  "attempted",
  "sent",
  "modalDismissed",
  "saveRetained",
] as const) {
  it(`refuses confirmation No when ${field} is false or missing`, () => {
    const value = cancellationEvidence();
    value.cancellation[field] = false;
    expect(WindowsReplacementCancellationSchema.safeParse(value).success).toBe(false);
    const missing = structuredClone(value) as { cancellation: Record<string, unknown> };
    delete missing.cancellation[field];
    expect(WindowsReplacementCancellationDiagnosticSchema.safeParse(missing).success).toBe(false);
  });
}
for (const bit of [1, 2, 4, 8, 16, 32, 64, 128]) {
  it(`refuses incomplete No action guard bit ${bit}`, () => {
    const value = cancellationEvidence();
    value.cancellation.guardMask &= ~bit;
    expect(WindowsReplacementCancellationSchema.safeParse(value).success).toBe(false);
  });
}
for (const status of ["not_checked", "refused", "deadline"]) {
  it(`retains fixed No ${status} evidence but refuses acceptance`, () => {
    const value = cancellationEvidence();
    value.cancellation.status = status;
    expect(WindowsReplacementCancellationDiagnosticSchema.safeParse(value).success).toBe(true);
    expect(WindowsReplacementCancellationSchema.safeParse(value).success).toBe(false);
  });
}
it("refuses No cancellation without the entire prior observation and binding", () => {
  for (const field of ["guardMask", "recheckButtons", "recheckYes", "recheckNo"] as const) {
    const value = cancellationEvidence();
    value.observation.binding[field] = 0;
    expect(WindowsReplacementCancellationSchema.safeParse(value).success).toBe(false);
  }
  const value = cancellationEvidence();
  value.observation.binding.noInputGuard.guardMask = 0;
  expect(WindowsReplacementCancellationSchema.safeParse(value).success).toBe(false);
});
for (const field of ["x", "y", "hwnd", "pid", "title", "path", "error"]) {
  it(`rejects private No action field ${field}`, () => {
    const value = cancellationEvidence();
    Object.assign(value.cancellation, { [field]: "private" });
    expect(WindowsReplacementCancellationDiagnosticSchema.safeParse(value).success).toBe(false);
  });
}

for (const bit of [1, 2, 4, 8, 16, 32, 64, 128]) {
  it(`refuses incomplete post-cursor No guard bit ${bit}`, () => {
    const value = cancellationEvidence();
    value.cancellation.freshNoInputGuard.guardMask &= ~bit;
    expect(WindowsReplacementCancellationSchema.safeParse(value).success).toBe(false);
  });
}
for (const status of ["not_checked", "refused", "deadline", "read_error"]) {
  it(`refuses post-cursor No guard status ${status}`, () => {
    const value = cancellationEvidence();
    value.cancellation.freshNoInputGuard.status = status;
    expect(WindowsReplacementCancellationSchema.safeParse(value).success).toBe(false);
  });
}

const bothInputEvidence = () => {
  const value = noInputEvidence();
  return {
    ...value,
    binding: { ...value.binding, yesInputGuard: { status: "complete", guardMask: 255 } },
  };
};
it("requires an independently complete Yes target as well as the No target and full binding", () => {
  expect(WindowsReplacementYesInputObservationSchema.parse(bothInputEvidence())).toEqual(
    bothInputEvidence(),
  );
  expect(WindowsReplacementYesInputObservationSchema.safeParse(noInputEvidence()).success).toBe(
    false,
  );
  expect(WindowsReplacementYesInputObservationSchema.safeParse(boundEvidence()).success).toBe(
    false,
  );
});
for (const bit of [1, 2, 4, 8, 16, 32, 64, 128]) {
  it(`refuses missing Yes target guard bit ${bit}`, () => {
    const value = bothInputEvidence();
    value.binding.yesInputGuard.guardMask &= ~bit;
    expect(WindowsReplacementYesInputObservationSchema.safeParse(value).success).toBe(false);
  });
}
for (const status of ["not_checked", "refused", "deadline", "read_error"]) {
  it(`retains fixed Yes ${status} evidence but refuses acceptance`, () => {
    const value = bothInputEvidence();
    value.binding.yesInputGuard.status = status;
    expect(WindowsReplacementDiagnosticSchema.safeParse(value).success).toBe(true);
    expect(WindowsReplacementYesInputObservationSchema.safeParse(value).success).toBe(false);
  });
}
for (const field of ["x", "y", "hwnd", "pid", "title", "path", "error"]) {
  it(`rejects private Yes target field ${field}`, () => {
    const value = bothInputEvidence();
    Object.assign(value.binding.yesInputGuard, { [field]: "private" });
    expect(WindowsReplacementDiagnosticSchema.safeParse(value).success).toBe(false);
  });
}
it("a complete Yes guard cannot substitute for the existing No guard or binding", () => {
  const no = bothInputEvidence();
  no.binding.noInputGuard.guardMask = 0;
  expect(WindowsReplacementYesInputObservationSchema.safeParse(no).success).toBe(false);
  const binding = bothInputEvidence();
  binding.binding.recheckMatches = false;
  expect(WindowsReplacementYesInputObservationSchema.safeParse(binding).success).toBe(false);
});
it("adding the Yes observer does not make Yes a prerequisite for the independent No action proof", () => {
  expect(WindowsReplacementCancellationSchema.safeParse(cancellationEvidence()).success).toBe(true);
});

const publicationEvidence = () => ({
  action: "confirm_replace",
  observation: bothInputEvidence(),
  replacement: {
    status: "complete",
    guardMask: 255,
    freshYesInputGuard: { status: "complete", guardMask: 255 },
    censusMatches: true,
    pointUnchanged: true,
    cursorMatches: true,
    cursorMoved: true,
    fixtureVerified: true,
    attempted: true,
    sent: true,
    modalDismissed: true,
    saveDismissed: true,
    foregroundOwned: true,
  },
});
it("requires fresh fixture/Yes dispatch/destruction evidence independently of the read-only snapshot", () => {
  expect(WindowsReplacementPublicationSchema.parse(publicationEvidence())).toEqual(
    publicationEvidence(),
  );
  expect(WindowsReplacementPublicationSchema.safeParse(bothInputEvidence()).success).toBe(false);
  expect(WindowsReplacementPublicationSchema.safeParse(cancellationEvidence()).success).toBe(false);
});
for (const field of [
  "censusMatches",
  "pointUnchanged",
  "cursorMatches",
  "cursorMoved",
  "fixtureVerified",
  "attempted",
  "sent",
  "modalDismissed",
  "saveDismissed",
  "foregroundOwned",
] as const) {
  it(`refuses replacement when ${field} is false or missing`, () => {
    const value = publicationEvidence();
    value.replacement[field] = false;
    expect(WindowsReplacementPublicationSchema.safeParse(value).success).toBe(false);
    const missing = structuredClone(value) as { replacement: Record<string, unknown> };
    delete missing.replacement[field];
    expect(WindowsReplacementPublicationDiagnosticSchema.safeParse(missing).success).toBe(false);
  });
}
for (const bit of [1, 2, 4, 8, 16, 32, 64, 128]) {
  it(`refuses missing Yes action or fresh pointer guard bit ${bit}`, () => {
    const action = publicationEvidence();
    action.replacement.guardMask &= ~bit;
    expect(WindowsReplacementPublicationSchema.safeParse(action).success).toBe(false);
    const guard = publicationEvidence();
    guard.replacement.freshYesInputGuard.guardMask &= ~bit;
    expect(WindowsReplacementPublicationSchema.safeParse(guard).success).toBe(false);
  });
}
for (const status of ["not_checked", "refused", "deadline", "read_error"]) {
  it(`refuses a fresh Yes action guard with status ${status}`, () => {
    const value = publicationEvidence();
    value.replacement.freshYesInputGuard.status = status;
    expect(WindowsReplacementPublicationSchema.safeParse(value).success).toBe(false);
  });
}
it("requires the full prior No/Yes snapshot and second inventory for publication", () => {
  const no = publicationEvidence();
  no.observation.binding.noInputGuard.guardMask = 0;
  const yes = publicationEvidence();
  yes.observation.binding.yesInputGuard.guardMask = 0;
  const binding = publicationEvidence();
  binding.observation.binding.recheckMatches = false;
  for (const value of [no, yes, binding])
    expect(WindowsReplacementPublicationSchema.safeParse(value).success).toBe(false);
});
for (const field of ["x", "y", "hwnd", "pid", "title", "path", "error"]) {
  it(`rejects private Yes action field ${field}`, () => {
    const value = publicationEvidence();
    Object.assign(value.replacement, { [field]: "private" });
    expect(WindowsReplacementPublicationDiagnosticSchema.safeParse(value).success).toBe(false);
  });
}

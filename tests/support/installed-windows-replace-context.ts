import { z } from "zod";

const count = z.number().int().min(0).max(256);
const buttonFailure = z.strictObject({
  controlId: z.number().int().min(-1).max(65535),
  parentStatus: z.enum([
    "not_checked",
    "deadline",
    "unavailable",
    "foreign",
    "cycle",
    "root_changed",
    "read_error",
    "complete",
    "bound",
  ]),
  parentDepth: z.number().int().min(0).max(16),
  parentClassMask: z.number().int().min(0).max(63),
});
export const WindowsReplacementBindingSchema = z.strictObject({
  status: z.enum(["complete", "refused", "deadline", "bound", "read_error"]),
  guardMask: z.number().int().min(0).max(255),
  yesRefusalMask: z.number().int().min(0).max(255).optional(),
  noRefusalMask: z.number().int().min(0).max(255).optional(),
  yesBinding: z.enum(["none", "classic_direct", "modern_chain"]).optional(),
  noBinding: z.enum(["none", "classic_direct", "modern_chain"]).optional(),
  recheckStatus: z
    .enum(["not_checked", "complete", "refused", "deadline", "bound", "read_error"])
    .optional(),
  recheckButtons: count.optional(),
  recheckYes: count.optional(),
  recheckNo: count.optional(),
  recheckMatches: z.boolean().optional(),
  noInputGuard: z
    .strictObject({
      status: z.enum(["not_checked", "complete", "refused", "deadline", "read_error"]),
      guardMask: z.number().int().min(0).max(255),
    })
    .optional(),
  yesInputGuard: z
    .strictObject({
      status: z.enum(["not_checked", "complete", "refused", "deadline", "read_error"]),
      guardMask: z.number().int().min(0).max(255),
    })
    .optional(),
  yesFailure: buttonFailure.optional(),
  noFailure: buttonFailure.optional(),
  candidates: z.number().int().min(0).max(17),
  buttons: count,
  yes: count,
  no: count,
});
export const WindowsReplacementDiagnosticSchema = z.strictObject({
  action: z.literal("observe_replace"),
  filenameSet: z.literal(true),
  nativeClick: z.literal(true),
  defaultNameValid: z.literal(true),
  targetFixtureVerified: z.literal(true),
  binding: WindowsReplacementBindingSchema.optional(),
  context: z.strictObject({
    status: z.enum(["complete", "deadline", "bound", "read_error"]),
    capturedExists: z.boolean(),
    capturedVisible: z.boolean(),
    capturedEnabled: z.boolean(),
    foregroundOwned: z.boolean(),
    foregroundSave: z.boolean(),
    windows: z.number().int().min(0).max(17),
    otherDialogs: z.number().int().min(0).max(17),
    ownedBySave: z.number().int().min(0).max(17),
    buttons: count,
    yes: count,
    no: count,
    cancel: count,
    replace: count,
    other: count,
  }),
});

export const WindowsReplacementObservationSchema = WindowsReplacementDiagnosticSchema.refine(
  ({ context }) =>
    context.status === "complete" &&
    context.capturedExists &&
    context.foregroundOwned &&
    context.windows >= 1 &&
    context.windows <= 16 &&
    context.otherDialogs < context.windows &&
    context.ownedBySave <= context.otherDialogs &&
    context.yes + context.no + context.cancel + context.replace + context.other === context.buttons,
);

// A read-only snapshot, never an authorization to use a cached native handle for input.
const noButtonFailure = (value: z.infer<typeof buttonFailure> | undefined) =>
  value === undefined ||
  (value.controlId === -1 &&
    value.parentStatus === "not_checked" &&
    value.parentDepth === 0 &&
    value.parentClassMask === 0);
export const WindowsReplacementBoundObservationSchema = WindowsReplacementObservationSchema.refine(
  ({ context, binding }) =>
    context.capturedVisible &&
    !context.capturedEnabled &&
    !context.foregroundSave &&
    context.otherDialogs === 1 &&
    context.ownedBySave === 1 &&
    context.buttons === 2 &&
    context.yes === 1 &&
    context.no === 1 &&
    context.cancel === 0 &&
    context.replace === 0 &&
    context.other === 0 &&
    binding?.status === "complete" &&
    binding.guardMask === 255 &&
    binding.recheckStatus === "complete" &&
    binding.recheckButtons === 2 &&
    binding.recheckYes === 1 &&
    binding.recheckNo === 1 &&
    binding.recheckMatches === true &&
    binding.yesRefusalMask === 0 &&
    binding.noRefusalMask === 0 &&
    (binding.yesBinding === "classic_direct" || binding.yesBinding === "modern_chain") &&
    (binding.noBinding === "classic_direct" || binding.noBinding === "modern_chain") &&
    noButtonFailure(binding.yesFailure) &&
    noButtonFailure(binding.noFailure) &&
    binding.candidates === 1 &&
    binding.buttons === 2 &&
    binding.yes === 1 &&
    binding.no === 1,
);

export const WindowsReplacementNoInputObservationSchema =
  WindowsReplacementBoundObservationSchema.refine(
    ({ binding }) =>
      binding?.noInputGuard?.status === "complete" && binding.noInputGuard.guardMask === 255,
  );

// Both snapshots are read-only; future confirmation input must rebuild its own proof.
export const WindowsReplacementYesInputObservationSchema =
  WindowsReplacementNoInputObservationSchema.refine(
    ({ binding }) =>
      binding?.yesInputGuard?.status === "complete" && binding.yesInputGuard.guardMask === 255,
  );

export const WindowsReplacementCancellationDiagnosticSchema = z.strictObject({
  action: z.literal("cancel_replace"),
  observation: WindowsReplacementDiagnosticSchema,
  cancellation: z.strictObject({
    status: z.enum(["not_checked", "complete", "refused", "deadline"]),
    guardMask: z.number().int().min(0).max(255),
    freshNoInputGuard: z.strictObject({
      status: z.enum(["not_checked", "complete", "refused", "deadline", "read_error"]),
      guardMask: z.number().int().min(0).max(255),
    }),
    censusMatches: z.boolean(),
    pointUnchanged: z.boolean(),
    cursorMatches: z.boolean(),
    cursorMoved: z.boolean(),
    attempted: z.boolean(),
    sent: z.boolean(),
    modalDismissed: z.boolean(),
    saveRetained: z.boolean(),
  }),
});
export const WindowsReplacementCancellationSchema =
  WindowsReplacementCancellationDiagnosticSchema.refine(
    ({ observation, cancellation }) =>
      WindowsReplacementNoInputObservationSchema.safeParse(observation).success &&
      cancellation.status === "complete" &&
      cancellation.guardMask === 255 &&
      cancellation.freshNoInputGuard.status === "complete" &&
      cancellation.freshNoInputGuard.guardMask === 255 &&
      cancellation.censusMatches &&
      cancellation.pointUnchanged &&
      cancellation.cursorMatches &&
      cancellation.cursorMoved &&
      cancellation.attempted &&
      cancellation.sent &&
      cancellation.modalDismissed &&
      cancellation.saveRetained,
  );

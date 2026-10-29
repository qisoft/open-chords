import { z } from "zod";

const count = z.number().int().min(0).max(256);
export const WindowsReplacementBindingSchema = z.strictObject({
  status: z.enum(["complete", "refused", "deadline", "bound", "read_error"]),
  guardMask: z.number().int().min(0).max(255),
  yesRefusalMask: z.number().int().min(0).max(255).optional(),
  noRefusalMask: z.number().int().min(0).max(255).optional(),
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
    binding.yesRefusalMask === 0 &&
    binding.noRefusalMask === 0 &&
    binding.candidates === 1 &&
    binding.buttons === 2 &&
    binding.yes === 1 &&
    binding.no === 1,
);

import { z } from "zod";

const count = z.number().int().min(0).max(256);
export const WindowsReplacementDiagnosticSchema = z.strictObject({
  action: z.literal("observe_replace"),
  filenameSet: z.literal(true),
  nativeClick: z.literal(true),
  defaultNameValid: z.literal(true),
  targetFixtureVerified: z.literal(true),
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

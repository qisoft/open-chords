import { z } from "zod";

const MutationCaseSchema = z
  .strictObject({
    expectedErrorType: z.enum(["DomainInvariantError", "Error", "ZodError"]),
    name: z.string(),
    operation: z.literal("reverse").optional(),
    path: z.array(z.union([z.string(), z.number().int().nonnegative()])),
    value: z.unknown().optional(),
  })
  .refine((mutation) => mutation.operation !== undefined || "value" in mutation, {
    message: "Mutation case must define a value or operation",
  });

export type MutationCase = z.infer<typeof MutationCaseSchema>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readAt(target: unknown, segment: number | string): unknown {
  if (Array.isArray(target) && typeof segment === "number") return target[segment];
  if (isRecord(target) && typeof segment === "string") return target[segment];
  throw new Error("Mutation path does not match the fixture");
}

function writeAt(target: unknown, segment: number | string, value: unknown): void {
  if (Array.isArray(target) && typeof segment === "number") target[segment] = value;
  else if (isRecord(target) && typeof segment === "string") target[segment] = value;
  else throw new Error("Mutation path does not match the fixture");
}

export function parseMutationCases(input: unknown): MutationCase[] {
  return z.array(MutationCaseSchema).parse(input);
}

export function mutateFixture(base: unknown, mutation: MutationCase): unknown {
  const copy = structuredClone(base);
  let target: unknown = copy;
  for (const segment of mutation.path.slice(0, -1)) target = readAt(target, segment);
  const key = mutation.path.at(-1);
  if (key === undefined) throw new Error("Mutation path cannot be empty");
  if (mutation.operation === "reverse") {
    const current = readAt(target, key);
    if (!Array.isArray(current)) throw new Error("Reverse mutation target is not an array");
    writeAt(target, key, [...current].reverse());
  } else {
    writeAt(target, key, mutation.value);
  }
  return copy;
}

import { canonicalSerialize, StableIdSchema } from "@open-chords/domain";
import { z } from "zod";

import { contentHash } from "./annotations.ts";
import { median } from "./metrics.ts";
import { HashSchema } from "./rights.ts";

export const SubjectSchema = z.strictObject({ recipeHash: HashSchema, buildHash: HashSchema });
export const PlatformProfileSchema = z.strictObject({
  id: StableIdSchema,
  os: z.enum(["macos", "windows", "linux"]),
  arch: z.enum(["arm64", "x64"]),
  resourceProfile: z.enum(["eco", "balanced", "fast"]),
});
const count = z.number().int().nonnegative();
const ResourcesSchema = z.strictObject({
  wallMs: count,
  cpuMs: count,
  peakRssBytes: count,
  workspaceBytes: count,
  retainedBytes: count,
  maxProcesses: count,
  maxThreads: count,
});
export const ResourceMeasureSchema = z.enum([...ResourcesSchema.keyof().options, "realTimeFactor"]);
export type ResourceMeasure = z.infer<typeof ResourceMeasureSchema>;
const ConditionsSchema = z.strictObject({
  osBuild: z.string().min(1),
  cpuModel: z.string().min(1),
  physicalCores: z.number().int().positive(),
  logicalCores: z.number().int().positive(),
  ramBytes: z.number().int().positive(),
  filesystem: z.string().min(1),
  powerMode: z.string().min(1),
  thermalPrecondition: z.string().min(1),
  locale: z.string().min(1),
  timezone: z.string().min(1),
  threadLimit: z.number().int().positive(),
  processLimit: z.number().int().positive(),
  networkDisabled: z.literal(true),
});
const ExecutionOutcomeSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("completed"),
    outputHash: HashSchema,
    revisionId: StableIdSchema,
  }),
  z.strictObject({ kind: z.literal("failed"), failureClass: StableIdSchema }),
]);
export const ExecutionRecordSchema = z.strictObject({
  trackId: StableIdSchema,
  cache: z.enum(["cold", "warm"]),
  sequence: z.number().int().nonnegative(),
  conditions: ConditionsSchema,
  outcome: ExecutionOutcomeSchema,
  resources: ResourcesSchema,
});
export const BenchmarkRunSchema = z.strictObject({
  version: z.literal("1.0"),
  role: z.enum(["candidate", "baseline"]),
  subject: SubjectSchema,
  corpusHash: HashSchema,
  profiles: z
    .array(
      z.strictObject({
        profileId: StableIdSchema,
        outputs: z.array(z.strictObject({ trackId: StableIdSchema, result: z.unknown() })),
        executions: z.array(ExecutionRecordSchema),
      }),
    )
    .min(1),
});
export type BenchmarkRun = z.infer<typeof BenchmarkRunSchema>;
export type ProfileRun = BenchmarkRun["profiles"][number];
export type Check = { status: "pass" | "fail" | "insufficient_evidence"; reasons: string[] };

export const checkOf = (fail: string[], insufficient: string[]): Check => ({
  status: fail.length > 0 ? "fail" : insufficient.length > 0 ? "insufficient_evidence" : "pass",
  reasons: [...fail, ...insufficient].sort(),
});

function expectedOutcome(result: unknown) {
  const parsed = z
    .discriminatedUnion("kind", [
      z.looseObject({ kind: z.literal("completed"), revisionId: StableIdSchema }),
      z.looseObject({ kind: z.literal("failed"), failureClass: StableIdSchema }),
    ])
    .safeParse(result);
  if (!parsed.success) return null;
  return parsed.data.kind === "completed"
    ? { kind: "completed", outputHash: contentHash(result), revisionId: parsed.data.revisionId }
    : { kind: "failed", failureClass: parsed.data.failureClass };
}

export function checkDeterminism(run: ProfileRun, trackIds: string[]): Check {
  const fail: string[] = [],
    insufficient: string[] = [];
  if (run.executions.some((record) => !trackIds.includes(record.trackId)))
    fail.push("execution_outside_cohort");
  if (new Set(run.executions.map((r) => canonicalSerialize(r.conditions))).size > 1)
    fail.push("run_conditions_differ");
  for (const trackId of trackIds) {
    const records = run.executions.filter((record) => record.trackId === trackId);
    const keys = records.map((record) => `${record.cache}:${record.sequence}`);
    if (new Set(keys).size !== keys.length) fail.push(`${trackId}:duplicate_execution`);
    if (
      records.filter((r) => r.cache === "cold").length < 2 ||
      records.filter((r) => r.cache === "warm").length < 1
    )
      insufficient.push(`${trackId}:missing_repeats`);
    const output = run.outputs.find((item) => item.trackId === trackId);
    const expected = output === undefined ? null : expectedOutcome(output.result);
    if (
      records.some(
        (record) =>
          expected === null || canonicalSerialize(record.outcome) !== canonicalSerialize(expected),
      )
    )
      fail.push(`${trackId}:nondeterministic_output`);
  }
  return checkOf(fail, insufficient);
}

export function resourceObservations(
  run: ProfileRun,
  secondsByTrack: Map<string, number>,
  measure: ResourceMeasure,
  cache: "cold" | "warm",
) {
  return run.executions
    .filter((record) => record.cache === cache && secondsByTrack.has(record.trackId))
    .map((record) =>
      measure === "realTimeFactor"
        ? record.resources.wallMs / 1000 / secondsByTrack.get(record.trackId)!
        : record.resources[measure],
    );
}

export function resourceSummary(values: number[]) {
  return values.length === 0
    ? null
    : {
        n: values.length,
        min: Math.min(...values),
        median: median(values),
        max: Math.max(...values),
      };
}

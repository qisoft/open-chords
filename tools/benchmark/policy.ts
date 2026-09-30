import { StableIdSchema } from "@open-chords/domain";
import { z } from "zod";

import { CapabilitySchema, contentHash } from "./annotations.ts";
import { ConfidenceSpecSchema, METRICS, MetricIdSchema } from "./metrics.ts";
import { HashSchema } from "./rights.ts";
import { PlatformProfileSchema, ResourceMeasureSchema, SubjectSchema } from "./runs.ts";
import { UncertaintySchema } from "./statistics.ts";

export const ProcedureSchema = z.strictObject({
  version: z.literal("1.0"),
  corpusHash: HashSchema,
  candidate: SubjectSchema,
  baseline: SubjectSchema,
  platformProfiles: z.array(PlatformProfileSchema).min(1),
  uncertainty: UncertaintySchema,
  confidence: z.array(ConfidenceSpecSchema),
});
export type Procedure = z.infer<typeof ProcedureSchema>;
const ThresholdSchema = z.strictObject({
  value: z.number(),
  unit: z.string().min(1),
  rationale: z.string().min(1),
});
export const SliceSchema = z.union([z.literal("all"), StableIdSchema]);
const statement = z.string().min(1);
const ClaimSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("capability"),
    id: StableIdSchema,
    statement,
    capability: CapabilitySchema,
    slices: z.array(SliceSchema).min(1),
    required: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal("platform_profile"),
    id: StableIdSchema,
    statement,
    profileId: StableIdSchema,
    required: z.boolean(),
  }),
]);
const QualityGateSchema = z.strictObject({
  id: StableIdSchema,
  claimId: StableIdSchema,
  slice: SliceSchema,
  quality: z.strictObject({
    metric: MetricIdSchema,
    better: z.enum(["higher", "lower"]),
    aggregation: z.literal("track_mean"),
    bound: ThresholdSchema,
  }),
  coverage: z.strictObject({
    metric: MetricIdSchema,
    aggregation: z.literal("track_mean"),
    minimum: ThresholdSchema,
  }),
  nonInferiorityMargin: ThresholdSchema.nullable(),
});
const ResourceCapSchema = z.strictObject({
  id: StableIdSchema,
  claimId: StableIdSchema,
  measure: ResourceMeasureSchema,
  cache: z.enum(["cold", "warm"]),
  maximum: ThresholdSchema,
});
export const PolicySchema = z.strictObject({
  version: z.literal("1.0"),
  purpose: z.enum(["workflow_fixture", "release"]),
  procedure: ProcedureSchema,
  calibrationReportHash: HashSchema,
  supportClaims: z.array(ClaimSchema).min(1),
  qualityGates: z.array(QualityGateSchema),
  resourceCaps: z.array(ResourceCapSchema),
});
export type Policy = z.infer<typeof PolicySchema>;
export type QualityGate = Policy["qualityGates"][number];

const CalibrationReportBindingSchema = z.looseObject({
  version: z.literal("1.0"),
  cohort: z.literal("calibration"),
  syntheticEvidence: z.boolean(),
  procedureHash: HashSchema,
  hash: HashSchema,
  profiles: z.array(
    z.looseObject({
      profileId: StableIdSchema,
      metrics: z.array(
        z.looseObject({
          metric: MetricIdSchema,
          slice: SliceSchema,
          candidate: z.looseObject({ n: z.number().int().nonnegative() }),
        }),
      ),
      resources: z.array(
        z.looseObject({
          measure: ResourceMeasureSchema,
          cache: z.enum(["cold", "warm"]),
          summary: z.looseObject({ n: z.number().int().positive() }).nullable(),
        }),
      ),
    }),
  ),
});

function unique(values: string[], kind: string) {
  if (new Set(values).size !== values.length) throw new Error(`Duplicate ${kind}`);
}

export function parseCalibrationReport(input: unknown) {
  const report = CalibrationReportBindingSchema.parse(input);
  const { hash, ...payload } = report;
  if (contentHash(payload) !== hash) throw new Error("Calibration report hash mismatch");
  return report;
}

export function parsePolicy(input: unknown, rawReport: unknown): Policy {
  const policy = PolicySchema.parse(input),
    procedure = policy.procedure;
  const report = parseCalibrationReport(rawReport);
  unique(
    procedure.platformProfiles.map((p) => p.id),
    "platform profile",
  );
  unique(
    procedure.confidence.map((c) => c.capability),
    "confidence declaration",
  );
  unique(
    [...policy.supportClaims, ...policy.qualityGates, ...policy.resourceCaps].map((i) => i.id),
    "policy identity",
  );
  if (
    report.hash !== policy.calibrationReportHash ||
    report.procedureHash !== contentHash(procedure)
  )
    throw new Error("Policy is not bound to its calibration report");
  if (policy.purpose === "release" && report.syntheticEvidence)
    throw new Error("Synthetic calibration evidence cannot support a release policy");
  const observed = (profileId: string, metric: string, slice: string) =>
    report.profiles
      .find((p) => p.profileId === profileId)
      ?.metrics.some((m) => m.metric === metric && m.slice === slice && m.candidate.n > 0) === true;
  for (const gate of policy.qualityGates) {
    const claim = policy.supportClaims.find((c) => c.id === gate.claimId);
    const quality = METRICS[gate.quality.metric],
      coverage = METRICS[gate.coverage.metric];
    if (
      claim?.kind !== "capability" ||
      !claim.slices.includes(gate.slice) ||
      quality.capability !== claim.capability ||
      coverage.capability !== claim.capability ||
      (quality.kind !== "quality" && quality.kind !== "calibration") ||
      coverage.kind !== "coverage" ||
      quality.better !== gate.quality.better
    )
      throw new Error("Quality gate must pair a claim metric with its coverage metric");
    if (
      quality.kind === "calibration" &&
      !procedure.confidence.some((c) => c.capability === claim.capability)
    )
      throw new Error("Calibration gate without declared confidence evidence");
    if (
      gate.nonInferiorityMargin !== null &&
      (gate.nonInferiorityMargin.value < 0 || quality.conditional)
    )
      throw new Error("Non-inferiority needs a non-negative margin on an unconditional metric");
    for (const profile of procedure.platformProfiles)
      if (
        !observed(profile.id, gate.quality.metric, gate.slice) ||
        !observed(profile.id, gate.coverage.metric, gate.slice)
      )
        throw new Error("Threshold lacks calibration-cohort evidence");
  }
  for (const claim of policy.supportClaims) {
    if (claim.kind === "capability") {
      if (
        claim.slices.some(
          (slice) => !policy.qualityGates.some((g) => g.claimId === claim.id && g.slice === slice),
        )
      )
        throw new Error("Support Claim slice without a gate");
    } else if (!procedure.platformProfiles.some((p) => p.id === claim.profileId))
      throw new Error("Platform claim names an undeclared profile");
  }
  unique(
    policy.supportClaims.flatMap((c) => (c.kind === "platform_profile" ? [c.profileId] : [])),
    "platform claim",
  );
  if (
    procedure.platformProfiles.some(
      (p) =>
        !policy.supportClaims.some((c) => c.kind === "platform_profile" && c.profileId === p.id),
    )
  )
    throw new Error("Every platform profile needs a Support Claim");
  for (const cap of policy.resourceCaps) {
    const claim = policy.supportClaims.find((c) => c.id === cap.claimId);
    if (claim?.kind !== "platform_profile") throw new Error("Resource cap needs a platform claim");
    const resources = report.profiles.find((p) => p.profileId === claim.profileId)?.resources;
    if (
      !resources?.some(
        (r) => r.measure === cap.measure && r.cache === cap.cache && r.summary !== null,
      )
    )
      throw new Error("Threshold lacks calibration-cohort evidence");
  }
  return policy;
}

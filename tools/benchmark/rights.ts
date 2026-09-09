import { StableIdSchema } from "@open-chords/domain";
import { z } from "zod";

export const HashSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const TimeSchema = z.iso.datetime({ offset: true });
export const AssetSchema = z.enum(["recording", "composition", "lyrics", "annotation", "results"]);
export const OperationSchema = z.enum([
  "local_storage",
  "automated_analysis",
  "human_annotation",
  "derivative_data",
  "private_ci_transfer",
  "public_audio",
  "public_annotations",
  "per_track_metrics",
  "aggregate_metrics",
]);
export const ExecutionLocationSchema = z.enum([
  "hosted_runner",
  "private_runner",
  "local_reference",
]);
const permission = z.enum(["allowed", "denied", "unknown"]);
export const RightsGrantSchema = z.strictObject({
  asset: AssetSchema,
  subjectId: StableIdSchema,
  disposition: z.enum(["reviewed", "ambiguous", "revoked"]),
  basis: z.enum([
    "project_owned",
    "commissioned",
    "written_grant",
    "public_domain",
    "content_license",
  ]),
  evidenceHashes: z.array(HashSchema),
  source: z.string().min(1),
  licensor: z.string().min(1),
  license: z.string().min(1),
  acquiredAt: TimeSchema,
  attribution: z.array(z.string().min(1)),
  notices: z.array(z.string().min(1)),
  reviewerId: StableIdSchema,
  reviewedAt: TimeSchema,
  expiresAt: TimeSchema.nullable(),
  termination: z.string().min(1),
  deletionRequired: z.boolean(),
  territories: z.array(z.string().regex(/^(?:[A-Z]{2}|worldwide)$/)).min(1),
  executionLocations: z.array(ExecutionLocationSchema).min(1),
  permissions: z.strictObject({
    local_storage: permission,
    automated_analysis: permission,
    human_annotation: permission,
    derivative_data: permission,
    private_ci_transfer: permission,
    public_audio: permission,
    public_annotations: permission,
    per_track_metrics: permission,
    aggregate_metrics: permission,
  }),
});
export const RightsRequestSchema = z.strictObject({
  at: TimeSchema,
  territory: z.string().regex(/^[A-Z]{2}$/),
  executionLocation: ExecutionLocationSchema,
  uses: z
    .array(
      z.strictObject({
        asset: AssetSchema,
        subjectId: StableIdSchema,
        operations: z.array(OperationSchema).min(1),
      }),
    )
    .min(1),
});

export function evaluateRights(
  rawGrants: unknown,
  rawRequest: unknown,
): { eligible: boolean; reasons: string[] } {
  const request = RightsRequestSchema.parse(rawRequest);
  const parsed = z.array(RightsGrantSchema).safeParse(rawGrants);
  if (!parsed.success) return { eligible: false, reasons: ["invalid_rights_ledger"] };
  const reasons = new Set<string>();
  const now = Date.parse(request.at);
  for (const use of request.uses) {
    const key = `${use.asset}:${use.subjectId}`;
    const matches = parsed.data.filter(
      (grant) => grant.asset === use.asset && grant.subjectId === use.subjectId,
    );
    if (matches.length !== 1) {
      reasons.add(`${key}:${matches.length === 0 ? "missing" : "duplicate"}`);
      continue;
    }
    const grant = matches[0]!;
    if (grant.disposition !== "reviewed") reasons.add(`${key}:${grant.disposition}`);
    if (grant.evidenceHashes.length === 0) reasons.add(`${key}:missing_evidence`);
    if (
      Date.parse(grant.reviewedAt) > now ||
      Date.parse(grant.acquiredAt) > Date.parse(grant.reviewedAt)
    )
      reasons.add(`${key}:invalid_review_date`);
    if (grant.expiresAt !== null && Date.parse(grant.expiresAt) <= now)
      reasons.add(`${key}:expired`);
    if (grant.deletionRequired) reasons.add(`${key}:deletion_required`);
    if (!grant.territories.includes("worldwide") && !grant.territories.includes(request.territory))
      reasons.add(`${key}:territory`);
    if (!grant.executionLocations.includes(request.executionLocation))
      reasons.add(`${key}:execution_location`);
    for (const operation of use.operations)
      if (grant.permissions[operation] !== "allowed")
        reasons.add(`${key}:${operation}:${grant.permissions[operation]}`);
  }
  return { eligible: reasons.size === 0, reasons: [...reasons].sort() };
}

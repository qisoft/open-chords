import { expect, it } from "vitest";

import { evaluateRights } from "../tools/benchmark/index.ts";

const grant = () => ({
  asset: "recording",
  subjectId: "recording_fixture",
  disposition: "reviewed",
  basis: "project_owned",
  evidenceHashes: [`sha256:${"1".repeat(64)}`],
  source: "synthetic fixture",
  licensor: "fixture owner",
  license: "fixture-only",
  acquiredAt: "2026-01-01T00:00:00Z",
  attribution: ["Synthetic workflow fixture"],
  notices: [],
  reviewerId: "reviewer_fixture",
  reviewedAt: "2026-01-02T00:00:00Z",
  expiresAt: null,
  termination: "none",
  deletionRequired: false,
  territories: ["NL"],
  executionLocations: ["local_reference"],
  permissions: {
    local_storage: "allowed",
    automated_analysis: "allowed",
    human_annotation: "allowed",
    derivative_data: "allowed",
    private_ci_transfer: "denied",
    public_audio: "denied",
    public_annotations: "denied",
    per_track_metrics: "denied",
    aggregate_metrics: "allowed",
  },
});
const request = () => ({
  at: "2026-09-09T00:00:00Z",
  territory: "NL",
  executionLocation: "local_reference",
  uses: [
    {
      asset: "recording",
      subjectId: "recording_fixture",
      operations: ["local_storage", "automated_analysis"],
    },
  ],
});

it("allows the reviewed private operation without inventing redistribution permission", () => {
  expect(evaluateRights([grant()], request())).toEqual({ eligible: true, reasons: [] });
  const publishing = request();
  publishing.uses[0]!.operations = ["public_audio"];
  expect(evaluateRights([grant()], publishing)).toEqual({
    eligible: false,
    reasons: ["recording:recording_fixture:public_audio:denied"],
  });
});
it("fails closed for missing, ambiguous, expired or wrong-location evidence across separate rights layers", () => {
  const uses = request();
  uses.uses.push({
    asset: "composition",
    subjectId: "composition_fixture",
    operations: ["automated_analysis"],
  });
  expect(evaluateRights([grant()], uses)).toEqual({
    eligible: false,
    reasons: ["composition:composition_fixture:missing"],
  });
  expect(evaluateRights([{ ...grant(), disposition: "ambiguous" }], request()).eligible).toBe(
    false,
  );
  expect(evaluateRights([{ ...grant(), evidenceHashes: [] }], request()).eligible).toBe(false);
  expect(
    evaluateRights([{ ...grant(), expiresAt: "2026-09-08T00:00:00Z" }], request()).eligible,
  ).toBe(false);
  expect(
    evaluateRights([grant()], { ...request(), executionLocation: "hosted_runner" }).eligible,
  ).toBe(false);
});

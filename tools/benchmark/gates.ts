import { canonicalSerialize } from "@open-chords/domain";

import { contentHash, parseGoldReference, type AnnotationContent } from "./annotations.ts";
import type { CorpusManifest } from "./corpus.ts";
import {
  calibrationCells,
  METRIC_IDS,
  readOutput,
  scoreTrack,
  type MetricId,
  type Outcome,
  type TrackScores,
} from "./metrics.ts";
import type { Policy, Procedure, QualityGate } from "./policy.ts";
import {
  BenchmarkRunSchema,
  checkDeterminism,
  checkOf,
  ResourceMeasureSchema,
  resourceObservations,
  resourceSummary,
  type Check,
  type ProfileRun,
} from "./runs.ts";
import { reliability, summarize, trackInterval, type Uncertainty } from "./statistics.ts";

export type CorpusTrack = CorpusManifest["tracks"][number];
export type EvaluationInput = {
  procedure: Procedure;
  purpose: "workflow_fixture" | "release_corpus";
  cohort: "calibration" | "sealed";
  tracks: CorpusTrack[];
  gold: unknown[];
  candidate: unknown;
  baseline: unknown;
};
type ScoredTrack = {
  trackId: string;
  slices: string[];
  outcome: Outcome | "missing";
  scores: TrackScores;
  cells: Map<string, ReturnType<typeof calibrationCells>>;
};
type Role = "candidate" | "baseline";

function bindGold(tracks: CorpusTrack[], rawGold: unknown[]) {
  const gold = rawGold.map(parseGoldReference);
  const expected = tracks.flatMap((track) => track.goldHashes);
  if (new Set(gold.map((g) => g.hash)).size !== gold.length)
    throw new Error("Duplicate Gold Reference");
  if (
    new Set(expected).size !== expected.length ||
    expected.length !== gold.length ||
    gold.some((reference) => !expected.includes(reference.hash))
  )
    throw new Error("Gold Reference inventory mismatch");
  return {
    synthetic: gold.some((reference) => reference.annotations[0].source === "synthetic_fixture"),
    content: new Map(
      tracks.map((track) => [
        track.id,
        track.goldHashes.map((hash): AnnotationContent => {
          const reference = gold.find((g) => g.hash === hash)!;
          const raw = reference.annotations[0];
          if (
            raw.trackId !== track.id ||
            raw.audioHash !== track.audioHash ||
            raw.durationSamples !== track.durationSamples ||
            raw.sampleRate !== track.sampleRate
          )
            throw new Error("Gold Reference track scope mismatch");
          return reference.adjudication.result;
        }),
      ]),
    ),
  };
}

function scoreRun(input: EvaluationInput, role: Role, gold: Map<string, AnnotationContent[]>) {
  const run = BenchmarkRunSchema.parse(input[role]);
  const problems: string[] = [],
    invalid: string[] = [];
  const declared = input.procedure.platformProfiles.map((p) => p.id);
  if (
    run.role !== role ||
    canonicalSerialize(run.subject) !== canonicalSerialize(input.procedure[role]) ||
    run.corpusHash !== input.procedure.corpusHash
  )
    problems.push(`${role}:identity`);
  const ids = run.profiles.map((p) => p.profileId);
  if (
    new Set(ids).size !== ids.length ||
    ids.length !== declared.length ||
    ids.some((id) => !declared.includes(id))
  )
    problems.push(`${role}:profile_inventory`);
  const profiles = new Map<string, { run: ProfileRun; tracks: ScoredTrack[] }>();
  for (const profile of run.profiles) {
    const outputIds = profile.outputs.map((o) => o.trackId);
    if (
      new Set(outputIds).size !== outputIds.length ||
      outputIds.length !== input.tracks.length ||
      input.tracks.some((track) => !outputIds.includes(track.id))
    )
      problems.push(`${role}:${profile.profileId}:output_inventory`);
    const tracks = input.tracks.map((track): ScoredTrack => {
      const content = gold.get(track.id)!;
      const output = profile.outputs.find((o) => o.trackId === track.id);
      const read = readOutput(
        output?.result,
        track.durationSamples,
        content,
        input.procedure.confidence,
      );
      if (output !== undefined && read.outcome === "invalid")
        invalid.push(`${role}:${profile.profileId}:${track.id}:invalid_output`);
      return {
        trackId: track.id,
        slices: ["all", ...track.slices.labels],
        outcome: output === undefined ? "missing" : read.outcome,
        scores: scoreTrack(content, read.view, track.sampleRate),
        cells: new Map(
          content.map((reference) => [
            reference.capability,
            calibrationCells(reference, read.view),
          ]),
        ),
      };
    });
    profiles.set(profile.profileId, { run: profile, tracks });
  }
  return { problems, invalid, profiles };
}

const scoredValues = (tracks: ScoredTrack[], metric: MetricId, slice: string) =>
  tracks.flatMap((track) => {
    const value = track.scores.get(metric)!;
    return track.slices.includes(slice) && value.state === "scored"
      ? [{ trackId: track.trackId, value: value.value, pooled: value.pooled }]
      : [];
  });

function metricSummary(tracks: ScoredTrack[], metric: MetricId, slice: string, u: Uncertainty) {
  const inSlice = tracks.filter((track) => track.slices.includes(slice));
  const scored = scoredValues(tracks, metric, slice);
  return {
    n: scored.length,
    notApplicable: inSlice.filter((t) => t.scores.get(metric)!.state === "not_applicable").length,
    uncovered: inSlice.filter((t) => t.scores.get(metric)!.state === "uncovered").length,
    summary: summarize(
      scored.map((s) => s.value),
      scored.flatMap((s) => (s.pooled ? [s.pooled] : [])),
      u,
    ),
  };
}

function pairedDifferences(
  candidate: ScoredTrack[],
  baseline: ScoredTrack[] | undefined,
  metric: MetricId,
  slice: string,
) {
  if (baseline === undefined) return null;
  const reference = new Map(scoredValues(baseline, metric, slice).map((s) => [s.trackId, s.value]));
  return scoredValues(candidate, metric, slice).flatMap((s) =>
    reference.has(s.trackId) ? [s.value - reference.get(s.trackId)!] : [],
  );
}

function characterizeScored(input: EvaluationInput) {
  const bound = bindGold(input.tracks, input.gold);
  if (input.tracks.some((track) => track.cohort !== input.cohort))
    throw new Error("Track outside the evaluated cohort");
  const candidate = scoreRun(input, "candidate", bound.content),
    baseline = scoreRun(input, "baseline", bound.content);
  const u = input.procedure.uncertainty;
  const slices = [...new Set(input.tracks.flatMap((t) => ["all", ...t.slices.labels]))].sort();
  const seconds = new Map(input.tracks.map((t) => [t.id, t.durationSamples / t.sampleRate]));
  const profiles = input.procedure.platformProfiles.flatMap((profile) => {
    const scored = candidate.profiles.get(profile.id);
    if (scored === undefined) return [];
    const base = baseline.profiles.get(profile.id)?.tracks;
    const outcomes = (tracks: ScoredTrack[] | undefined) =>
      tracks === undefined
        ? null
        : Object.fromEntries(
            (["completed", "failed", "invalid", "missing"] as const).map((kind) => [
              kind,
              tracks.filter((t) => t.outcome === kind).length,
            ]),
          );
    return [
      {
        profileId: profile.id,
        outcomes: { candidate: outcomes(scored.tracks), baseline: outcomes(base) },
        determinism: checkDeterminism(
          scored.run,
          input.tracks.map((t) => t.id),
        ),
        metrics: METRIC_IDS.flatMap((metric) =>
          slices.map((slice) => {
            const differences = pairedDifferences(scored.tracks, base, metric, slice);
            return {
              metric,
              slice,
              candidate: metricSummary(scored.tracks, metric, slice, u),
              baseline: base === undefined ? null : metricSummary(base, metric, slice, u),
              pairedDifference:
                differences === null
                  ? null
                  : { n: differences.length, summary: summarize(differences, [], u) },
            };
          }),
        ),
        calibration: input.procedure.confidence.map((spec) => {
          const cells = scored.tracks.flatMap((t) => {
            const found = t.cells.get(spec.capability);
            return found ? [found] : [];
          });
          return {
            capability: spec.capability,
            ...reliability(
              cells.flatMap((c) => c.cells),
              spec.bins,
              cells.reduce((sum, c) => sum + c.eligibleSamples, 0),
            ),
          };
        }),
        resources: ResourceMeasureSchema.options.flatMap((measure) =>
          (["cold", "warm"] as const).map((cache) => ({
            measure,
            cache,
            summary: resourceSummary(resourceObservations(scored.run, seconds, measure, cache)),
          })),
        ),
      },
    ];
  });
  const payload = {
    version: "1.0" as const,
    cohort: input.cohort,
    syntheticEvidence: bound.synthetic || input.purpose !== "release_corpus",
    procedureHash: contentHash(input.procedure),
    hardGates: [
      {
        id: "run_identity_and_inventory",
        ...checkOf([...candidate.problems, ...baseline.problems], []),
      },
      { id: "output_validity", ...checkOf([...candidate.invalid, ...baseline.invalid], []) },
    ],
    profiles,
  };
  return { report: { ...payload, hash: contentHash(payload) }, candidate, baseline, seconds };
}

export function characterize(input: EvaluationInput) {
  const { report } = characterizeScored(input);
  if (input.cohort === "calibration" && report.hardGates[0]?.status !== "pass")
    throw new Error("Calibration runs must match the procedure and cover every track");
  return report;
}

function boundCheck(values: number[], u: Uncertainty, better: "higher" | "lower", bound: number) {
  if (values.length < u.minTracks)
    return { n: values.length, estimate: null, status: "insufficient_evidence" as const };
  const interval = trackInterval(values, u);
  const estimate = better === "higher" ? interval.lower : interval.upper;
  const pass = better === "higher" ? estimate >= bound : estimate <= bound;
  return { n: values.length, estimate, status: pass ? ("pass" as const) : ("fail" as const) };
}
const combine = (statuses: Check["status"][]): Check["status"] =>
  statuses.includes("fail")
    ? "fail"
    : statuses.includes("insufficient_evidence")
      ? "insufficient_evidence"
      : "pass";

function evaluateQualityGate(
  gate: QualityGate,
  tracks: ScoredTrack[] | undefined,
  baseline: ScoredTrack[] | undefined,
  u: Uncertainty,
) {
  if (tracks === undefined)
    return {
      status: "insufficient_evidence" as const,
      quality: null,
      coverage: null,
      nonInferiority: null,
    };
  const values = (metric: MetricId) => scoredValues(tracks, metric, gate.slice).map((s) => s.value);
  const quality = boundCheck(
    values(gate.quality.metric),
    u,
    gate.quality.better,
    gate.quality.bound.value,
  );
  const coverage = boundCheck(
    values(gate.coverage.metric),
    u,
    "higher",
    gate.coverage.minimum.value,
  );
  let nonInferiority = null;
  if (gate.nonInferiorityMargin !== null) {
    const differences = pairedDifferences(tracks, baseline, gate.quality.metric, gate.slice) ?? [];
    const oriented = differences.map((d) => (gate.quality.better === "higher" ? d : -d));
    nonInferiority = boundCheck(oriented, u, "higher", -gate.nonInferiorityMargin.value);
  }
  return {
    status: combine([
      quality.status,
      coverage.status,
      ...(nonInferiority ? [nonInferiority.status] : []),
    ]),
    quality,
    coverage,
    nonInferiority,
  };
}

export function evaluateGates(policy: Policy, input: EvaluationInput) {
  if (canonicalSerialize(input.procedure) !== canonicalSerialize(policy.procedure))
    throw new Error("Evaluation procedure differs from the frozen policy");
  if (input.cohort !== "sealed") throw new Error("Release gates evaluate only the sealed cohort");
  const scored = characterizeScored(input);
  const u = policy.procedure.uncertainty;
  const profiles = policy.procedure.platformProfiles.map((p) => p.id);
  const gates = policy.qualityGates.flatMap((gate) =>
    profiles.map((profileId) => ({
      gateId: gate.id,
      claimId: gate.claimId,
      profileId,
      ...evaluateQualityGate(
        gate,
        scored.candidate.profiles.get(profileId)?.tracks,
        scored.baseline.profiles.get(profileId)?.tracks,
        u,
      ),
    })),
  );
  const profileOf = new Map(
    policy.supportClaims.flatMap((c) =>
      c.kind === "platform_profile" ? [[c.id, c.profileId]] : [],
    ),
  );
  const resources = policy.resourceCaps.map((cap) => {
    const profileId = profileOf.get(cap.claimId)!;
    const run = scored.candidate.profiles.get(profileId)?.run;
    const observed = run ? resourceObservations(run, scored.seconds, cap.measure, cap.cache) : [];
    const max = observed.length === 0 ? null : Math.max(...observed);
    return {
      capId: cap.id,
      claimId: cap.claimId,
      profileId,
      observedMax: max,
      status:
        max === null
          ? ("insufficient_evidence" as const)
          : max <= cap.maximum.value
            ? ("pass" as const)
            : ("fail" as const),
    };
  });
  const determinism = profiles.map((profileId) => {
    const profile = scored.report.profiles.find((p) => p.profileId === profileId);
    return {
      profileId,
      ...(profile?.determinism ?? {
        status: "insufficient_evidence" as const,
        reasons: ["no_native_run"],
      }),
    };
  });
  const outcome = (status: Check["status"]) =>
    status === "pass" ? "supported" : status === "fail" ? "failed" : "narrowed";
  const platformClaims = policy.supportClaims.flatMap((claim) =>
    claim.kind !== "platform_profile"
      ? []
      : [
          {
            claimId: claim.id,
            profileId: claim.profileId,
            required: claim.required,
            status: outcome(
              combine([
                determinism.find((d) => d.profileId === claim.profileId)!.status,
                ...resources.filter((r) => r.claimId === claim.id).map((r) => r.status),
              ]),
            ),
          },
        ],
  );
  const capabilityClaims = policy.supportClaims.flatMap((claim) =>
    claim.kind !== "capability"
      ? []
      : profiles.map((profileId) => ({
          claimId: claim.id,
          profileId,
          required: claim.required,
          status: outcome(
            combine(
              gates
                .filter((g) => g.claimId === claim.id && g.profileId === profileId)
                .map((g) => g.status),
            ),
          ),
        })),
  );
  const claims = [...platformClaims, ...capabilityClaims];
  const liveProfiles = platformClaims
    .filter((c) => c.status === "supported" || c.required)
    .map((c) => c.profileId);
  const failed =
    scored.report.hardGates.some((g) => g.status === "fail") ||
    claims.some((claim) => claim.status === "failed");
  const blocked =
    platformClaims.every((c) => c.status !== "supported") ||
    platformClaims.some((c) => c.required && c.status !== "supported") ||
    capabilityClaims.some(
      (c) => c.required && c.status !== "supported" && liveProfiles.includes(c.profileId),
    );
  const verdict = failed ? "fail" : blocked ? "insufficient_evidence" : "pass";
  const payload = {
    version: "1.0" as const,
    purpose: policy.purpose,
    syntheticEvidence: scored.report.syntheticEvidence,
    releaseAuthority:
      verdict === "pass" && policy.purpose === "release" && !scored.report.syntheticEvidence,
    policyHash: contentHash(policy),
    calibrationReportHash: policy.calibrationReportHash,
    verdict,
    hardGates: scored.report.hardGates,
    gates,
    determinism,
    resources,
    claims,
    sealedReport: scored.report,
  };
  return { ...payload, hash: contentHash(payload) };
}

import { expect, it } from "vitest";

import {
  characterize,
  evaluateGates,
  parseCorpusManifest,
  parsePolicy,
  ProcedureSchema,
} from "../tools/benchmark/index.ts";
import {
  capabilityClaim,
  chord,
  completed,
  executions,
  gateCorpus,
  goldChords,
  perfect,
  policyFor,
  procedure,
  profileId,
  run,
  threshold,
  type Output,
} from "./support/benchmark-gate-fixture.ts";

const fixture = gateCorpus(4);
fixture.manifest.tracks[0]!.slices.labels.push("slice_rare");
fixture.manifest.tracks[4]!.slices.labels.push("slice_rare");
const manifest = parseCorpusManifest(fixture.manifest);
const corpusHash = fixture.corpusHash;
type Cohort = "calibration" | "sealed";
const tracksOf = (cohort: Cohort) => manifest.tracks.filter((t) => t.cohort === cohort);
const outputs = (cohort: Cohort, output: (trackId: string) => Output = perfect) =>
  new Map(tracksOf(cohort).map((track) => [track.id, output(track.id)]));
const input = (
  cohort: Cohort,
  candidate: unknown = run("candidate", corpusHash, outputs(cohort)),
  baseline: unknown = run("baseline", corpusHash, outputs(cohort)),
) => ({
  procedure: ProcedureSchema.parse(procedure(corpusHash)),
  purpose: manifest.purpose,
  cohort,
  tracks: tracksOf(cohort),
  gold: fixture.gold.filter((g) => tracksOf(cohort).some((t) => t.goldHashes.includes(g.hash))),
  candidate,
  baseline,
});
const report = characterize(input("calibration"));
const basePolicy = () => policyFor(report, corpusHash);
const verdictFor = (candidate: unknown, policy = basePolicy()) =>
  evaluateGates(parsePolicy(policy, report), input("sealed", candidate));
const candidate = (output: (trackId: string) => Output) =>
  run("candidate", corpusHash, outputs("sealed", output));
const halfAbstained = (trackId: string) =>
  trackId === "track_4"
    ? completed([
        { ...goldChords[0]!, confidence: 0.9 },
        { ...goldChords[1]!, state: "abstained" },
      ])
    : perfect();

it("characterizes the calibration cohort without inventing thresholds and marks synthetic evidence", () => {
  const profile = report.profiles[0]!;
  expect(report).toMatchObject({ cohort: "calibration", syntheticEvidence: true });
  expect(
    profile.metrics.find((m) => m.metric === "chords.exact" && m.slice === "all"),
  ).toMatchObject({
    candidate: { n: 4, summary: { mean: 1, pooled: 1, lower: 1, upper: 1 } },
    pairedDifference: { n: 4, summary: { mean: 0 } },
  });
  expect(profile.calibration).toEqual([
    {
      capability: "chords",
      bins: [
        { lower: 0, upper: 0.5, samples: 0, meanConfidence: null, accuracy: null },
        { lower: 0.5, upper: 1, samples: 192000, meanConfidence: 0.9, accuracy: 1 },
      ],
      riskCoverage: [
        { threshold: 0, coverage: 1, risk: 0 },
        { threshold: 0.5, coverage: 1, risk: 0 },
        { threshold: 1, coverage: 0, risk: null },
      ],
    },
  ]);
  expect(
    profile.resources.find((r) => r.measure === "realTimeFactor" && r.cache === "cold"),
  ).toEqual({
    measure: "realTimeFactor",
    cache: "cold",
    summary: { n: 8, min: 0.5, median: 0.5, max: 0.5 },
  });
  const partial = outputs("calibration");
  partial.delete("track_0");
  expect(() => characterize(input("calibration", run("candidate", corpusHash, partial)))).toThrow(
    /cover every track/,
  );
  expect(() => characterize({ ...input("sealed"), cohort: "calibration" })).toThrow(/cohort/);
});

it("binds every frozen number to paired coverage and calibration-cohort evidence", () => {
  expect(parsePolicy(basePolicy(), report).qualityGates).toHaveLength(1);
  const release = { ...basePolicy(), purpose: "release" };
  expect(() => parsePolicy(release, report)).toThrow(/Synthetic calibration evidence/);
  const unpaired = basePolicy();
  unpaired.qualityGates[0]!.coverage.metric = "chords.exact";
  expect(() => parsePolicy(unpaired, report)).toThrow(/coverage metric/);
  const { coverage: _coverage, ...withoutCoverage } = basePolicy().qualityGates[0]!;
  expect(() => parsePolicy({ ...basePolicy(), qualityGates: [withoutCoverage] }, report)).toThrow(
    /expected object/,
  );
  const ungated = basePolicy();
  ungated.supportClaims[0] = capabilityClaim("claim_chords", ["all", "slice_synthetic"]);
  expect(() => parsePolicy(ungated, report)).toThrow(/without a gate/);
  const unobserved = basePolicy();
  unobserved.supportClaims[0] = capabilityClaim("claim_chords", ["all", "slice_missing"]);
  unobserved.qualityGates.push({
    ...unobserved.qualityGates[0]!,
    id: "gate_missing",
    slice: "slice_missing",
  });
  expect(() => parsePolicy(unobserved, report)).toThrow(/calibration-cohort evidence/);
  expect(() => parsePolicy(basePolicy(), { ...report, syntheticEvidence: false })).toThrow(/hash/);
  const selectiveMargin = basePolicy();
  selectiveMargin.qualityGates[0]!.quality = {
    metric: "chords.selective_error",
    better: "lower",
    aggregation: "track_mean",
    bound: threshold(0.05),
  };
  expect(() => parsePolicy(selectiveMargin, report)).toThrow(/unconditional metric/);
});

it("passes synthetic evidence through every gate without granting release authority", () => {
  const verdict = verdictFor(candidate(perfect));
  expect(verdict).toMatchObject({
    verdict: "pass",
    releaseAuthority: false,
    syntheticEvidence: true,
    hardGates: [
      { id: "run_identity_and_inventory", status: "pass", reasons: [] },
      { id: "output_validity", status: "pass", reasons: [] },
    ],
    gates: [
      {
        gateId: "gate_chords",
        profileId,
        status: "pass",
        quality: { n: 4, estimate: 1, status: "pass" },
        coverage: { n: 4, estimate: 1, status: "pass" },
        nonInferiority: { n: 4, estimate: 0, status: "pass" },
      },
    ],
    resources: [{ capId: "cap_rtf", observedMax: 0.5, status: "pass" }],
  });
  expect(verdict.claims.map((c) => c.status)).toEqual(["supported", "supported"]);
});

it("keeps abstained, failed and deleted tracks in the sealed denominators", () => {
  const abstained = verdictFor(candidate(halfAbstained));
  expect(abstained.verdict).toBe("fail");
  expect(abstained.gates[0]).toMatchObject({
    status: "fail",
    quality: { n: 4, status: "fail" },
    coverage: { n: 4, status: "fail" },
  });
  const failed = verdictFor(
    candidate((id) =>
      id === "track_4" ? { kind: "failed", failureClass: "decode_failed" } : perfect(),
    ),
  );
  expect(failed.gates[0]).toMatchObject({ status: "fail", quality: { n: 4 }, coverage: { n: 4 } });

  const deleted = outputs("sealed");
  deleted.delete("track_4");
  const withoutTrack = verdictFor(run("candidate", corpusHash, deleted));
  expect(withoutTrack.verdict).toBe("fail");
  expect(withoutTrack.hardGates[0]).toEqual({
    id: "run_identity_and_inventory",
    status: "fail",
    reasons: ["candidate:profile_fixture:output_inventory"],
  });
  const exact = withoutTrack.sealedReport.profiles[0]!.metrics.find(
    (m) => m.metric === "chords.exact" && m.slice === "all",
  );
  expect(exact?.candidate).toMatchObject({ n: 4, summary: { mean: 0.75 } });
});

it("pairs quality with coverage so neither can compensate for the other", () => {
  const selective = basePolicy();
  selective.qualityGates[0]!.quality = {
    metric: "chords.selective_error",
    better: "lower",
    aggregation: "track_mean",
    bound: threshold(0.05),
  };
  selective.qualityGates[0]!.nonInferiorityMargin = null;
  const suppressed = verdictFor(
    candidate((id) =>
      id === "track_4"
        ? completed(goldChords.map((p) => ({ ...p, state: "abstained" as const })))
        : perfect(),
    ),
    selective,
  );
  expect(suppressed.gates[0]).toMatchObject({
    status: "fail",
    quality: { n: 3, estimate: 0, status: "pass" },
    coverage: { n: 4, status: "fail" },
  });
  expect(suppressed.verdict).toBe("fail");
  const wrong = completed(
    goldChords.map((p) => ({ ...p, value: chord("D", "major"), confidence: 0.9 })),
  );
  const covered = verdictFor(candidate(() => wrong));
  expect(covered.gates[0]).toMatchObject({
    status: "fail",
    quality: { estimate: 0, status: "fail" },
    coverage: { estimate: 1, status: "pass" },
  });
});

it("fails a paired non-inferiority margin even when the absolute bound passes", () => {
  const lenient = basePolicy();
  lenient.qualityGates[0]!.quality.bound = threshold(0.5);
  const worse = completed([
    { startSample: 0, endSample: 12000, value: chord("D", "major"), confidence: 0.9 },
    { startSample: 12000, endSample: 24000, value: chord("C", "major"), confidence: 0.9 },
    { ...goldChords[1]!, confidence: 0.9 },
  ]);
  const verdict = verdictFor(
    candidate(() => worse),
    lenient,
  );
  expect(verdict.gates[0]).toMatchObject({
    status: "fail",
    quality: { estimate: 0.75, status: "pass" },
    nonInferiority: { estimate: -0.25, status: "fail" },
  });
});

it("narrows an optional Support Claim with insufficient evidence and blocks release when it is required", () => {
  const rare = (required: boolean) => {
    const policy = basePolicy();
    policy.supportClaims.push(capabilityClaim("claim_rare", ["slice_rare"], required));
    policy.qualityGates.push({
      ...policy.qualityGates[0]!,
      id: "gate_rare",
      claimId: "claim_rare",
      slice: "slice_rare",
    });
    return verdictFor(candidate(perfect), policy);
  };
  const optional = rare(false);
  expect(optional.gates[1]).toMatchObject({
    gateId: "gate_rare",
    status: "insufficient_evidence",
    quality: { n: 1, estimate: null },
  });
  expect(optional.claims.find((c) => c.claimId === "claim_rare")?.status).toBe("narrowed");
  expect(optional.verdict).toBe("pass");
  expect(rare(true).verdict).toBe("insufficient_evidence");
});

it("requires deterministic cold and warm repeats and enforces resource caps per platform profile", () => {
  const sealed = run("candidate", corpusHash, outputs("sealed"));
  const profile = sealed.profiles[0]!;
  const missingWarm = structuredClone(sealed);
  missingWarm.profiles[0]!.executions = profile.executions.filter(
    (r) => !(r.trackId === "track_4" && r.cache === "warm"),
  );
  const narrowed = verdictFor(missingWarm);
  expect(narrowed.determinism).toEqual([
    { profileId, status: "insufficient_evidence", reasons: ["track_4:missing_repeats"] },
  ]);
  expect(narrowed.verdict).toBe("insufficient_evidence");

  const drifted = structuredClone(sealed);
  drifted.profiles[0]!.executions[0]!.outcome = executions(
    "track_4",
    halfAbstained("track_4"),
  )[0]!.outcome;
  const nondeterministic = verdictFor(drifted);
  expect(nondeterministic.determinism[0]).toMatchObject({
    status: "fail",
    reasons: ["track_4:nondeterministic_output"],
  });
  expect(nondeterministic.verdict).toBe("fail");

  const slow = structuredClone(sealed);
  slow.profiles[0]!.executions[1]!.resources.wallMs = 60000;
  const capped = verdictFor(slow);
  expect(capped.resources[0]).toMatchObject({ observedMax: 60, status: "fail" });
  expect(capped.verdict).toBe("fail");
});

it("fails a run that omits a declared platform profile instead of dropping that profile", () => {
  const second = { id: "profile_second", os: "windows", arch: "x64", resourceProfile: "balanced" };
  const base = procedure(corpusHash);
  const twoProfiles = { ...base, platformProfiles: [...base.platformProfiles, second] };
  const withSecond = (
    subject: ReturnType<typeof run>,
    cohort: Cohort,
    output: (id: string) => Output = perfect,
  ) => {
    const extra = run(subject.role, corpusHash, outputs(cohort, output)).profiles[0]!;
    return { ...subject, profiles: [...subject.profiles, { ...extra, profileId: second.id }] };
  };
  const twoInput = (cohort: Cohort, candidateRun: unknown, baselineRun: unknown) => ({
    ...input(cohort, candidateRun, baselineRun),
    procedure: ProcedureSchema.parse(twoProfiles),
  });
  const calibration = characterize(
    twoInput(
      "calibration",
      withSecond(run("candidate", corpusHash, outputs("calibration")), "calibration"),
      withSecond(run("baseline", corpusHash, outputs("calibration")), "calibration"),
    ),
  );
  const policy = { ...policyFor(calibration, corpusHash), procedure: twoProfiles };
  policy.supportClaims.push({
    kind: "platform_profile",
    id: "claim_second",
    statement: "SYNTHETIC optional platform profile claim",
    profileId: second.id,
    required: false,
  });
  const parsed = parsePolicy(policy, calibration);
  const baseline = withSecond(run("baseline", corpusHash, outputs("sealed")), "sealed");
  const failingSecond = withSecond(candidate(perfect), "sealed", halfAbstained);
  expect(evaluateGates(parsed, twoInput("sealed", failingSecond, baseline)).verdict).toBe("fail");
  const dropped = evaluateGates(parsed, twoInput("sealed", candidate(perfect), baseline));
  expect(dropped.verdict).toBe("fail");
  expect(dropped.hardGates[0]).toEqual({
    id: "run_identity_and_inventory",
    status: "fail",
    reasons: ["candidate:profile_inventory"],
  });
});

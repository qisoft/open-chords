import { contentHash } from "../../tools/benchmark/index.ts";
import { corpusFixture, goldFor } from "./benchmark-fixture.ts";

const hash = (digit: string) => `sha256:${digit.repeat(64)}`;
export const chord = (root: string, quality: string, bass?: string) => ({
  kind: "chord",
  root,
  quality,
  additions: [],
  alterations: [],
  extensions: [],
  omissions: [],
  ...(bass === undefined ? {} : { bass }),
});
export const goldChords = [
  { startSample: 0, endSample: 24000, value: chord("C", "major") },
  { startSample: 24000, endSample: 48000, value: chord("A", "minor") },
];
type State = "asserted" | "low_confidence" | "abstained";
export type Piece = {
  startSample: number;
  endSample: number;
  value: unknown;
  state?: State;
  confidence?: number;
};
export const assertion = (state: State, confidence?: number) =>
  state === "abstained"
    ? { state, evidence: [], reasonCodes: ["synthetic_abstention"] }
    : {
        state,
        evidence:
          confidence === undefined
            ? []
            : [{ name: "chord_posterior", scale: "calibrated_probability", value: confidence }],
        reasonCodes: [],
      };
const whole = { startSample: 0, endSample: 48000 };
export function completed(
  chords: Piece[],
  timeline: Record<string, unknown> = {},
  lyrics: unknown = null,
) {
  return {
    kind: "completed" as const,
    revisionId: "revision_fixture",
    lyrics,
    timeline: {
      chordEvents: chords.map((piece, index) => ({
        id: `chord_${index}`,
        startSample: piece.startSample,
        endSample: piece.endSample,
        value: piece.value,
        assertion: assertion(piece.state ?? "asserted", piece.confidence),
      })),
      keyRegions: [
        { ...whole, id: "key_one", value: { kind: "unknown" }, assertion: assertion("abstained") },
      ],
      sectionRegions: [
        { ...whole, id: "section_one", label: "unknown", assertion: assertion("abstained") },
      ],
      bars: [],
      unmeteredRegions: [{ ...whole, id: "unmetered_one", reasonCode: "synthetic" }],
      ...timeline,
    },
  };
}
export const perfect = () => completed(goldChords.map((piece) => ({ ...piece, confidence: 0.9 })));

export const subjects = {
  candidate: { recipeHash: hash("a"), buildHash: hash("b") },
  baseline: { recipeHash: hash("c"), buildHash: hash("d") },
};
export const profileId = "profile_fixture";
export function procedure(corpusHash: string) {
  return {
    version: "1.0",
    corpusHash,
    ...subjects,
    platformProfiles: [{ id: profileId, os: "macos", arch: "arm64", resourceProfile: "balanced" }],
    uncertainty: {
      method: "paired_percentile_bootstrap",
      confidence: 0.9,
      resamples: 200,
      seed: 7,
      minTracks: 3,
    },
    confidence: [
      {
        capability: "chords",
        evidence: { name: "chord_posterior", scale: "calibrated_probability" },
        bins: [0, 0.5, 1],
      },
    ],
  };
}
const conditions = {
  osBuild: "synthetic",
  cpuModel: "synthetic",
  physicalCores: 8,
  logicalCores: 8,
  ramBytes: 17179869184,
  filesystem: "apfs",
  powerMode: "ac_high_performance",
  thermalPrecondition: "idle_10_minutes",
  locale: "en-US",
  timezone: "UTC",
  threadLimit: 4,
  processLimit: 4,
  networkDisabled: true,
};
export const resources = {
  wallMs: 500,
  cpuMs: 400,
  peakRssBytes: 100000000,
  workspaceBytes: 1000000,
  retainedBytes: 10000,
  maxProcesses: 2,
  maxThreads: 4,
};
export type Output =
  | ReturnType<typeof completed>
  | { kind: "failed"; failureClass: string }
  | { kind: "invalid" };
export function executions(trackId: string, result: Output) {
  const outcome =
    result.kind === "completed"
      ? { kind: "completed", outputHash: contentHash(result), revisionId: result.revisionId }
      : result.kind === "failed"
        ? { kind: "failed", failureClass: result.failureClass }
        : { kind: "failed", failureClass: "invalid_fixture" };
  return (
    [
      ["cold", 0],
      ["cold", 1],
      ["warm", 0],
    ] as const
  ).map(([cache, sequence]) => ({
    trackId,
    cache,
    sequence,
    conditions,
    outcome,
    resources,
  }));
}
export function run(
  role: "candidate" | "baseline",
  corpusHash: string,
  outputs: Map<string, Output>,
) {
  return {
    version: "1.0",
    role,
    subject: subjects[role],
    corpusHash,
    profiles: [
      {
        profileId,
        outputs: [...outputs].map(([trackId, result]) => ({ trackId, result })),
        executions: [...outputs].flatMap(([trackId, result]) => executions(trackId, result)),
      },
    ],
  };
}

export function gateCorpus(perCohort = 4) {
  const gold = Array.from({ length: perCohort * 2 }, (_, index) =>
    goldFor(`track_${index}`, `sha256:${index.toString(16).padStart(64, "0")}`, {
      capability: "chords",
      events: goldChords.map((piece, event) => ({ ...piece, id: `chord_${event}` })),
    }),
  );
  const { manifest } = corpusFixture(gold, perCohort);
  return { manifest, gold, corpusHash: contentHash(manifest) };
}
export const threshold = (value: number, unit = "ratio") => ({
  value,
  unit,
  rationale: "SYNTHETIC FIXTURE VALUE, not a release threshold",
});
export const capabilityClaim = (id: string, slices: string[], required = true) => ({
  kind: "capability",
  id,
  statement: "SYNTHETIC chord claim",
  capability: "chords",
  slices,
  required,
});
export function policyFor(report: { hash: string }, corpusHash: string) {
  return {
    version: "1.0",
    purpose: "workflow_fixture",
    procedure: procedure(corpusHash),
    calibrationReportHash: report.hash,
    supportClaims: [
      capabilityClaim("claim_chords", ["all"]),
      {
        kind: "platform_profile",
        id: "claim_profile",
        statement: "SYNTHETIC platform profile claim",
        profileId,
        required: true,
      },
    ],
    qualityGates: [
      {
        id: "gate_chords",
        claimId: "claim_chords",
        slice: "all",
        quality: {
          metric: "chords.exact",
          better: "higher",
          aggregation: "track_mean",
          bound: threshold(0.9),
        },
        coverage: {
          metric: "chords.coverage",
          aggregation: "track_mean",
          minimum: threshold(0.9),
        },
        nonInferiorityMargin: threshold(0.05) as ReturnType<typeof threshold> | null,
      },
    ],
    resourceCaps: [
      {
        id: "cap_rtf",
        claimId: "claim_profile",
        measure: "realTimeFactor",
        cache: "cold",
        maximum: threshold(1, "wall_seconds_per_audio_second"),
      },
    ],
  };
}

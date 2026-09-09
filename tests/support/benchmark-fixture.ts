import { buildGoldReference, contentHash } from "../../tools/benchmark/index.ts";
export const fixtureHash = `sha256:${"1".repeat(64)}`;
export const rawAnnotation = (person: string, end = 48000) => ({
  version: "1.0",
  id: `annotation_${person}`,
  trackId: "track_fixture",
  audioHash: fixtureHash,
  guideHash: fixtureHash,
  sampleRate: 48000,
  durationSamples: 48000,
  createdAt: "2026-09-09T00:00:00Z",
  source: "synthetic_fixture",
  blindToSystemOutputs: true,
  blindToOtherAnnotations: true,
  annotator: {
    id: `person_${person}`,
    qualification: {
      capability: "chords",
      evidenceHash: fixtureHash,
      reviewerId: "person_qualifier",
    },
  },
  tool: { name: "synthetic fixture", version: "1.0" },
  ambiguity: [],
  content: {
    capability: "chords",
    events: [{ id: "chord_one", startSample: 0, endSample: end, value: { kind: "no_chord" } }],
  },
});

export const fixtureContext = {
  at: "2026-09-09T02:00:00Z",
  territory: "NL",
  executionLocation: "local_reference",
};

export function fixtureGold(trackId = "track_fixture", audioHash = fixtureHash) {
  const first = { ...rawAnnotation("first"), id: `${trackId}_first`, trackId, audioHash };
  const second = { ...rawAnnotation("second"), id: `${trackId}_second`, trackId, audioHash };
  return buildGoldReference({
    annotations: [first, second],
    adjudication: {
      source: "synthetic_fixture",
      id: `${trackId}_gold`,
      createdAt: "2026-09-09T01:00:00Z",
      guideHash: fixtureHash,
      adjudicator: {
        id: "person_third",
        qualification: {
          capability: "chords",
          evidenceHash: fixtureHash,
          reviewerId: "person_qualifier",
        },
      },
      rawHashes: [contentHash(first), contentHash(second)],
      result: first.content,
      decisions: [],
    },
  });
}
export function corpusFixture() {
  const gold = [
    fixtureGold("track_calibration"),
    fixtureGold("track_sealed", `sha256:${"2".repeat(64)}`),
  ];
  const tracks = gold.map((g, index) => {
    const raw = g.annotations[0];
    const recordingGroupId = `recording_${index}`,
      compositionGroupId = `composition_${index}`;
    const subjects = [
      { asset: "recording", subjectId: recordingGroupId },
      { asset: "composition", subjectId: compositionGroupId },
      ...[...g.annotations.map((a) => a.id), g.adjudication.id].map((subjectId) => ({
        asset: "annotation",
        subjectId,
      })),
    ];
    return {
      id: raw.trackId,
      audioHash: raw.audioHash,
      sourceHashes: [raw.audioHash],
      sampleRate: 48000,
      durationSamples: 48000,
      recordingGroupId,
      compositionGroupId,
      artistGroupId: `artist_${index}`,
      cohort: index === 0 ? "calibration" : "sealed",
      lyricsSubjectId: null,
      goldHashes: [g.hash],
      slices: {
        labels: ["slice_synthetic"],
        version: "1.0",
        reviewerId: "fixture_reviewer",
        evidenceHash: fixtureHash,
      },
      rights: subjects.map((subject) => ({
        ...subject,
        disposition: "reviewed",
        basis: "project_owned",
        evidenceHashes: [fixtureHash],
        source: "SYNTHETIC WORKFLOW FIXTURE",
        licensor: "fixture",
        license: "fixture only",
        acquiredAt: "2026-01-01T00:00:00Z",
        attribution: ["Synthetic"],
        notices: [],
        reviewerId: "fixture_reviewer",
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
      })),
    };
  });
  return {
    manifest: {
      version: "1.0",
      id: "corpus_fixture",
      purpose: "workflow_fixture",
      requirements: [{ capability: "chords", slice: "slice_synthetic" }],
      tracks,
      crossCohortRelationships: [],
    },
    gold,
  };
}

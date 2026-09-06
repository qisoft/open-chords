import type { ProjectOwnedRecords } from "../../apps/desktop/src/main/project-library-records.ts";

export function goldenRecords(): ProjectOwnedRecords {
  const fingerprint = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
  return {
    analysisManifests: [],
    exportReceipts: [],
    extensions: {},
    legacyManifestlessAnalysisRevisionIds: ["revision_original", "revision_reviewable"],
    projectRange: { endSourceSample: 48_000, sourceId: "source_fixture", startSourceSample: 0 },
    sources: [
      {
        id: "source_fixture",
        identity: { fingerprint, kind: "local_file" },
        locators: [
          {
            fingerprint,
            id: "locator_fixture",
            kind: "local_file",
            path: "/unavailable/golden-fixture.wav",
            status: "unavailable",
            verifiedAt: "2026-08-21T08:00:00Z",
          },
        ],
        metadataObservations: [],
        snapshots: [
          {
            byteFingerprint: fingerprint,
            byteSize: 96_044,
            canonicalAudioFingerprint:
              "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
            durationSamples: 48_000,
            id: "snapshot_fixture",
            metadataObservationIds: [],
            observedAt: "2026-08-21T08:00:00Z",
            provenance: {
              components: [
                {
                  hash: "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
                  id: "media-probe",
                  version: "1.0.0",
                },
              ],
              kind: "local_file",
            },
            selectedFormat: {
              audioCodec: "pcm_s16le",
              container: "wav",
              mimeType: "audio/wav",
            },
          },
        ],
      },
    ],
  };
}

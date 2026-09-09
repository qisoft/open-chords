import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  captureJsonExport,
  parseJsonExport,
  serializeJsonExport,
} from "../packages/domain/src/json-export.ts";

const fixture = () =>
  JSON.parse(readFileSync("packages/testkit/contracts/v1/valid/project-envelope.json", "utf8"))
    .payload;

describe("Open Chords JSON snapshot", () => {
  it("captures one immutable semantic view as independently specified canonical bytes", () => {
    const project = fixture();
    project.extensions = { "private.test": { path: "/private/secret.wav", token: "secret-key" } };
    const snapshot = captureJsonExport(project, { presentation: "current" });
    project.activeView.presentation.transposeSemitones = 7;
    project.lyricsDocuments[0].text = "A later edit";
    const bytes = serializeJsonExport(snapshot);
    expect(bytes).toBe(readFileSync("tests/fixtures/json-export-golden.json", "utf8"));
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.effectiveTimeline.chordEvents)).toBe(true);
    for (const excluded of ["secret-key", "/private/", "transactions", "practice", "extensions"])
      expect(bytes).not.toContain(excluded === "extensions" ? '"extensions": {' : excluded);
  });
  it("retains user authorship and Original identities while declaring presentation transforms", () => {
    const project = fixture();
    project.editLayers[0].transactions.push({
      id: "edit_user",
      parentTransactionId: null,
      operations: [
        { type: "replace_chord_value", eventId: "chord_g7", value: { kind: "no_chord" } },
      ],
    });
    project.activeView.editHistoryPosition = project.editLayers[0].transactions.length;
    project.activeView.presentation.transposeSemitones = 2;
    const snapshot = captureJsonExport(project, { presentation: "current" });
    expect(snapshot.userAuthorship.entityIds).toEqual(["chord_g7"]);
    expect(snapshot.original.chordEvents.find(({ id }) => id === "chord_g7")!.value).toMatchObject({
      root: "G",
    });
    expect(
      snapshot.effectiveTimeline.chordEvents.find(({ id }) => id === "chord_g7")!.value,
    ).toEqual({ kind: "no_chord" });
    expect(snapshot.presentation.transposeSemitones).toBe(2);
    expect(
      captureJsonExport(project, { presentation: "original" }).presentation.transposeSemitones,
    ).toBe(0);
    expect(serializeJsonExport(snapshot)).not.toContain('"transactions"');
  });
  it("rejects independently corrupted semantic links and presentation output", () => {
    const snapshot = JSON.parse(readFileSync("tests/fixtures/json-export-golden.json", "utf8"));
    snapshot.selection.analysisRevisionId = "revision_other";
    expect(() => parseJsonExport(snapshot)).toThrow(Error);
    snapshot.selection.analysisRevisionId = "revision_original";
    snapshot.presentedChords[0].eventId = "unknown_event";
    expect(() => parseJsonExport(snapshot)).toThrow(Error);
  });
});

it.each([
  (value: any) => {
    delete value.lyrics.originalAlignment;
  },
  (value: any) => {
    value.profile.presentation = "original";
    value.presentation.beginnerView = true;
  },
  (value: any) => {
    value.presentation.capoGuidance = "incorrect";
  },
  (value: any) => {
    value.lyrics.document.tokens[0].text = "changed";
  },
])("rejects incomplete or contradictory portable semantics", (corrupt) => {
  const value = JSON.parse(readFileSync("tests/fixtures/json-export-golden.json", "utf8"));
  corrupt(value);
  expect(() => parseJsonExport(value)).toThrow(Error);
});

it("exports alignment hashes without operational recipes or private runtime identifiers", () => {
  const project = fixture();
  project.lyricsAlignments[0].provenance = {
    recipe: {
      version: "1.0",
      projectId: project.id,
      lyricsDocumentId: project.lyricsAlignments[0].lyricsDocumentId,
      analysisRevisionId: project.lyricsAlignments[0].analysisRevisionId,
      documentHash: `sha256:${"1".repeat(64)}`,
      revisionHash: `sha256:${"2".repeat(64)}`,
      canonicalAudioFingerprint: `sha256:${"3".repeat(64)}`,
      durationSamples: project.durationSamples,
      sampleRate: project.sampleRate,
      normalization: "unicode_nfkc_lower_v1",
      anchors: [],
      packId: "/private/pack",
      runtimeId: "secret-runtime",
      runtimeManifestHash: "4".repeat(64),
      workerProfile: "kalpy_single_primary_v1_beam10_retry40",
      artifacts: [],
    },
    recipeHash: `sha256:${"5".repeat(64)}`,
    resultHash: `sha256:${"6".repeat(64)}`,
    qualityStatus: "benchmark_pending",
  };
  const bytes = serializeJsonExport(captureJsonExport(project, { presentation: "current" }));
  expect(bytes).toContain('"recipeHash"');
  expect(bytes).not.toContain("/private/pack");
  expect(bytes).not.toContain("secret-runtime");
  expect(bytes).not.toContain('"recipe":');
});

it("keeps only hash-addressed support provenance and reports omitted descriptions", () => {
  const project = fixture();
  project.supportClaims[0].inputs = ["/Users/private/secret.wav"];
  project.supportClaims[0].operatingConditions = ["api-secret-value"];
  const snapshot = captureJsonExport(project, { presentation: "current" });
  const bytes = serializeJsonExport(snapshot);
  expect(bytes).not.toContain("/Users/private/");
  expect(bytes).not.toContain("api-secret-value");
  expect(snapshot.omissions).toContain("support_claim_descriptions_omitted");
});

it("rejects authorship outside retained semantic entities and selected lyric scope", () => {
  const snapshot = JSON.parse(readFileSync("tests/fixtures/json-export-golden.json", "utf8"));
  snapshot.userAuthorship.entityIds = ["chord_missing"];
  expect(() => parseJsonExport(snapshot)).toThrow(Error);
  snapshot.userAuthorship.entityIds = [];
  snapshot.userAuthorship.lyricsAnchors = [
    {
      id: "anchor_invalid",
      lyricsDocumentId: "lyrics_missing",
      analysisRevisionId: "revision_missing",
      firstTokenId: "token_missing",
      lastTokenId: "token_missing",
      startSample: 500,
      endSample: 1,
    },
  ];
  expect(() => parseJsonExport(snapshot)).toThrow(Error);
});

it("validates anchor order and sample bounds while retaining valid repeated-token identity", () => {
  const snapshot = JSON.parse(readFileSync("tests/fixtures/json-export-golden.json", "utf8"));
  const anchor = {
    id: "anchor_valid",
    lyricsDocumentId: "lyrics_repeated",
    analysisRevisionId: "revision_original",
    firstTokenId: "token_go_1",
    lastTokenId: "token_go_2",
    startSample: 0,
    endSample: 20000,
  };
  snapshot.userAuthorship.lyricsAnchors = [anchor];
  expect(parseJsonExport(snapshot).userAuthorship.lyricsAnchors).toEqual([anchor]);
  for (const change of [
    { endSample: 50000 },
    { firstTokenId: "token_go_3" },
    { startSample: 20000 },
  ]) {
    snapshot.userAuthorship.lyricsAnchors = [{ ...anchor, ...change }];
    expect(() => parseJsonExport(snapshot)).toThrow("Export anchor scope or interval is invalid");
  }
  snapshot.userAuthorship.lyricsAnchors = [anchor, { ...anchor, id: "anchor_overlap" }];
  expect(() => parseJsonExport(snapshot)).toThrow("Export anchors conflict");
});

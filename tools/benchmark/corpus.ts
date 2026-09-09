import { StableIdSchema } from "@open-chords/domain";
import { z } from "zod";

import {
  CapabilitySchema,
  contentHash,
  parseGoldReference,
  type AnnotationContent,
} from "./annotations.ts";
import { evaluateRights, HashSchema, RightsGrantSchema, RightsRequestSchema } from "./rights.ts";

const cohort = z.enum(["calibration", "sealed"]);
const trackSchema = z.strictObject({
  id: StableIdSchema,
  audioHash: HashSchema,
  sourceHashes: z.array(HashSchema).min(1),
  sampleRate: z.number().int().positive().max(768000),
  durationSamples: z.number().int().positive(),
  recordingGroupId: StableIdSchema,
  compositionGroupId: StableIdSchema,
  artistGroupId: StableIdSchema,
  cohort,
  lyricsSubjectId: StableIdSchema.nullable(),
  rights: z.array(RightsGrantSchema),
  goldHashes: z.array(HashSchema).min(1),
  slices: z.strictObject({
    labels: z.array(StableIdSchema).min(1),
    version: z.string().min(1),
    reviewerId: StableIdSchema,
    evidenceHash: HashSchema,
  }),
});
export const CorpusManifestSchema = z.strictObject({
  version: z.literal("1.0"),
  id: StableIdSchema,
  purpose: z.enum(["workflow_fixture", "release_corpus"]),
  requirements: z
    .array(z.strictObject({ capability: CapabilitySchema, slice: StableIdSchema }))
    .min(1),
  tracks: z.array(trackSchema).min(1),
  crossCohortRelationships: z.array(
    z.strictObject({
      kind: z.enum(["composition", "artist"]),
      groupId: StableIdSchema,
      reason: z.string().min(1),
      reviewerId: StableIdSchema,
    }),
  ),
});
export const AuditContextSchema = RightsRequestSchema.omit({ uses: true });
export type CorpusManifest = z.infer<typeof CorpusManifestSchema>;
function assertUnique(values: string[], kind: string) {
  if (new Set(values).size !== values.length) throw new Error(`Duplicate ${kind}`);
}
export function parseCorpusManifest(input: unknown): CorpusManifest {
  const manifest = CorpusManifestSchema.parse(input);
  assertUnique(
    manifest.tracks.map((t) => t.id),
    "track",
  );
  assertUnique(
    manifest.tracks.map((t) => t.recordingGroupId),
    "recording group",
  );
  assertUnique(
    manifest.requirements.map((r) => `${r.capability}:${r.slice}`),
    "coverage requirement",
  );
  const sources = new Map<string, string>();
  for (const track of manifest.tracks) {
    assertUnique(track.sourceHashes, "source hash");
    assertUnique(track.goldHashes, "Gold Reference");
    assertUnique(track.slices.labels, "slice label");
    assertUnique(
      track.rights.map((r) => `${r.asset}:${r.subjectId}`),
      "rights subject",
    );
    for (const hash of [track.audioHash, ...track.sourceHashes]) {
      if (sources.has(hash) && sources.get(hash) !== track.id)
        throw new Error("Cross-track recording hash");
      sources.set(hash, track.id);
    }
  }
  const crossings = new Set<string>();
  for (const kind of ["composition", "artist"] as const) {
    const groups = new Map<string, Set<string>>();
    for (const track of manifest.tracks) {
      const id = track[`${kind}GroupId`];
      const set = groups.get(id) ?? new Set<string>();
      set.add(track.cohort);
      groups.set(id, set);
    }
    for (const [groupId, cohorts] of groups)
      if (cohorts.size > 1) crossings.add(`${kind}:${groupId}`);
  }
  const disclosed = manifest.crossCohortRelationships.map((r) => `${r.kind}:${r.groupId}`);
  assertUnique(disclosed, "relationship disclosure");
  if (disclosed.length !== crossings.size || disclosed.some((r) => !crossings.has(r)))
    throw new Error("Cross-cohort relationship disclosure mismatch");
  return manifest;
}
function referenceCoverage(content: AnnotationContent, sampleRate: number) {
  const duration = (items: { startSample: number; endSample: number }[]) =>
    items.reduce((sum, item) => sum + (item.endSample - item.startSample) / sampleRate, 0);
  if ("events" in content) {
    const positive = content.events.filter((event) =>
      "value" in event
        ? event.value.kind !== "no_chord" && event.value.kind !== "unknown"
        : event.label !== "unknown",
    );
    const negative = content.events.filter((event) => !positive.includes(event));
    return {
      events: positive.length,
      eventSeconds: duration(positive),
      negativeEvents: negative.length,
      negativeSeconds: duration(negative),
    };
  }
  if ("bars" in content)
    return {
      events:
        content.capability === "rhythm"
          ? content.bars.reduce((sum, bar) => sum + bar.beats.length, 0)
          : content.bars.length,
      eventSeconds: duration(content.bars),
      negativeEvents: content.unmeteredRegions.length,
      negativeSeconds: duration(content.unmeteredRegions),
    };
  const matched = content.tokens.flatMap((token) =>
    token.timing.state === "matched" ? [token.timing] : [],
  );
  return {
    events: matched.length,
    eventSeconds: duration(matched),
    negativeEvents: content.tokens.length - matched.length,
    negativeSeconds: 0,
  };
}
/** Private operator report: never publish without a separate disclosure review. */
export function auditCorpus(input: unknown, references: unknown[], rawContext: unknown) {
  const manifest = parseCorpusManifest(input),
    context = AuditContextSchema.parse(rawContext);
  const gold = references.map(parseGoldReference);
  if (
    manifest.purpose === "release_corpus" &&
    gold.some((g) => g.annotations[0].source === "synthetic_fixture")
  )
    throw new Error("Synthetic annotations cannot populate a release corpus");
  assertUnique(
    gold.map((g) => g.hash),
    "Gold Reference",
  );
  const expected = manifest.tracks.flatMap((t) => t.goldHashes);
  assertUnique(expected, "Gold Reference binding");
  if (expected.length !== gold.length || gold.some((g) => !expected.includes(g.hash)))
    throw new Error("Gold Reference inventory mismatch");
  const evaluated = manifest.tracks.map((track) => {
    const capabilities = new Set<string>();
    const coverage = new Map<string, ReturnType<typeof referenceCoverage>>();
    const failures: string[] = [];
    for (const hash of track.goldHashes) {
      const reference = gold.find((g) => g.hash === hash);
      if (!reference) throw new Error("Missing Gold Reference");
      const raw = reference.annotations[0];
      if (
        raw.trackId !== track.id ||
        raw.audioHash !== track.audioHash ||
        raw.sampleRate !== track.sampleRate ||
        raw.durationSamples !== track.durationSamples
      )
        throw new Error("Gold Reference track scope mismatch");
      const capability = raw.content.capability;
      if (capabilities.has(capability)) throw new Error("Duplicate capability Reference");
      // Use a separate set: a denied reference must still reserve its capability identity.
      capabilities.add(capability);
      coverage.set(capability, referenceCoverage(reference.adjudication.result, track.sampleRate));
      const operations = ["local_storage", "automated_analysis", "derivative_data"];
      if (context.executionLocation !== "local_reference") operations.push("private_ci_transfer");
      const uses = [
        {
          asset: "recording",
          subjectId: track.recordingGroupId,
          operations: [...operations, "human_annotation"],
        },
        {
          asset: "composition",
          subjectId: track.compositionGroupId,
          operations: [...operations, "human_annotation"],
        },
        ...[...reference.annotations.map((a) => a.id), reference.adjudication.id].map(
          (subjectId) => ({ asset: "annotation", subjectId, operations }),
        ),
      ];
      if (capability === "lyrics_alignment") {
        if (track.lyricsSubjectId === null)
          throw new Error("Lyrics Reference without a lyrics subject");
        uses.push({
          asset: "lyrics",
          subjectId: track.lyricsSubjectId,
          operations: [...operations, "human_annotation"],
        });
      }
      const verdict = evaluateRights(track.rights, { ...context, uses });
      if (!verdict.eligible) failures.push(capability);
    }
    return {
      track,
      coverage,
      eligible: [...capabilities].filter((c) => !failures.includes(c)),
      denied: failures.sort(),
    };
  });
  const rows = manifest.requirements
    .toSorted((a, b) =>
      `${a.capability}:${a.slice}`.localeCompare(`${b.capability}:${b.slice}`, "en"),
    )
    .flatMap((requirement) =>
      (["calibration", "sealed"] as const).map((group) => {
        const matching = evaluated.filter(
          (t) =>
            t.track.cohort === group &&
            t.track.slices.labels.includes(requirement.slice) &&
            t.eligible.includes(requirement.capability),
        );
        return {
          ...requirement,
          cohort: group,
          tracks: matching.length,
          trackSeconds: matching.reduce(
            (sum, t) => sum + t.track.durationSamples / t.track.sampleRate,
            0,
          ),
          ...matching.reduce(
            (sum, t) => {
              const evidence = t.coverage.get(requirement.capability)!;
              return {
                events: sum.events + evidence.events,
                eventSeconds: sum.eventSeconds + evidence.eventSeconds,
                negativeEvents: sum.negativeEvents + evidence.negativeEvents,
                negativeSeconds: sum.negativeSeconds + evidence.negativeSeconds,
              };
            },
            { events: 0, eventSeconds: 0, negativeEvents: 0, negativeSeconds: 0 },
          ),
        };
      }),
    );
  const payload = {
    version: "1.0",
    corpusHash: contentHash(manifest),
    context,
    purpose: manifest.purpose,
    releaseEvidence: false,
    reliability: "not_measured",
    trackCount: manifest.tracks.length,
    completeTrackRange: manifest.tracks.length >= 30 && manifest.tracks.length <= 50,
    inventoryComplete: rows.every((row) => row.tracks > 0),
    metricSufficiency: "not_evaluated",
    rows,
    denied: evaluated
      .filter((t) => t.denied.length > 0)
      .map((t) => ({ trackId: t.track.id, capabilities: t.denied }))
      .sort((a, b) => a.trackId.localeCompare(b.trackId, "en")),
  };
  return { ...payload, hash: contentHash(payload) };
}

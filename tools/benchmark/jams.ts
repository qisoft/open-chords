import { canonicalSerialize, pitchClassNumber, MusicalTimelineSchema } from "@open-chords/domain";
import { z } from "zod";

import {
  buildGoldReference,
  parseGoldReference,
  type AnnotationContent,
  type GoldReference,
} from "./annotations.ts";

type Observation = { time: number; duration: number; value: unknown; confidence: null };
type JamsAnnotation = {
  namespace: string;
  annotation_metadata: {
    annotator: { id: string };
    data_source: string;
    annotation_rules: string;
    version: string;
  };
  data: Observation[];
  time: number;
  duration: number;
};
type Jams = {
  file_metadata: {
    duration: number;
    jams_version: string;
    identifiers: { open_chords_track: string; canonical_audio_sha256: string };
  };
  annotations: JamsAnnotation[];
  sandbox: {
    open_chords: {
      version: string;
      goldHash: string;
      reliability: string;
      disagreements: GoldReference["disagreements"];
    };
  };
};
const chordSchema = MusicalTimelineSchema.shape.chordEvents.element.shape.value;
export function chordToHarte(input: unknown): string {
  const chord = chordSchema.parse(input);
  if (chord.kind === "no_chord") return "N";
  const quality: Record<typeof chord.quality, string[]> = {
    major: ["1", "3", "5"],
    minor: ["1", "b3", "5"],
    diminished: ["1", "b3", "b5"],
    augmented: ["1", "3", "#5"],
    sus2: ["1", "2", "5"],
    sus4: ["1", "4", "5"],
    major7: ["1", "3", "5", "7"],
    minor7: ["1", "b3", "5", "b7"],
    diminished7: ["1", "b3", "b5", "bb7"],
    half_diminished: ["1", "b3", "b5", "b7"],
  };
  const degrees = new Set(quality[chord.quality]);
  for (const extension of chord.extensions) {
    if (extension === "7")
      degrees.add(
        chord.quality === "major7" ? "7" : chord.quality === "diminished7" ? "bb7" : "b7",
      );
    else degrees.add(extension);
  }
  for (const addition of chord.additions) degrees.add(addition.slice(3));
  for (const altered of chord.alterations) {
    for (const degree of degrees)
      if (degree.replaceAll("b", "").replaceAll("#", "") === altered.slice(1))
        degrees.delete(degree);
    degrees.add(altered);
  }
  for (const omission of chord.omissions)
    for (const degree of degrees)
      if (degree.replaceAll("b", "").replaceAll("#", "") === omission.slice(2))
        degrees.delete(degree);
  const ordered = [...degrees].sort(
    (a, b) =>
      Number(a.replace(/[b#]/g, "")) - Number(b.replace(/[b#]/g, "")) ||
      (a < b ? -1 : a > b ? 1 : 0),
  );
  const bass =
    chord.bass === undefined
      ? ""
      : `/${["1", "b2", "2", "b3", "3", "4", "b5", "5", "b6", "6", "b7", "7"][(pitchClassNumber(chord.bass) - pitchClassNumber(chord.root) + 12) % 12]}`;
  return `${chord.root}:(${ordered.join(",")})${bass}`;
}
function projection(
  content: AnnotationContent,
  sampleRate: number,
): { namespace: string; data: Observation[] }[] {
  const observation = (start: number, end: number, value: unknown): Observation => ({
    time: start / sampleRate,
    duration: (end - start) / sampleRate,
    value,
    confidence: null,
  });
  if (content.capability === "chords")
    return [
      {
        namespace: "chord",
        data: content.events.map((event) =>
          observation(event.startSample, event.endSample, chordToHarte(event.value)),
        ),
      },
    ];
  if (content.capability === "key")
    return [
      {
        namespace: "key_mode",
        data: content.events.map((event) =>
          observation(
            event.startSample,
            event.endSample,
            event.value.kind === "unknown"
              ? "N"
              : event.value.mode === "other"
                ? event.value.tonic
                : `${event.value.tonic}:${event.value.mode}`,
          ),
        ),
      },
    ];
  if (content.capability === "sections")
    return [
      {
        namespace: "segment_open",
        data: content.events.map((event) =>
          observation(event.startSample, event.endSample, event.label),
        ),
      },
    ];
  if (content.capability === "rhythm" || content.capability === "meter")
    return [
      {
        namespace: "beat",
        data: content.bars.flatMap((bar) =>
          bar.beats.map((beat, index) => observation(beat.atSample, beat.atSample, index + 1)),
        ),
      },
    ];
  return [
    {
      namespace: "lyrics",
      data: content.tokens.flatMap(({ tokenId, timing }) =>
        timing.state === "matched"
          ? [
              observation(
                timing.startSample,
                timing.endSample,
                content.document.tokens.find(({ id }) => id === tokenId)!.text,
              ),
            ]
          : [],
      ),
    },
  ];
}
export function goldToJams(input: unknown): Jams {
  const gold = parseGoldReference(input),
    first = gold.annotations[0],
    duration = first.durationSamples / first.sampleRate;
  const layers = [
    ...gold.annotations.map((raw) => ({
      namespace: "open_chords_raw_v1",
      record: raw,
      content: raw.content,
      person: raw.annotator.id,
      source: raw.source,
    })),
    {
      namespace: "open_chords_gold_v1",
      record: gold.adjudication,
      content: gold.adjudication.result,
      person: gold.adjudication.adjudicator.id,
      source: gold.adjudication.source,
    },
  ];
  const annotations: JamsAnnotation[] = [];
  for (const layer of layers) {
    const metadata = {
      annotator: { id: layer.person },
      data_source: layer.source,
      annotation_rules: first.guideHash,
      version: "1.0",
    };
    annotations.push({
      namespace: layer.namespace,
      annotation_metadata: metadata,
      time: 0,
      duration,
      data: [
        {
          time: 0,
          duration,
          confidence: null,
          value: {
            startSample: 0,
            endSample: first.durationSamples,
            sampleRate: first.sampleRate,
            record: layer.record,
          },
        },
      ],
    });
    for (const standard of projection(layer.content, first.sampleRate))
      annotations.push({ ...standard, annotation_metadata: metadata, time: 0, duration });
  }
  return {
    file_metadata: {
      duration,
      jams_version: "0.3.5",
      identifiers: { open_chords_track: first.trackId, canonical_audio_sha256: first.audioHash },
    },
    annotations,
    sandbox: {
      open_chords: {
        version: "1.0",
        goldHash: gold.hash,
        reliability: gold.reliability,
        disagreements: gold.disagreements,
      },
    },
  };
}
export function goldFromJams(input: unknown): GoldReference {
  const container = z
    .object({
      annotations: z.array(
        z.object({ namespace: z.string(), data: z.array(z.object({ value: z.unknown() })).min(1) }),
      ),
    })
    .parse(input);
  const records = container.annotations.filter(
    ({ namespace }) => namespace === "open_chords_raw_v1" || namespace === "open_chords_gold_v1",
  );
  if (
    records.length !== 3 ||
    records[0]!.namespace !== "open_chords_raw_v1" ||
    records[1]!.namespace !== "open_chords_raw_v1" ||
    records[2]!.namespace !== "open_chords_gold_v1"
  )
    throw new Error("Expected two raw annotations and one adjudication");
  const record = (index: number) =>
    z.object({ record: z.unknown() }).parse(records[index]!.data[0]!.value).record;
  const gold = buildGoldReference({ annotations: [record(0), record(1)], adjudication: record(2) });
  if (canonicalSerialize(input) !== canonicalSerialize(goldToJams(gold)))
    throw new Error("JAMS derivatives or Gold hash differ from canonical sample records");
  return gold;
}

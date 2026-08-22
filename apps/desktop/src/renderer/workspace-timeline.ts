import { materializeEffectiveTimeline, type ProjectContract } from "@open-chords/domain";

export type WorkspaceTimelineRegion = {
  chordLabels: string[];
  endSample: number;
  id: string;
  kind: "bar" | "unmetered";
  label: string;
  startSample: number;
};

export type WorkspaceTimeline = {
  durationSamples: number;
  regions: WorkspaceTimelineRegion[];
};

export function buildWorkspaceTimeline(project: ProjectContract): WorkspaceTimeline {
  if (project.activeView === null) {
    return {
      durationSamples: project.durationSamples,
      regions: [
        {
          chordLabels: [],
          endSample: project.durationSamples,
          id: `${project.id}_range`,
          kind: "unmetered",
          label: "Unanalyzed Project range",
          startSample: 0,
        },
      ],
    };
  }

  const timeline = materializeEffectiveTimeline(project);
  const regions = [
    ...timeline.bars.map((bar) => ({
      endSample: bar.endSample,
      id: bar.id,
      kind: "bar" as const,
      label: `${capitalize(bar.status)}, ${String(bar.meter.numerator)}/${String(bar.meter.denominator)}`,
      startSample: bar.startSample,
    })),
    ...timeline.unmeteredRegions.map((region) => ({
      endSample: region.endSample,
      id: region.id,
      kind: "unmetered" as const,
      label: "Unmetered region",
      startSample: region.startSample,
    })),
  ]
    .toSorted((left, right) => left.startSample - right.startSample)
    .map((region) => ({
      ...region,
      chordLabels: timeline.chordEvents
        .filter(
          (event) => event.startSample < region.endSample && event.endSample > region.startSample,
        )
        .map(({ value }) => chordLabel(value)),
    }));
  return { durationSamples: project.durationSamples, regions };
}

type ChordValue =
  ProjectContract["analysisRevisions"][number]["timeline"]["chordEvents"][number]["value"];

function chordLabel(value: ChordValue): string {
  if (value.kind === "no_chord") return "N";
  const quality = {
    augmented: "aug",
    diminished: "dim",
    diminished7: "dim7",
    half_diminished: "m7b5",
    major: "",
    major7: "maj7",
    minor: "m",
    minor7: "m7",
    sus2: "sus2",
    sus4: "sus4",
  }[value.quality];
  const details = [
    ...value.extensions,
    ...value.additions,
    ...value.alterations,
    ...value.omissions,
  ];
  return `${value.root}${quality}${details.length === 0 ? "" : `(${details.join(", ")})`}${value.bass === undefined ? "" : `/${value.bass}`}`;
}

function capitalize(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

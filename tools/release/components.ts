import {
  DARWIN_COMPONENT_IDS,
  WINDOWS_COMPONENT_IDS,
  type DarwinReleaseManifest,
  type InstalledEntry,
  type WindowsReleaseManifest,
} from "./release-manifest.ts";
import { PRODUCT_NAME } from "./release-target.ts";

type DarwinComponentId = (typeof DARWIN_COMPONENT_IDS)[number];
type WindowsComponentId = (typeof WINDOWS_COMPONENT_IDS)[number];

const DARWIN_CONTENTS = `${PRODUCT_NAME}.app/Contents/`;
const DARWIN_SERVICE_RESOURCES = "XPCServices/OpenChordsAnalysisService.xpc/Contents/Resources/";

const DARWIN_CONTENTS_RULES: ReadonlyArray<readonly [prefix: string, id: DarwinComponentId]> = [
  [`${DARWIN_SERVICE_RESOURCES}open-chords-analysis/`, "analysis-sidecar"],
  [`${DARWIN_SERVICE_RESOURCES}open-chords-alignment/`, "alignment-runtime"],
  [`${DARWIN_SERVICE_RESOURCES}open-chords-acquisition/`, "acquisition-runtime"],
  ["XPCServices/", "containment"],
  ["MacOS/containment/", "containment"],
  ["MacOS/open-chords-containment-bridge", "containment"],
  ["Resources/open-chords-analysis/", "analysis-sidecar-resources-copy"],
  ["Resources/containment/", "containment-resources-copy"],
  ["Resources/app.asar", "application"],
  ["Resources/notices/", "notices"],
];
const DARWIN_RULES = DARWIN_CONTENTS_RULES.map(
  ([prefix, id]) => [`${DARWIN_CONTENTS}${prefix}`, id] as const,
);

const WINDOWS_RULES: ReadonlyArray<readonly [prefix: string, id: WindowsComponentId]> = [
  ["resources/open-chords-analysis/", "analysis-sidecar"],
  ["resources/open-chords-alignment/", "alignment-runtime"],
  ["resources/open-chords-acquisition/", "acquisition-runtime"],
  ["resources/containment/", "containment"],
  ["resources/app.asar", "application"],
  ["resources/notices/", "notices"],
];

function measureSizes<Id extends string>(
  entries: readonly InstalledEntry[],
  downloadBytes: number,
  ids: readonly Id[],
  rules: ReadonlyArray<readonly [prefix: string, id: Id]>,
  shell: Id,
) {
  const components = new Map(ids.map((id) => [id, { id, bytes: 0, files: 0 }]));
  for (const entry of entries) {
    const id = rules.find(([prefix]) => entry.path.startsWith(prefix))?.[1] ?? shell;
    const component = components.get(id)!;
    component.bytes += entry.kind === "file" ? entry.bytes : 0;
    component.files += 1;
  }
  return {
    downloadBytes,
    installedBytes: entries.reduce(
      (sum, entry) => sum + (entry.kind === "file" ? entry.bytes : 0),
      0,
    ),
    installedFiles: entries.length,
    longestPathCharacters: entries.reduce(
      (longest, entry) => Math.max(longest, entry.path.length),
      0,
    ),
    components: [...components.values()],
  };
}

export function measureDarwinSizes(
  entries: readonly InstalledEntry[],
  downloadBytes: number,
): DarwinReleaseManifest["sizes"] {
  return measureSizes(entries, downloadBytes, DARWIN_COMPONENT_IDS, DARWIN_RULES, "electron-shell");
}

export function measureWindowsSizes(
  entries: readonly InstalledEntry[],
  downloadBytes: number,
): WindowsReleaseManifest["sizes"] {
  return measureSizes(
    entries,
    downloadBytes,
    WINDOWS_COMPONENT_IDS,
    WINDOWS_RULES,
    "electron-shell",
  );
}

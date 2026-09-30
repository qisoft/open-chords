import { expect, it } from "vitest";

import { measureDarwinSizes, measureWindowsSizes } from "../tools/release/components.ts";
import type { InstalledEntry } from "../tools/release/release-manifest.ts";

const DIGEST = "0".repeat(64);

function file(path: string, bytes: number): InstalledEntry {
  return { path, kind: "file", bytes, sha256: DIGEST, executable: false };
}

it("attributes every macOS entry to the first matching component", () => {
  const contents = "Open Chords.app/Contents";
  const service = `${contents}/XPCServices/OpenChordsAnalysisService.xpc/Contents`;
  const entries: InstalledEntry[] = [
    file(`${service}/Resources/open-chords-analysis/open-chords-analysis`, 100),
    file(`${service}/Resources/open-chords-alignment/bin/mfa`, 200),
    file(`${service}/Resources/open-chords-acquisition/deno`, 300),
    file(`${service}/MacOS/open-chords-analysis-service`, 4),
    file(`${contents}/MacOS/containment/containment-manifest.json`, 5),
    file(`${contents}/MacOS/open-chords-containment-bridge`, 6),
    file(`${contents}/Resources/open-chords-analysis/open-chords-analysis`, 70),
    file(`${contents}/Resources/containment/containment-manifest.json`, 8),
    file(`${contents}/Resources/app.asar`, 900),
    file(`${contents}/Resources/notices/README.txt`, 10),
    file(`${contents}/MacOS/Open Chords`, 1000),
    {
      path: `${contents}/Frameworks/Squirrel.framework/Squirrel`,
      kind: "symlink",
      target: "Versions/Current/Squirrel",
    },
  ];

  expect(measureDarwinSizes(entries, 1234)).toEqual({
    downloadBytes: 1234,
    installedBytes: 2603,
    installedFiles: 12,
    longestPathCharacters: 127,
    components: [
      { id: "analysis-sidecar", bytes: 100, files: 1 },
      { id: "alignment-runtime", bytes: 200, files: 1 },
      { id: "acquisition-runtime", bytes: 300, files: 1 },
      { id: "containment", bytes: 15, files: 3 },
      { id: "analysis-sidecar-resources-copy", bytes: 70, files: 1 },
      { id: "containment-resources-copy", bytes: 8, files: 1 },
      { id: "application", bytes: 900, files: 1 },
      { id: "notices", bytes: 10, files: 1 },
      { id: "electron-shell", bytes: 1000, files: 2 },
    ],
  });
});

it("attributes every Windows entry to the first matching component", () => {
  const entries: InstalledEntry[] = [
    file("resources/open-chords-analysis/open-chords-analysis.exe", 100),
    file("resources/open-chords-alignment/open-chords-alignment.exe", 200),
    file("resources/open-chords-acquisition/deno.exe", 300),
    file("resources/containment/open-chords-containment-launcher.exe", 40),
    file("resources/app.asar", 900),
    file("resources/notices/README.txt", 10),
    file("Open Chords.exe", 1000),
    file("LICENSES.chromium.html", 20),
  ];

  expect(measureWindowsSizes(entries, 99)).toEqual({
    downloadBytes: 99,
    installedBytes: 2570,
    installedFiles: 8,
    longestPathCharacters: 58,
    components: [
      { id: "analysis-sidecar", bytes: 100, files: 1 },
      { id: "alignment-runtime", bytes: 200, files: 1 },
      { id: "acquisition-runtime", bytes: 300, files: 1 },
      { id: "containment", bytes: 40, files: 1 },
      { id: "application", bytes: 900, files: 1 },
      { id: "notices", bytes: 10, files: 1 },
      { id: "electron-shell", bytes: 1020, files: 2 },
    ],
  });
});

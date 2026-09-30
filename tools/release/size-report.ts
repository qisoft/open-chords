import type { ReleaseManifest } from "./release-manifest.ts";

const TARGET_LABELS = {
  "macos-arm64": "macOS arm64",
  "windows-x64": "Windows x64",
} as const;

function mebibytes(bytes: number): string {
  return (bytes / 1_048_576).toFixed(2);
}

export function renderSizesTable(manifest: ReleaseManifest): string {
  const { sizes } = manifest;
  const rows: Array<readonly [string, number]> = [
    ["Download (ZIP)", sizes.downloadBytes],
    ["Installed", sizes.installedBytes],
    ...sizes.components.map(
      (component) => [`Installed: ${component.id}`, component.bytes] as const,
    ),
  ];
  return [
    `### ${TARGET_LABELS[manifest.target.id]} (\`${manifest.archive.fileName}\`)`,
    "",
    "| Measure | MiB | Bytes |",
    "| --- | ---: | ---: |",
    ...rows.map(([label, bytes]) => `| ${label} | ${mebibytes(bytes)} | ${bytes} |`),
    "",
    `Installed files: ${sizes.installedFiles}. Longest installed path: ${sizes.longestPathCharacters} characters.`,
    "",
  ].join("\n");
}

import type { ReleaseManifest } from "./release-manifest.ts";
import { renderSizesTable } from "./size-report.ts";

const REPOSITORY = "qisoft/open-chords";

export function renderReleaseNotes(manifests: readonly ReleaseManifest[]): string {
  if (manifests.length === 0) throw new Error("Release notes need at least one release manifest");
  const versions = new Set(manifests.map((manifest) => manifest.product.version));
  if (versions.size !== 1) throw new Error("Release manifests disagree on the product version");
  const [version] = versions;
  return [
    `## Open Chords ${version!}`,
    "",
    "These are unsigned community builds. They are not notarized, not publisher-signed, and never update automatically. Check for a newer release on this page yourself.",
    "",
    `Read [the installation guide](https://github.com/${REPOSITORY}/blob/main/docs/distribution/installing.md) before the first launch. It explains macOS **Open Anyway** and the Windows SmartScreen prompt.`,
    "",
    "## Verify a download",
    "",
    "Check the file against `SHA256SUMS` from this release:",
    "",
    "```sh",
    "shasum -a 256 -c SHA256SUMS --ignore-missing",
    "```",
    "",
    "On Windows, compare the output of `Get-FileHash <file> -Algorithm SHA256` in PowerShell with the matching line in `SHA256SUMS`.",
    "",
    "Check that GitHub Actions in this repository built the file:",
    "",
    "```sh",
    `gh attestation verify <file> --repo ${REPOSITORY}`,
    "```",
    "",
    "## Measured sizes",
    "",
    ...manifests.map(renderSizesTable),
  ].join("\n");
}

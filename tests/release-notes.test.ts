import { expect, it } from "vitest";

import { renderReleaseNotes } from "../tools/release/release-notes.ts";
import { renderSizesTable } from "../tools/release/size-report.ts";
import {
  darwinManifestFixture,
  windowsManifestFixture,
} from "./support/release-manifest-fixture.ts";

const macos = darwinManifestFixture({
  fileName: "open-chords-0.0.0-macos-arm64.zip",
  bytes: 3_145_728,
  sha256: "b".repeat(64),
});

it("reports measured sizes in MiB and exact bytes", () => {
  expect(renderSizesTable(macos)).toBe(
    [
      "### macOS arm64 (`open-chords-0.0.0-macos-arm64.zip`)",
      "",
      "| Measure | MiB | Bytes |",
      "| --- | ---: | ---: |",
      "| Download (ZIP) | 3.00 | 3145728 |",
      "| Installed | 0.00 | 3 |",
      "| Installed: analysis-sidecar | 0.00 | 0 |",
      "| Installed: electron-shell | 0.00 | 3 |",
      "",
      "Installed files: 2. Longest installed path: 62 characters.",
      "",
    ].join("\n"),
  );
});

it("publishes the unsigned distribution statement, verification steps, and every target", () => {
  const windows = windowsManifestFixture({
    fileName: "open-chords-0.0.0-windows-x64.zip",
    bytes: 1,
    sha256: "c".repeat(64),
  });
  const notes = renderReleaseNotes([macos, windows]);

  expect(notes.split("\n").filter((line) => line.startsWith("#"))).toEqual([
    "## Open Chords 0.0.0",
    "## Verify a download",
    "## Measured sizes",
    "### macOS arm64 (`open-chords-0.0.0-macos-arm64.zip`)",
    "### Windows x64 (`open-chords-0.0.0-windows-x64.zip`)",
  ]);
  expect(notes).toContain(
    "These are unsigned community builds. They are not notarized, not publisher-signed, and never update automatically.",
  );
  expect(notes).toContain("gh attestation verify <file> --repo qisoft/open-chords");
  expect(notes).toContain("shasum -a 256 -c SHA256SUMS --ignore-missing");
  expect(notes).toContain("docs/distribution/installing.md");
});

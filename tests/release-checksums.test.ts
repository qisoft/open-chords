import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import { writeChecksums } from "../tools/release/checksums.ts";
import { serializeReleaseManifest } from "../tools/release/manifest-files.ts";
import { darwinManifestFixture } from "./support/release-manifest-fixture.ts";

const ZIP = "open-chords-0.0.0-macos-arm64.zip";
const ZIP_SHA256 = "257a4c075a4c2721970ffc7ef0380d0bf7329185de8f34ff9a6ac8336561c34c";
const SBOM = "open-chords-0.0.0-macos-arm64.spdx.json";
const SBOM_SHA256 = "ca3d163bab055381827226140568f3bef7eaac187cebd76878e0b63e9e442356";

function assetsDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "open-chords-release-assets-"));
  writeFileSync(join(directory, SBOM), "{}\n");
  writeFileSync(join(directory, ZIP), "zip\n");
  return directory;
}

it("writes sha256sum-compatible lines sorted by file name", async () => {
  const directory = assetsDirectory();
  writeFileSync(join(directory, "SHA256SUMS"), "stale\n");

  await writeChecksums(directory);

  expect(readFileSync(join(directory, "SHA256SUMS"), "utf8")).toBe(
    `${SBOM_SHA256}  ${SBOM}\n${ZIP_SHA256}  ${ZIP}\n`,
  );
});

it("accepts a manifest that matches its archive and rejects one that does not", async () => {
  const matching = assetsDirectory();
  const manifest = darwinManifestFixture({ fileName: ZIP, bytes: 4, sha256: ZIP_SHA256 });
  writeFileSync(
    join(matching, "open-chords-0.0.0-macos-arm64.release-manifest.json"),
    serializeReleaseManifest(manifest),
  );
  const mismatched = assetsDirectory();
  writeFileSync(
    join(mismatched, "open-chords-0.0.0-macos-arm64.release-manifest.json"),
    serializeReleaseManifest({ ...manifest, archive: { ...manifest.archive, bytes: 5 } }),
  );

  expect((await writeChecksums(matching)).split("\n")).toContain(`${ZIP_SHA256}  ${ZIP}`);
  await expect(writeChecksums(mismatched)).rejects.toThrow(
    "open-chords-0.0.0-macos-arm64.zip does not match the macos-arm64 release manifest",
  );
});

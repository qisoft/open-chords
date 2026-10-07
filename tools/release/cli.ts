import { appendFile } from "node:fs/promises";

import { writeChecksums } from "./checksums.ts";
import { readReleaseManifests } from "./manifest-files.ts";
import { renderReleaseNotes } from "./release-notes.ts";
import { renderSizesTable } from "./size-report.ts";
import { stageRelease } from "./stage-release.ts";

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "stage" && args.length === 0) {
    const { manifest, manifestPath } = await stageRelease(process.cwd(), process.env);
    const table = renderSizesTable(manifest);
    process.stdout.write(`Wrote ${manifestPath}\n\n${table}`);
    const summary = process.env.GITHUB_STEP_SUMMARY;
    if (summary) await appendFile(summary, `${table}\n`);
  } else if (command === "checksums" && args.length === 1) {
    process.stdout.write(await writeChecksums(args[0]!));
  } else if (command === "release-notes" && args.length === 1) {
    process.stdout.write(renderReleaseNotes(await readReleaseManifests(args[0]!)));
  } else {
    throw new Error("Usage: cli.ts stage | checksums <assetsDir> | release-notes <assetsDir>");
  }
}

await main();

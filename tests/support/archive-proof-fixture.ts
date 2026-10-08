import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { ProjectEnvelopeSchema } from "@open-chords/contracts";

import { ARCHIVE_PROOF_CASES } from "../../apps/desktop/src/main/packaged-archive-proof-constants.ts";
import { archivedProjectFor } from "../../apps/desktop/src/main/project-archive-format.ts";
import { openProjectLibrary } from "../../apps/desktop/src/main/project-library.ts";
import { rawZip, signedArchiveEntries, type RawZipEntry } from "./archive-zip.ts";
import { goldenRecords } from "./editor-fixture.ts";
import { leadSheetProject } from "./export-fixture.ts";

export async function prepareArchiveProofFixture(stateRoot: string) {
  const envelope = ProjectEnvelopeSchema.parse(
    JSON.parse(await readFile("packages/testkit/contracts/v1/valid/project-envelope.json", "utf8")),
  );
  envelope.payload = leadSheetProject();
  const records = goldenRecords();
  await (await openProjectLibrary({ stateRoot })).createProject({ envelope, records });
  const document = archivedProjectFor({ envelope, records }).document;
  const valid = signedArchiveEntries(document);
  const replaceProject = (change: Partial<RawZipEntry>) =>
    valid.map((entry) => (entry.name === "project.json" ? { ...entry, ...change } : entry));
  const cases: Record<(typeof ARCHIVE_PROOF_CASES)[number][0], Buffer> = {
    traversal: rawZip([...valid, { name: "../escape.json", data: Buffer.from("{}") }]),
    link: rawZip([
      ...valid,
      {
        name: "media/link",
        data: Buffer.from("/private/archive-proof"),
        externalAttributes: 0o120777 * 0x10000,
      },
    ]),
    collision: rawZip([...valid, { name: "PROJECT.json", data: Buffer.from("{}") }]),
    executable: rawZip([...valid, { name: "tools/run.exe", data: Buffer.from("MZ") }]),
    hash: rawZip(
      replaceProject({
        data: Buffer.from(valid[1]!.data.toString().replace("project_golden", "project_broken")),
      }),
    ),
    future: rawZip(
      signedArchiveEntries(document, {
        manifest: (manifest) => ({ ...manifest, formatVersion: "2.0" }),
      }),
    ),
    size: rawZip(replaceProject({ declaredSize: 200 * 1024 * 1024 })),
    encrypted: rawZip(replaceProject({ flags: 0x0801 })),
  };
  const input = join(stateRoot, "archive-proof-input");
  await mkdir(input);
  await Promise.all(
    ARCHIVE_PROOF_CASES.map(([name]) => writeFile(join(input, `${name}.ocarchive`), cases[name])),
  );
}

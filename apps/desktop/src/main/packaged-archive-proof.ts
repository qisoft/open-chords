import { dirname, join } from "node:path";

import { canonicalSerialize } from "@open-chords/domain";

import { readBoundedFile } from "./bounded-file.ts";
import { openOfflineMediaCache } from "./offline-media-cache.ts";
import { ARCHIVE_PROOF_CASES } from "./packaged-archive-proof-constants.ts";
import { proofTreeHashes } from "./packaged-proof-tree.ts";
import { archivedProjectFor } from "./project-archive-format.ts";
import { ProjectArchiveImports } from "./project-archive-imports.ts";
import { inspectPortableProjectArchive } from "./project-archive-inspection.ts";
import { ARCHIVE_ZIP_LIMITS } from "./project-archive-zip.ts";
import { openProjectLibrary } from "./project-library.ts";

// Uses only fixed synthetic inputs prepared by native CI. Selection is a module
// interface, so this proof does not claim native Open dialog interaction.
export async function runPackagedArchiveProof(stateRoot: string) {
  const archive = join(dirname(stateRoot), "packaged-export-output", "song.ocarchive");
  const expected = inspectPortableProjectArchive(
    await readBoundedFile(archive, ARCHIVE_ZIP_LIMITS.maxArchiveBytes),
  ).document;
  const importedState = join(stateRoot, "archive-proof-import");
  const library = await openProjectLibrary({ stateRoot: importedState });
  if (library.listProjects().length !== 0) throw new Error("archive_proof_fixture_invalid");
  const cache = await openOfflineMediaCache({ stateRoot: importedState });
  const importer = (path: string | null) =>
    new ProjectArchiveImports({ library, cache, pickArchive: async () => path });
  const imported = await importer(archive).importArchive();
  if (
    imported.state !== "imported" ||
    imported.importedCopy ||
    imported.offlineMedia.state !== "not_included"
  )
    throw new Error("archive_proof_import_failed");
  const actual = archivedProjectFor(await library.readProject("project_golden")).document;
  if (canonicalSerialize(actual) !== canonicalSerialize(expected))
    throw new Error("archive_proof_roundtrip_failed");
  process.stderr.write("Archive proof stage: roundtrip_verified\n");
  const baseline = canonicalSerialize(await proofTreeHashes(library.activeRoot));
  const unchanged = async () => {
    if (canonicalSerialize(await proofTreeHashes(library.activeRoot)) !== baseline)
      throw new Error("archive_proof_library_changed");
  };
  const duplicate = await importer(archive).importArchive();
  if (duplicate.state !== "already_present" || duplicate.importedCopy)
    throw new Error("archive_proof_duplicate_failed");
  await unchanged();
  if ((await importer(null).importArchive()).state !== "cancelled")
    throw new Error("archive_proof_cancellation_failed");
  await unchanged();
  for (const [name, reason] of ARCHIVE_PROOF_CASES) {
    process.stderr.write(`Archive proof stage: rejecting_${name}\n`);
    const response = await importer(
      join(stateRoot, "archive-proof-input", `${name}.ocarchive`),
    ).importArchive();
    if (response.state !== "rejected" || response.reason !== reason)
      throw new Error("archive_proof_rejection_failed");
    await unchanged();
  }
  const reopened = await openProjectLibrary({ stateRoot: importedState });
  if (
    reopened.listProjects().length !== 1 ||
    canonicalSerialize(
      archivedProjectFor(await reopened.readProject("project_golden")).document,
    ) !== canonicalSerialize(expected)
  )
    throw new Error("archive_proof_reopen_failed");
  await unchanged();
  return {
    proof: "installed-archives",
    roundtrip: true,
    duplicateUnchanged: true,
    cancellationUnchanged: true,
    rejectedUnchanged: ARCHIVE_PROOF_CASES.length,
    durableReopen: true,
  };
}

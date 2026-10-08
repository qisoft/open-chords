import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import { exportTarget, openProjectExports } from "./project-exports.ts";
import { openProjectLibrary } from "./project-library.ts";

export const PACKAGED_EXPORT_PROOF_ARGUMENT = "--open-chords-export-proof";

// CI seeds only synthetic Project data in an isolated user-data directory.
// Fixed targets exercise bundled projections, not native Save dialog selection.
export async function runPackagedExportProof(stateRoot: string) {
  const library = await openProjectLibrary({ stateRoot });
  const projectId = "project_golden";
  const initial = await library.getSnapshot(projectId);
  if (!initial || library.listExportReceipts(projectId).length !== 0)
    throw new Error("export_proof_fixture_invalid");
  const cancelled = await openProjectExports({ library, stateRoot, pickTarget: async () => null });
  const cancellation = await cancelled.saveJson({
    projectId,
    expectedProjectRevisionId: initial.projectRevisionId,
    presentation: "current",
  });
  if (
    cancellation.state !== "cancelled" ||
    (await library.getSnapshot(projectId))?.projectRevisionId !== initial.projectRevisionId ||
    library.listExportReceipts(projectId).length !== 0
  )
    throw new Error("export_proof_cancellation_failed");

  const outputRoot = join(dirname(stateRoot), "packaged-export-output");
  await mkdir(outputRoot);
  const exports = await openProjectExports({
    library,
    stateRoot,
    pickTarget: async (format) =>
      join(
        outputRoot,
        format === "project_archive" ? "song.ocarchive" : `score.${exportTarget(format).extension}`,
      ),
  });
  for (const type of [
    "save_json",
    "save_archive",
    "save_chordpro",
    "save_lrc",
    "save_pdf",
  ] as const) {
    const snapshot = await library.getSnapshot(projectId);
    if (!snapshot) throw new Error("export_proof_project_missing");
    const request = { projectId, expectedProjectRevisionId: snapshot.projectRevisionId, type };
    const result = await exports.perform(
      type === "save_archive"
        ? { ...request, type, includeMedia: false }
        : type === "save_lrc"
          ? { ...request, type }
          : { ...request, type, presentation: "current" },
    );
    if (result.state !== "saved") throw new Error("export_proof_publication_failed");
  }
  const reopened = await openProjectLibrary({ stateRoot });
  if (reopened.listExportReceipts(projectId).length !== 5)
    throw new Error("export_proof_reopen_failed");
  return { proof: "installed-exports", cancelledWithoutRevision: true, durableReceipts: 5 };
}

import { RecoveryActionSchema, type RecoveryResult } from "@open-chords/contracts";

import type { ProjectLibrary, ProjectLibraryListEntry } from "./project-library.ts";

function summary(entry: ProjectLibraryListEntry): RecoveryResult["projects"][number] {
  return {
    projectId: entry.projectId,
    status: entry.status === "damaged" ? "damaged" : "active",
    compatibility: entry.compatibility ?? null,
    projectRevisionId: entry.projectRevisionId ?? null,
    readOnlyReason:
      entry.migrationFailure !== undefined
        ? "migration_failed"
        : entry.compatibility === "read_only"
          ? "unsupported_schema"
          : null,
    recoveredHead: entry.recoveryReport !== undefined,
  };
}

export class ProjectRecovery {
  readonly #library: ProjectLibrary;
  #busy = false;
  constructor(library: ProjectLibrary) {
    this.#library = library;
  }
  async perform(raw: unknown): Promise<RecoveryResult> {
    const action = RecoveryActionSchema.parse(raw);
    if (this.#busy) throw new Error("A recovery operation is running");
    this.#busy = true;
    try {
      let restoredProjectRevisionId: string | null = null;
      if (action.type === "rollback") {
        if (action.confirmedTargetProjectRevisionId !== action.targetProjectRevisionId)
          throw new Error("Confirm the selected backup Revision");
        restoredProjectRevisionId = (
          await this.#library.rollbackProject(
            action.projectId,
            action.targetProjectRevisionId,
            action.expectedProjectRevisionId,
          )
        ).projectRevisionId;
      }
      const all = this.#library.listProjects().filter((entry) => entry.status !== "trashed");
      const projects = all.slice(0, 10000).map(summary);
      let detail: RecoveryResult["detail"] = null;
      if (action.type !== "list") {
        const entry = all.find((candidate) => candidate.projectId === action.projectId);
        if (!entry) throw new Error("Project is unavailable");
        detail = {
          project: summary(entry),
          schemaVersion: null,
          earlierRevisionCount: 0,
          revisions: [],
          recovery: null,
        };
        if (entry.status !== "damaged") {
          const project = await this.#library.readProject(action.projectId);
          detail.schemaVersion = project.envelope.schemaVersion;
          detail.revisions = project.revisions.slice(-100).toReversed();
          detail.earlierRevisionCount = Math.max(0, project.revisions.length - 100);
        }
        if (entry.recoveryReport) {
          detail.recovery = {
            createdAt: entry.recoveryReport.createdAt,
            lostProjectRevisionId: entry.recoveryReport.lostProjectRevisionId,
            recoveredProjectRevisionId: entry.recoveryReport.recoveredProjectRevisionId,
          };
        }
      }
      return { projects, truncated: all.length > 10000, detail, restoredProjectRevisionId };
    } finally {
      this.#busy = false;
    }
  }
}

import { ProjectEventSchema, type ProjectEvent } from "@open-chords/contracts";

const MAX_GAP_RECOVERY_REFRESHES = 2;

export type EventSnapshot = {
  eventSequence: number;
};

export type ProjectStreamUpdate<TSnapshot extends EventSnapshot> =
  | { event: ProjectEvent; kind: "event" }
  | { kind: "ignored" }
  | { kind: "snapshot"; snapshot: TSnapshot };

export class ProjectEventStream<TSnapshot extends EventSnapshot> {
  readonly #lastSequences = new Map<string, number>();
  readonly #recoveries = new Map<
    string,
    { delivered: boolean; promise: Promise<{ applied: boolean; snapshot: TSnapshot }> }
  >();
  readonly #refresh: (projectId: string) => Promise<TSnapshot>;

  constructor(refresh: (projectId: string) => Promise<TSnapshot>) {
    this.#refresh = refresh;
  }

  synchronize(projectId: string, eventSequence: number): void {
    if (!Number.isSafeInteger(eventSequence) || eventSequence < 0) {
      throw new Error("Project event sequence must be a non-negative safe integer");
    }
    const currentSequence = this.#lastSequences.get(projectId) ?? 0;
    if (eventSequence > currentSequence) this.#lastSequences.set(projectId, eventSequence);
  }

  async accept(rawEvent: unknown): Promise<ProjectStreamUpdate<TSnapshot>> {
    const event = ProjectEventSchema.parse(rawEvent);
    while (true) {
      const lastSequence = this.#lastSequences.get(event.projectId) ?? 0;
      if (event.sequence <= lastSequence) return { kind: "ignored" };
      if (event.sequence === lastSequence + 1) {
        this.#lastSequences.set(event.projectId, event.sequence);
        return { event, kind: "event" };
      }

      let recovery = this.#recoveries.get(event.projectId);
      if (recovery === undefined) {
        const promise = this.#recoverGap(event.projectId, event.sequence);
        recovery = { delivered: false, promise };
        this.#recoveries.set(event.projectId, recovery);
        const cleanup = () => {
          if (this.#recoveries.get(event.projectId) === recovery) {
            this.#recoveries.delete(event.projectId);
          }
        };
        void promise.then(cleanup, cleanup);
      }

      const result = await recovery.promise;
      if (result.applied && !recovery.delivered) {
        recovery.delivered = true;
        return { kind: "snapshot", snapshot: result.snapshot };
      }
    }
  }

  async #recoverGap(
    projectId: string,
    targetSequence: number,
  ): Promise<{ applied: boolean; snapshot: TSnapshot }> {
    let applied = false;
    let snapshot: TSnapshot | undefined;

    for (let attempt = 0; attempt < MAX_GAP_RECOVERY_REFRESHES; attempt += 1) {
      const sequenceBeforeRefresh = this.#lastSequences.get(projectId) ?? 0;
      snapshot = await this.#refresh(projectId);
      if (snapshot.eventSequence > sequenceBeforeRefresh) {
        this.synchronize(projectId, snapshot.eventSequence);
        applied = true;
      }
      const currentSequence = this.#lastSequences.get(projectId) ?? 0;
      if (currentSequence >= targetSequence) return { applied, snapshot };
      if (currentSequence <= sequenceBeforeRefresh) break;
    }

    throw new Error("Project snapshot recovery did not close the event gap");
  }
}

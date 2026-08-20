import { ProjectEventSchema, type ProjectEvent } from "@open-chords/contracts";

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
    this.#lastSequences.set(projectId, eventSequence);
  }

  async accept(rawEvent: unknown): Promise<ProjectStreamUpdate<TSnapshot>> {
    const event = ProjectEventSchema.parse(rawEvent);
    const lastSequence = this.#lastSequences.get(event.projectId) ?? 0;
    if (event.sequence <= lastSequence) return { kind: "ignored" };
    if (event.sequence === lastSequence + 1) {
      this.#lastSequences.set(event.projectId, event.sequence);
      return { event, kind: "event" };
    }

    let recovery = this.#recoveries.get(event.projectId);
    if (recovery === undefined) {
      const promise = this.#refresh(event.projectId).then((snapshot) => {
        const currentSequence = this.#lastSequences.get(event.projectId) ?? 0;
        const applied = snapshot.eventSequence > currentSequence;
        if (applied) this.synchronize(event.projectId, snapshot.eventSequence);
        return { applied, snapshot };
      });
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
    const recoveredSequence = this.#lastSequences.get(event.projectId) ?? 0;
    if (event.sequence <= recoveredSequence) return { kind: "ignored" };
    if (event.sequence === recoveredSequence + 1) {
      this.#lastSequences.set(event.projectId, event.sequence);
      return { event, kind: "event" };
    }
    return this.accept(event);
  }
}

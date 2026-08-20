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

    const snapshot = await this.#refresh(event.projectId);
    this.synchronize(event.projectId, snapshot.eventSequence);
    return { kind: "snapshot", snapshot };
  }
}

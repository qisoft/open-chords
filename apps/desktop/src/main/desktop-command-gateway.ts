import {
  DESKTOP_IPC_PROTOCOL,
  DESKTOP_IPC_VERSION,
  DesktopCommandSchema,
  DesktopErrorResponseSchema,
  DesktopGenerationIdSchema,
  DesktopRequestIdSchema,
  DesktopResponseSchema,
  type DesktopCommand,
  type DesktopResponse,
} from "@open-chords/contracts";
import type { ModelRuntimeInfo } from "@open-chords/contracts";
import type { LyricsOrigin } from "@open-chords/domain";
import type { LyricsInput, PracticeAction } from "@open-chords/domain";
import {
  parseProjectContract,
  type EditHistoryAction,
  type EditMappingConflict,
  type EditTransaction,
  type ProjectContract,
} from "@open-chords/domain";

import { AlignmentServiceError, type AlignmentService } from "./alignment-service.ts";
import { APP_ENTRY_URL } from "./desktop-origin.ts";
import type {
  LocalMediaPlayback,
  LocalMediaRelinkResult,
  LocalMediaSelection,
} from "./local-media.ts";
import type { LyricsDiscovery } from "./lyrics-discovery.ts";
import type { ModelStore } from "./model-store.ts";
import type { NetworkMode } from "./network-mode.ts";
import type { DesktopSecurityConfiguration } from "./renderer-security.ts";

const MAX_COMMAND_BYTES = 256 * 1024;
const MAX_CONCURRENT_MEDIA_COMMANDS = 1;
const MAX_CONCURRENT_READS = 32;
const MAX_INVALID_COMMANDS = 3;
const MAX_PENDING_MUTATIONS = 32;
const MAX_PROJECT_LIST_ENTRIES = 10_000;
const MAX_TRACKED_INVALID_SENDERS = 1_024;
const MAX_MUTATIONS_PER_PROJECT = 32;
const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;

export type DesktopSenderContext = {
  frameUrl: string;
  generationId: string;
  isMainFrame: boolean;
  security: DesktopSecurityConfiguration;
  senderId: number;
};

export type ProjectAuthority = {
  addLyrics(input: {
    expectedProjectRevisionId: string;
    projectId: string;
    input: LyricsInput;
    origin?: LyricsOrigin;
  }): Promise<
    { notFound: true } | { projectRevisionId: string } | { readOnly: true } | { stale: true }
  >;
  changePractice(input: {
    expectedProjectRevisionId: string;
    projectId: string;
    action: PracticeAction;
  }): Promise<
    { notFound: true } | { projectRevisionId: string } | { readOnly: true } | { stale: true }
  >;
  changeEditHistory(input: {
    expectedProjectRevisionId: string;
    projectId: string;
    action: EditHistoryAction;
  }): Promise<
    | { conflicts: EditMappingConflict[] }
    | { notFound: true }
    | { projectRevisionId: string }
    | { readOnly: true }
    | { stale: true }
  >;

  commitEditTransaction(input: {
    expectedProjectRevisionId: string;
    projectId: string;
    transaction: EditTransaction;
  }): Promise<
    { notFound: true } | { projectRevisionId: string } | { readOnly: true } | { stale: true }
  >;
  getSnapshot(projectId: string): Promise<{
    eventSequence: number;
    project: ProjectContract;
    projectRevisionId: string;
  } | null>;
  listProjects(): readonly {
    compatibility?: "read_only" | "writable";
    projectId: string;
    projectRevisionId?: string;
    status: "active" | "damaged" | "trashed";
  }[];
};

export type LocalMediaAuthority = {
  createProject(input: {
    capabilityId: string;
    endSourceSample: number;
    generationId: string;
    startSourceSample: number;
  }): Promise<{ projectId: string; projectRevisionId: string; sourceId: string }>;
  openPlayback(input: { generationId: string; projectId: string }): Promise<LocalMediaPlayback>;
  pickLocalFile(generationId: string): Promise<LocalMediaSelection>;
  relinkSource(input: { generationId: string; sourceId: string }): Promise<LocalMediaRelinkResult>;
};

export type DesktopGatewayAction = "destroy_sender" | "none" | "reload_generation";

export type DesktopGatewayResult = {
  action: DesktopGatewayAction;
  response: DesktopResponse;
};

export type ModelGatewayService = {
  store: ModelStore;
  network: NetworkMode;
  runtime: ModelRuntimeInfo;
  references(): Array<{
    projectId: string;
    artifacts: Array<{ id: string; version: string; sha256: string }>;
    impactUnknown?: boolean | undefined;
  }>;
};

export class DesktopCommandGateway {
  readonly #authority: ProjectAuthority;
  readonly #invalidCounts = new Map<string, number>();
  readonly #mediaAuthority: LocalMediaAuthority | undefined;
  readonly #mutationDepths = new Map<string, number>();
  readonly #mutationQueues = new Map<string, Promise<void>>();
  readonly #lyrics:
    | { discovery: LyricsDiscovery; openExternal(url: string): Promise<void> }
    | undefined;
  readonly #models: ModelGatewayService | undefined;
  #modelsBusy = false;
  #modelsControlBusy = false;
  #lyricsBusy = false;
  readonly #alignment: AlignmentService | undefined;
  #alignmentBusy = false;
  #alignmentControlBusy = false;
  #activeMediaCommands = 0;
  #activeReads = 0;
  #pendingMutations = 0;

  constructor(
    authority: ProjectAuthority,
    mediaAuthority?: LocalMediaAuthority,
    lyrics?: { discovery: LyricsDiscovery; openExternal(url: string): Promise<void> },
    models?: ModelGatewayService,
    alignment?: AlignmentService,
  ) {
    this.#authority = authority;
    this.#models = models;
    this.#alignment = alignment;
    this.#lyrics = lyrics;
    this.#mediaAuthority = mediaAuthority;
  }

  async execute(
    rawCommand: unknown,
    sender: DesktopSenderContext,
    expectedType?: DesktopCommand["type"],
  ): Promise<DesktopGatewayResult> {
    if (
      !sender.isMainFrame ||
      sender.frameUrl !== APP_ENTRY_URL ||
      !isSecureRendererConfiguration(sender.security)
    ) {
      return {
        action: "destroy_sender",
        response: errorResponse("unauthorized_sender", "Renderer is not authorized", false),
      };
    }

    if (encodedSize(rawCommand) > MAX_COMMAND_BYTES) {
      return this.#invalid(rawCommand, sender, "Command exceeds the size limit");
    }

    const parsed = DesktopCommandSchema.safeParse(rawCommand);
    if (!parsed.success || (expectedType !== undefined && parsed.data.type !== expectedType)) {
      return this.#invalid(rawCommand, sender, "Command does not match its capability");
    }
    const command = parsed.data;

    if (command.generationId !== sender.generationId) {
      return {
        action: "reload_generation",
        response: errorResponse(
          "invalid_generation",
          "Renderer generation is no longer active",
          true,
          command,
        ),
      };
    }

    if (command.type === "shell.get_security_snapshot") {
      return {
        action: "none",
        response: DesktopResponseSchema.parse({
          ...responseEnvelope(command),
          security: {
            ...sender.security,
            ...command.runtimeSecurity,
          },
          type: "shell.security_snapshot",
        }),
      };
    }

    if (command.type === "alignment.perform") return this.#performAlignment(command);
    if (command.type === "models.perform") return this.#performModels(command);
    if (command.type === "lyrics.perform") return this.#performLyrics(command);
    if (command.type === "project.list") return this.#listProjects(command);
    if (command.type === "project.get_snapshot") return this.#readSnapshot(command);
    if (
      command.type === "project.commit_edit_transaction" ||
      command.type === "project.change_edit_history" ||
      command.type === "project.change_practice" ||
      command.type === "project.add_lyrics"
    )
      return this.#enqueueMutation(command);
    return this.#executeMedia(command);
  }

  async #executeMedia(
    command: Extract<DesktopCommand, { type: `media.${string}` }>,
  ): Promise<DesktopGatewayResult> {
    if (this.#mediaAuthority === undefined) {
      return {
        action: "none",
        response: errorResponse("source_unavailable", "Local media is unavailable", false, command),
      };
    }
    if (this.#activeMediaCommands >= MAX_CONCURRENT_MEDIA_COMMANDS) {
      return {
        action: "none",
        response: errorResponse("busy", "A local media operation is already active", true, command),
      };
    }
    this.#activeMediaCommands += 1;
    try {
      if (command.type === "media.pick_local_file") {
        const result = await this.#mediaAuthority.pickLocalFile(command.generationId);
        return this.#mediaResult(
          command,
          result.kind === "cancelled"
            ? { operation: "pick", type: "media.selection_cancelled" }
            : { ...omitKind(result), type: "media.selected" },
        );
      }
      if (command.type === "media.create_project") {
        const result = await this.#mediaAuthority.createProject({
          capabilityId: command.capabilityId,
          endSourceSample: command.endSourceSample,
          generationId: command.generationId,
          startSourceSample: command.startSourceSample,
        });
        return this.#mediaResult(command, { ...result, type: "media.project_created" });
      }
      if (command.type === "media.relink_source") {
        const result = await this.#mediaAuthority.relinkSource({
          generationId: command.generationId,
          sourceId: command.sourceId,
        });
        if (result.kind === "cancelled") {
          return this.#mediaResult(command, {
            operation: "relink",
            type: "media.selection_cancelled",
          });
        }
        if (result.kind === "relinked") {
          return this.#mediaResult(command, { sourceId: result.sourceId, type: "media.relinked" });
        }
        return this.#mediaResult(command, {
          ...omitKind(result),
          type: "media.different_source",
        });
      }
      const result = await this.#mediaAuthority.openPlayback({
        generationId: command.generationId,
        projectId: command.projectId,
      });
      return this.#mediaResult(
        command,
        result.kind === "unavailable"
          ? { ...omitKind(result), type: "media.source_unavailable" }
          : { ...omitKind(result), type: "media.playback_ready" },
      );
    } catch (error) {
      const capabilityUnavailable =
        error instanceof Error && /capability.*unavailable/i.test(error.message);
      return {
        action: "none",
        response: errorResponse(
          capabilityUnavailable ? "capability_unavailable" : "invalid_media",
          capabilityUnavailable
            ? "Local media capability is unavailable"
            : "Local media operation failed",
          false,
          command,
        ),
      };
    } finally {
      this.#activeMediaCommands -= 1;
    }
  }

  #mediaResult(
    command: Extract<DesktopCommand, { type: `media.${string}` }>,
    result: Record<string, unknown>,
  ): DesktopGatewayResult {
    return {
      action: "none",
      response: DesktopResponseSchema.parse({ ...responseEnvelope(command), ...result }),
    };
  }

  async #readSnapshot(
    command: Extract<DesktopCommand, { type: "project.get_snapshot" }>,
  ): Promise<DesktopGatewayResult> {
    if (this.#activeReads >= MAX_CONCURRENT_READS) {
      return {
        action: "none",
        response: errorResponse("busy", "Too many project reads are active", true, command),
      };
    }

    this.#activeReads += 1;
    try {
      const snapshot = await this.#authority.getSnapshot(command.projectId);
      if (snapshot === null) {
        return {
          action: "none",
          response: errorResponse("project_not_found", "Project was not found", false, command),
        };
      }
      const project = parseProjectContract(snapshot.project);
      if (project.id !== command.projectId) {
        throw new Error("Project authority returned a snapshot for a different Project");
      }
      const response = {
        ...responseEnvelope(command),
        ...snapshot,
        project,
        type: "project.snapshot",
      } as const;
      if (encodedSize(response) > MAX_SNAPSHOT_BYTES) {
        throw new Error("Project snapshot exceeds the size limit");
      }
      return {
        action: "none",
        response: DesktopResponseSchema.parse(response),
      };
    } catch {
      return {
        action: "none",
        response: errorResponse("internal_error", "Project read failed", true, command),
      };
    } finally {
      this.#activeReads -= 1;
    }
  }

  #listProjects(command: Extract<DesktopCommand, { type: "project.list" }>): DesktopGatewayResult {
    const projects = this.#authority
      .listProjects()
      .filter(
        (
          project,
        ): project is typeof project & {
          compatibility: "read_only" | "writable";
          projectRevisionId: string;
        } =>
          project.status === "active" &&
          project.compatibility !== undefined &&
          project.projectRevisionId !== undefined,
      )
      .map(({ compatibility, projectId, projectRevisionId }) => ({
        compatibility,
        projectId,
        projectRevisionId,
      }))
      .toSorted((left, right) => left.projectId.localeCompare(right.projectId))
      .slice(0, MAX_PROJECT_LIST_ENTRIES);
    return {
      action: "none",
      response: DesktopResponseSchema.parse({
        ...responseEnvelope(command),
        projects,
        type: "project.list",
      }),
    };
  }

  async #enqueueMutation(
    command: Extract<
      DesktopCommand,
      {
        type:
          | "project.commit_edit_transaction"
          | "project.change_edit_history"
          | "project.change_practice"
          | "project.add_lyrics";
      }
    >,
  ): Promise<DesktopGatewayResult> {
    if (this.#pendingMutations >= MAX_PENDING_MUTATIONS) {
      return {
        action: "none",
        response: errorResponse("busy", "Global mutation queue is full", true, command),
      };
    }
    const depth = this.#mutationDepths.get(command.projectId) ?? 0;
    if (depth >= MAX_MUTATIONS_PER_PROJECT) {
      return {
        action: "none",
        response: errorResponse("busy", "Project mutation queue is full", true, command),
      };
    }
    this.#pendingMutations += 1;
    this.#mutationDepths.set(command.projectId, depth + 1);
    const prior = this.#mutationQueues.get(command.projectId) ?? Promise.resolve();
    const task = prior.catch(() => undefined).then(async () => this.#commitMutation(command));
    const queueTail = task.then(
      () => undefined,
      () => undefined,
    );
    this.#mutationQueues.set(command.projectId, queueTail);
    try {
      return await task;
    } finally {
      this.#pendingMutations -= 1;
      const remaining = (this.#mutationDepths.get(command.projectId) ?? 1) - 1;
      if (remaining === 0) this.#mutationDepths.delete(command.projectId);
      else this.#mutationDepths.set(command.projectId, remaining);
      if (this.#mutationQueues.get(command.projectId) === queueTail) {
        this.#mutationQueues.delete(command.projectId);
      }
    }
  }

  async #performAlignment(
    command: Extract<DesktopCommand, { type: "alignment.perform" }>,
  ): Promise<DesktopGatewayResult> {
    if (!this.#alignment)
      return {
        action: "none",
        response: errorResponse(
          "capability_unavailable",
          "Alignment is unavailable",
          false,
          command,
        ),
      };
    const control = command.action.type === "cancel";
    if (control ? this.#alignmentControlBusy : this.#alignmentBusy)
      return {
        action: "none",
        response: errorResponse("busy", "An Alignment operation is running", true, command),
      };
    if (control) this.#alignmentControlBusy = true;
    else this.#alignmentBusy = true;
    try {
      const result = await this.#alignment.perform(command.action);
      return {
        action: "none",
        response: DesktopResponseSchema.parse({
          ...responseEnvelope(command),
          type: "alignment.result",
          ...result,
        }),
      };
    } catch (error) {
      return {
        action: "none",
        response: errorResponse(
          error instanceof AlignmentServiceError ? error.code : "capability_unavailable",
          error instanceof AlignmentServiceError
            ? error.message
            : "Alignment operation failed. Verify the Source and exact language pack, then retry.",
          true,
          command,
        ),
      };
    } finally {
      if (control) this.#alignmentControlBusy = false;
      else this.#alignmentBusy = false;
    }
  }

  async #performModels(
    command: Extract<DesktopCommand, { type: "models.perform" }>,
  ): Promise<DesktopGatewayResult> {
    const models = this.#models;
    if (!models)
      return {
        action: "none",
        response: errorResponse(
          "capability_unavailable",
          "Alignment packs unavailable",
          false,
          command,
        ),
      };
    const control = command.action.type === "cancel" || command.action.type === "set_offline";
    if (control ? this.#modelsControlBusy : this.#modelsBusy)
      return {
        action: "none",
        response: errorResponse("busy", "A model operation is running", true, command),
      };
    if (!control) this.#modelsBusy = true;
    else this.#modelsControlBusy = true;
    try {
      const action = command.action;
      let removal;
      if (action.type === "cancel") models.store.cancel();
      if (action.type === "set_offline") await models.network.setOffline(action.offline);
      if (action.type === "install") {
        if (!models.runtime.available) throw new Error("Runtime unavailable");
        await models.store.install(action.packId);
      }
      if (action.type === "preview_removal" || action.type === "remove") {
        removal = models.store.previewRemoval(action.packId, models.references());
        if (action.type === "remove") {
          if (removal.unknownProjectIds.length > 0)
            return {
              action: "none",
              response: errorResponse(
                "capability_unavailable",
                "Repair damaged Projects before removing this pack; dependency impact is unknown.",
                false,
                command,
              ),
            };
          if (action.impactId !== removal.impactId)
            return {
              action: "none",
              response: errorResponse(
                "stale_revision",
                "Affected Projects changed; review removal again",
                true,
                command,
              ),
            };
          await models.store.remove(action.packId);
        }
      }
      const packs = (await models.store.list()).map((pack) => ({
        id: pack.id,
        language: pack.language,
        version: pack.version,
        installed: pack.installed,
        transferBytes: pack.artifacts.reduce((sum, artifact) => sum + artifact.bytes, 0),
        installedBytes: pack.artifacts.reduce((sum, artifact) => sum + artifact.installedBytes, 0),
        artifacts: pack.artifacts.map((artifact) => ({
          id: artifact.id,
          version: artifact.version,
          sha256: artifact.sha256,
          source: artifact.url,
          license: artifact.license,
          attribution: artifact.attribution,
          modelCard: artifact.modelCard,
        })),
      }));
      return {
        action: "none",
        response: DesktopResponseSchema.parse({
          ...responseEnvelope(command),
          type: "models.result",
          offline: models.network.offline,
          runtime: models.runtime,
          packs,
          ...(removal ? { removal } : {}),
        }),
      };
    } catch {
      return {
        action: "none",
        response: errorResponse(
          "capability_unavailable",
          models.network.offline
            ? "Offline Mode is enabled"
            : "Model operation failed. Check the runtime and connection, then retry.",
          true,
          command,
        ),
      };
    } finally {
      if (!control) this.#modelsBusy = false;
      else this.#modelsControlBusy = false;
    }
  }

  async #performLyrics(
    command: Extract<DesktopCommand, { type: "lyrics.perform" }>,
  ): Promise<DesktopGatewayResult> {
    const lyrics = this.#lyrics;
    if (!lyrics)
      return {
        action: "none",
        response: errorResponse(
          "capability_unavailable",
          "Lyrics discovery unavailable",
          false,
          command,
        ),
      };
    const action = command.action;
    const result = (extra = {}) => ({
      action: "none" as const,
      response: DesktopResponseSchema.parse({
        ...responseEnvelope(command),
        type: "lyrics.result",
        offline: lyrics.discovery.offline,
        ...extra,
      }),
    });
    const control = ["status", "cancel", "set_offline"].includes(action.type);
    if (!control && this.#lyricsBusy)
      return {
        action: "none",
        response: errorResponse("busy", "A lyrics request is already running", true, command),
      };
    if (!control) this.#lyricsBusy = true;
    try {
      if (action.type === "status") return result();
      if (action.type === "cancel") {
        lyrics.discovery.cancel();
        return result();
      }
      if (action.type === "set_offline") {
        await lyrics.discovery.setOffline(action.offline);
        return result();
      }
      if (lyrics.discovery.offline) throw new Error("Offline Mode");
      if (action.type === "open_genius") {
        const url = new URL("https://genius.com/search");
        url.searchParams.set("q", action.query);
        await lyrics.openExternal(url.href);
        return result();
      }
      const snapshot = await this.#authority.getSnapshot(action.projectId);
      if (!snapshot)
        return {
          action: "none",
          response: errorResponse("project_not_found", "Project was not found", false, command),
        };
      if (action.type === "search")
        return result({
          candidates: await lyrics.discovery.search(
            { provider: action.provider, query: action.query },
            command.generationId,
            action.projectId,
          ),
        });
      if (snapshot.projectRevisionId !== action.expectedProjectRevisionId)
        return {
          action: "none",
          response: errorResponse(
            "stale_revision",
            "Project changed; choose lyrics again",
            true,
            command,
          ),
        };
      const selection = await lyrics.discovery.select(
        action.candidateId,
        command.generationId,
        action.projectId,
      );
      const saved = await this.#authority.addLyrics({
        projectId: action.projectId,
        expectedProjectRevisionId: action.expectedProjectRevisionId,
        input: { ...selection.input, language: action.language },
        origin: selection.origin,
      });
      if ("notFound" in saved)
        return {
          action: "none",
          response: errorResponse("project_not_found", "Project was not found", false, command),
        };
      if ("readOnly" in saved)
        return {
          action: "none",
          response: errorResponse(
            "project_read_only",
            "Project is read-only in this application",
            false,
            command,
          ),
        };
      if ("stale" in saved)
        return {
          action: "none",
          response: errorResponse(
            "stale_revision",
            "Project is no longer writable; choose lyrics again",
            true,
            command,
          ),
        };
      return result({ projectRevisionId: saved.projectRevisionId });
    } catch {
      lyrics.discovery.cancel();
      return {
        action: "none",
        response: errorResponse(
          "capability_unavailable",
          lyrics.discovery.offline
            ? "Offline Mode is enabled"
            : "Lyrics unavailable. Try again or paste local text.",
          true,
          command,
        ),
      };
    } finally {
      if (!control) this.#lyricsBusy = false;
    }
  }

  async #commitMutation(
    command: Extract<
      DesktopCommand,
      {
        type:
          | "project.commit_edit_transaction"
          | "project.change_edit_history"
          | "project.change_practice"
          | "project.add_lyrics";
      }
    >,
  ): Promise<DesktopGatewayResult> {
    try {
      const result =
        command.type === "project.add_lyrics"
          ? await this.#authority.addLyrics(command)
          : command.type === "project.change_practice"
            ? await this.#authority.changePractice(command)
            : command.type === "project.change_edit_history"
              ? await this.#authority.changeEditHistory(command)
              : await this.#authority.commitEditTransaction({
                  expectedProjectRevisionId: command.expectedProjectRevisionId,
                  projectId: command.projectId,
                  transaction: command.transaction,
                });
      if ("conflicts" in result)
        return {
          action: "none",
          response: DesktopResponseSchema.parse({
            ...responseEnvelope(command),
            type: "project.edit_conflicts",
            conflicts: result.conflicts,
          }),
        };
      if ("stale" in result) {
        return {
          action: "none",
          response: errorResponse(
            "stale_revision",
            "Project changed before this transaction could commit",
            true,
            command,
          ),
        };
      }
      if ("notFound" in result) {
        return {
          action: "none",
          response: errorResponse("project_not_found", "Project was not found", false, command),
        };
      }
      if ("readOnly" in result) {
        return {
          action: "none",
          response: errorResponse(
            "project_read_only",
            "Project is read-only in this application",
            false,
            command,
          ),
        };
      }
      return {
        action: "none",
        response: DesktopResponseSchema.parse({
          ...responseEnvelope(command),
          projectId: command.projectId,
          projectRevisionId: result.projectRevisionId,
          ...(command.type === "project.commit_edit_transaction"
            ? { transactionId: command.transaction.id, type: "project.committed" }
            : {
                type:
                  command.type === "project.add_lyrics"
                    ? "project.lyrics_added"
                    : command.type === "project.change_practice"
                      ? "project.practice_changed"
                      : "project.history_changed",
              }),
        }),
      };
    } catch {
      return {
        action: "none",
        response: errorResponse("internal_error", "Project mutation failed", true, command),
      };
    }
  }

  #invalid(
    rawCommand: unknown,
    sender: DesktopSenderContext,
    message: string,
  ): DesktopGatewayResult {
    const key = invalidCountKey(sender);
    const count = (this.#invalidCounts.get(key) ?? 0) + 1;
    this.#invalidCounts.set(key, count);
    while (this.#invalidCounts.size > MAX_TRACKED_INVALID_SENDERS) {
      const oldestKey = this.#invalidCounts.keys().next().value;
      if (oldestKey === undefined) break;
      this.#invalidCounts.delete(oldestKey);
    }
    const action = count >= MAX_INVALID_COMMANDS ? "reload_generation" : "none";
    if (action === "reload_generation") this.#invalidCounts.delete(key);
    return {
      action,
      response: errorResponse("invalid_command", message, false, correlationEnvelope(rawCommand)),
    };
  }
}

function omitKind<T extends { kind: string }>(value: T): Omit<T, "kind"> {
  const { kind: _kind, ...rest } = value;
  return rest;
}

function isSecureRendererConfiguration(configuration: DesktopSecurityConfiguration): boolean {
  return (
    configuration.contextIsolation &&
    !configuration.nodeIntegration &&
    !configuration.persistentSession &&
    configuration.sandbox &&
    configuration.webSecurity
  );
}

function invalidCountKey(sender: DesktopSenderContext): string {
  return `${String(sender.senderId)}:${sender.generationId}`;
}

function correlationEnvelope(
  value: unknown,
): Pick<DesktopCommand, "generationId" | "requestId"> | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  try {
    const generationId = DesktopGenerationIdSchema.safeParse(Reflect.get(value, "generationId"));
    const requestId = DesktopRequestIdSchema.safeParse(Reflect.get(value, "requestId"));
    if (!generationId.success || !requestId.success) return undefined;
    return { generationId: generationId.data, requestId: requestId.data };
  } catch {
    return undefined;
  }
}

function encodedSize(value: unknown): number {
  try {
    const encoded = JSON.stringify(value);
    return encoded === undefined
      ? Number.POSITIVE_INFINITY
      : new TextEncoder().encode(encoded).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function responseEnvelope(command: DesktopCommand) {
  return {
    generationId: command.generationId,
    protocol: DESKTOP_IPC_PROTOCOL,
    protocolVersion: DESKTOP_IPC_VERSION,
    requestId: command.requestId,
  } as const;
}

function errorResponse(
  code: Extract<DesktopResponse, { type: "desktop.error" }>["code"],
  message: string,
  retryable: boolean,
  command?: Pick<DesktopCommand, "generationId" | "requestId">,
): Extract<DesktopResponse, { type: "desktop.error" }> {
  return DesktopErrorResponseSchema.parse({
    code,
    generationId: command?.generationId ?? null,
    message,
    protocol: DESKTOP_IPC_PROTOCOL,
    protocolVersion: DESKTOP_IPC_VERSION,
    requestId: command?.requestId ?? null,
    retryable,
    type: "desktop.error",
  });
}

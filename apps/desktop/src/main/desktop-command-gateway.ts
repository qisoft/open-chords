import {
  DESKTOP_IPC_PROTOCOL,
  DESKTOP_IPC_VERSION,
  DesktopCommandSchema,
  DesktopErrorResponseSchema,
  DesktopMessageIdSchema,
  DesktopResponseSchema,
  type DesktopCommand,
  type DesktopResponse,
} from "@open-chords/contracts";
import {
  parseProjectContract,
  type EditTransaction,
  type ProjectContract,
} from "@open-chords/domain";

import { APP_ENTRY_URL } from "./desktop-origin.ts";

const MAX_COMMAND_BYTES = 256 * 1024;
const MAX_CONCURRENT_READS = 32;
const MAX_INVALID_COMMANDS = 3;
const MAX_TRACKED_INVALID_SENDERS = 1_024;
const MAX_MUTATIONS_PER_PROJECT = 32;
const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;

export type DesktopSecurityConfiguration = {
  contextIsolation: boolean;
  nodeIntegration: boolean;
  sandbox: boolean;
  webSecurity: boolean;
};

export type DesktopSenderContext = {
  frameUrl: string;
  generationId: string;
  isMainFrame: boolean;
  security: DesktopSecurityConfiguration;
  senderId: number;
};

export type ProjectAuthority = {
  commitEditTransaction(input: {
    expectedProjectRevisionId: string;
    projectId: string;
    transaction: EditTransaction;
  }): Promise<{ notFound: true } | { projectRevisionId: string } | { stale: true }>;
  getSnapshot(projectId: string): Promise<{
    eventSequence: number;
    project: ProjectContract;
    projectRevisionId: string;
  } | null>;
};

export type DesktopGatewayAction = "destroy_sender" | "none" | "reload_generation";

export type DesktopGatewayResult = {
  action: DesktopGatewayAction;
  response: DesktopResponse;
};

export class DesktopCommandGateway {
  readonly #authority: ProjectAuthority;
  readonly #invalidCounts = new Map<string, number>();
  readonly #mutationDepths = new Map<string, number>();
  readonly #mutationQueues = new Map<string, Promise<void>>();
  #activeReads = 0;

  constructor(authority: ProjectAuthority) {
    this.#authority = authority;
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
    this.#invalidCounts.delete(invalidCountKey(sender));

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
          security: sender.security,
          type: "shell.security_snapshot",
        }),
      };
    }

    if (command.type === "project.get_snapshot") return this.#readSnapshot(command);
    return this.#enqueueMutation(command);
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

  async #enqueueMutation(
    command: Extract<DesktopCommand, { type: "project.commit_edit_transaction" }>,
  ): Promise<DesktopGatewayResult> {
    const depth = this.#mutationDepths.get(command.projectId) ?? 0;
    if (depth >= MAX_MUTATIONS_PER_PROJECT) {
      return {
        action: "none",
        response: errorResponse("busy", "Project mutation queue is full", true, command),
      };
    }
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
      const remaining = (this.#mutationDepths.get(command.projectId) ?? 1) - 1;
      if (remaining === 0) this.#mutationDepths.delete(command.projectId);
      else this.#mutationDepths.set(command.projectId, remaining);
      if (this.#mutationQueues.get(command.projectId) === queueTail) {
        this.#mutationQueues.delete(command.projectId);
      }
    }
  }

  async #commitMutation(
    command: Extract<DesktopCommand, { type: "project.commit_edit_transaction" }>,
  ): Promise<DesktopGatewayResult> {
    try {
      const result = await this.#authority.commitEditTransaction({
        expectedProjectRevisionId: command.expectedProjectRevisionId,
        projectId: command.projectId,
        transaction: command.transaction,
      });
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
      return {
        action: "none",
        response: DesktopResponseSchema.parse({
          ...responseEnvelope(command),
          projectId: command.projectId,
          projectRevisionId: result.projectRevisionId,
          transactionId: command.transaction.id,
          type: "project.committed",
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

function isSecureRendererConfiguration(configuration: DesktopSecurityConfiguration): boolean {
  return (
    configuration.contextIsolation &&
    !configuration.nodeIntegration &&
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
    const generationId = DesktopMessageIdSchema.safeParse(Reflect.get(value, "generationId"));
    const requestId = DesktopMessageIdSchema.safeParse(Reflect.get(value, "requestId"));
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

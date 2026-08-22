import {
  CommitEditTransactionCommandSchema,
  CreateMediaProjectCommandSchema,
  DESKTOP_IPC_CHANNELS,
  DESKTOP_IPC_PROTOCOL,
  DESKTOP_IPC_VERSION,
  DesktopGenerationIdSchema,
  DesktopResponseSchema,
  OpenMediaPlaybackCommandSchema,
  PickLocalFileCommandSchema,
  ProjectEventSchema,
  ProjectListCommandSchema,
  ProjectSnapshotCommandSchema,
  RelinkMediaSourceCommandSchema,
  ShellSecuritySnapshotCommandSchema,
  type DesktopCommand,
  type DesktopErrorResponse,
  type DesktopResponse,
  type OpenChordsDesktopApi,
  type MediaPlaybackResponse,
  type MediaProjectCreatedResponse,
  type MediaRelinkResponse,
  type MediaSelectedResponse,
  type ProjectCommittedResponse,
  type ProjectListResponse,
  type ProjectSnapshotResponse,
  type ShellSecuritySnapshotResponse,
} from "@open-chords/contracts";
import { contextBridge, ipcRenderer } from "electron";

import { ProjectEventStream } from "./project-event-stream.ts";

const generationArgument = process.argv.find((argument) =>
  argument.startsWith("--open-chords-generation="),
);
const generationId = DesktopGenerationIdSchema.parse(generationArgument?.split("=", 2)[1]);

const envelope = () => ({
  generationId,
  protocol: DESKTOP_IPC_PROTOCOL,
  protocolVersion: DESKTOP_IPC_VERSION,
  requestId: `request_${crypto.randomUUID().replaceAll("-", "")}`,
});

async function invokeCapability<TExpected extends DesktopResponse>(
  channel: string,
  command: DesktopCommand,
  isExpected: (response: DesktopResponse) => response is TExpected,
  unexpectedResponseMessage: string,
): Promise<DesktopErrorResponse | TExpected> {
  const response = DesktopResponseSchema.parse(await ipcRenderer.invoke(channel, command));
  assertCorrelated(response, command);
  if (response.type === "desktop.error" || isExpected(response)) return response;
  throw new Error(unexpectedResponseMessage);
}

async function getSecuritySnapshot() {
  const command = ShellSecuritySnapshotCommandSchema.parse({
    ...envelope(),
    runtimeSecurity: {
      contextIsolation: process.contextIsolated,
      sandbox: process.sandboxed,
    },
    type: "shell.get_security_snapshot",
  });
  return invokeCapability(
    DESKTOP_IPC_CHANNELS.shellGetSecuritySnapshot,
    command,
    (response): response is ShellSecuritySnapshotResponse =>
      response.type === "shell.security_snapshot",
    "Unexpected shell capability response",
  );
}

async function getProjectSnapshot(projectId: string) {
  const command = ProjectSnapshotCommandSchema.parse({
    ...envelope(),
    projectId,
    type: "project.get_snapshot",
  });
  return invokeCapability(
    DESKTOP_IPC_CHANNELS.projectGetSnapshot,
    command,
    (response): response is ProjectSnapshotResponse => response.type === "project.snapshot",
    "Unexpected project snapshot response",
  );
}

async function listProjects() {
  const command = ProjectListCommandSchema.parse({
    ...envelope(),
    type: "project.list",
  });
  return invokeCapability(
    DESKTOP_IPC_CHANNELS.projectList,
    command,
    (response): response is ProjectListResponse => response.type === "project.list",
    "Unexpected Project list response",
  );
}

async function commitEditTransaction(
  input: Parameters<OpenChordsDesktopApi["project"]["commitEditTransaction"]>[0],
) {
  const command = CommitEditTransactionCommandSchema.parse({
    ...envelope(),
    ...input,
    type: "project.commit_edit_transaction",
  });
  return invokeCapability(
    DESKTOP_IPC_CHANNELS.projectCommitEditTransaction,
    command,
    (response): response is ProjectCommittedResponse => response.type === "project.committed",
    "Unexpected project mutation response",
  );
}

async function pickLocalFile() {
  const command = PickLocalFileCommandSchema.parse({
    ...envelope(),
    type: "media.pick_local_file",
  });
  return invokeCapability(
    DESKTOP_IPC_CHANNELS.mediaPickLocalFile,
    command,
    (
      response,
    ): response is
      | MediaSelectedResponse
      | Extract<DesktopResponse, { type: "media.selection_cancelled" }> =>
      response.type === "media.selected" || response.type === "media.selection_cancelled",
    "Unexpected local media picker response",
  );
}

async function createMediaProject(
  input: Parameters<OpenChordsDesktopApi["media"]["createProject"]>[0],
) {
  const command = CreateMediaProjectCommandSchema.parse({
    ...envelope(),
    ...input,
    type: "media.create_project",
  });
  return invokeCapability(
    DESKTOP_IPC_CHANNELS.mediaCreateProject,
    command,
    (response): response is MediaProjectCreatedResponse =>
      response.type === "media.project_created",
    "Unexpected local media Project response",
  );
}

async function relinkMediaSource(sourceId: string) {
  const command = RelinkMediaSourceCommandSchema.parse({
    ...envelope(),
    sourceId,
    type: "media.relink_source",
  });
  return invokeCapability(
    DESKTOP_IPC_CHANNELS.mediaRelinkSource,
    command,
    (response): response is MediaRelinkResponse =>
      response.type === "media.relinked" ||
      response.type === "media.different_source" ||
      response.type === "media.selection_cancelled",
    "Unexpected local media relink response",
  );
}

async function openMediaPlayback(projectId: string) {
  const command = OpenMediaPlaybackCommandSchema.parse({
    ...envelope(),
    projectId,
    type: "media.open_playback",
  });
  return invokeCapability(
    DESKTOP_IPC_CHANNELS.mediaOpenPlayback,
    command,
    (response): response is MediaPlaybackResponse =>
      response.type === "media.playback_ready" || response.type === "media.source_unavailable",
    "Unexpected local media playback response",
  );
}

const eventStream = new ProjectEventStream<ProjectSnapshotResponse>(async (projectId) => {
  const response = await getProjectSnapshot(projectId);
  if (response.type === "desktop.error") throw new Error("Project snapshot refresh failed");
  return response;
});
const listeners = new Set<Parameters<OpenChordsDesktopApi["project"]["subscribe"]>[0]>();

ipcRenderer.on(DESKTOP_IPC_CHANNELS.projectChanged, (_event, rawEvent: unknown) => {
  void dispatchProjectEvent(rawEvent).catch(reportDispatchError);
});

async function dispatchProjectEvent(rawEvent: unknown): Promise<void> {
  const event = ProjectEventSchema.parse(rawEvent);
  if (event.generationId !== generationId) throw new Error("Project event generation is stale");
  const update = await eventStream.accept(event);
  if (update.kind === "ignored") return;
  for (const listener of listeners) {
    try {
      listener(update);
    } catch (error) {
      reportDispatchError(error);
    }
  }
}

function reportDispatchError(error: unknown): void {
  queueMicrotask(() => {
    throw error;
  });
}

const api: OpenChordsDesktopApi = {
  media: {
    createProject: createMediaProject,
    openPlayback: openMediaPlayback,
    pickLocalFile,
    relinkSource: relinkMediaSource,
  },
  project: {
    commitEditTransaction,
    getSnapshot: async (projectId) => {
      const response = await getProjectSnapshot(projectId);
      if (response.type === "project.snapshot") {
        eventStream.synchronize(response.project.id, response.eventSequence);
      }
      return response;
    },
    list: listProjects,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  },
  shell: { getSecuritySnapshot },
};

contextBridge.exposeInMainWorld("openChords", api);

function assertCorrelated(response: DesktopResponse, command: DesktopCommand): void {
  if (response.generationId !== command.generationId || response.requestId !== command.requestId) {
    throw new Error("Desktop capability response is not correlated to its command");
  }
}

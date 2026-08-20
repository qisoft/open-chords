import {
  CommitEditTransactionCommandSchema,
  DESKTOP_IPC_CHANNELS,
  DESKTOP_IPC_PROTOCOL,
  DESKTOP_IPC_VERSION,
  DesktopMessageIdSchema,
  DesktopResponseSchema,
  ProjectEventSchema,
  ProjectSnapshotCommandSchema,
  ShellSecuritySnapshotCommandSchema,
  type OpenChordsDesktopApi,
  type DesktopCommand,
  type DesktopResponse,
  type ProjectSnapshotResponse,
} from "@open-chords/contracts";
import { contextBridge, ipcRenderer } from "electron";

import { ProjectEventStream } from "./project-event-stream.ts";

const generationArgument = process.argv.find((argument) =>
  argument.startsWith("--open-chords-generation="),
);
const generationId = DesktopMessageIdSchema.parse(generationArgument?.split("=", 2)[1]);

const envelope = () => ({
  generationId,
  protocol: DESKTOP_IPC_PROTOCOL,
  protocolVersion: DESKTOP_IPC_VERSION,
  requestId: `request_${crypto.randomUUID().replaceAll("-", "")}`,
});

async function getSecuritySnapshot() {
  const command = ShellSecuritySnapshotCommandSchema.parse({
    ...envelope(),
    type: "shell.get_security_snapshot",
  });
  const response = DesktopResponseSchema.parse(
    await ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.shellGetSecuritySnapshot, command),
  );
  assertCorrelated(response, command);
  if (response.type !== "shell.security_snapshot" && response.type !== "desktop.error") {
    throw new Error("Unexpected shell capability response");
  }
  return response;
}

async function getProjectSnapshot(projectId: string) {
  const command = ProjectSnapshotCommandSchema.parse({
    ...envelope(),
    projectId,
    type: "project.get_snapshot",
  });
  const response = DesktopResponseSchema.parse(
    await ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.projectGetSnapshot, command),
  );
  assertCorrelated(response, command);
  if (response.type !== "project.snapshot" && response.type !== "desktop.error") {
    throw new Error("Unexpected project snapshot response");
  }
  return response;
}

async function commitEditTransaction(
  input: Parameters<OpenChordsDesktopApi["project"]["commitEditTransaction"]>[0],
) {
  const command = CommitEditTransactionCommandSchema.parse({
    ...envelope(),
    ...input,
    type: "project.commit_edit_transaction",
  });
  const response = DesktopResponseSchema.parse(
    await ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.projectCommitEditTransaction, command),
  );
  assertCorrelated(response, command);
  if (response.type !== "project.committed" && response.type !== "desktop.error") {
    throw new Error("Unexpected project mutation response");
  }
  return response;
}

const eventStream = new ProjectEventStream<ProjectSnapshotResponse>(async (projectId) => {
  const response = await getProjectSnapshot(projectId);
  if (response.type === "desktop.error") throw new Error("Project snapshot refresh failed");
  return response;
});
const listeners = new Set<Parameters<OpenChordsDesktopApi["project"]["subscribe"]>[0]>();

ipcRenderer.on(DESKTOP_IPC_CHANNELS.projectChanged, (_event, rawEvent: unknown) => {
  void dispatchProjectEvent(rawEvent).catch(() => undefined);
});

async function dispatchProjectEvent(rawEvent: unknown): Promise<void> {
  const event = ProjectEventSchema.parse(rawEvent);
  if (event.generationId !== generationId) throw new Error("Project event generation is stale");
  const update = await eventStream.accept(event);
  if (update.kind === "ignored") return;
  for (const listener of listeners) listener(update);
}

const api: OpenChordsDesktopApi = {
  project: {
    commitEditTransaction,
    getSnapshot: async (projectId) => {
      const response = await getProjectSnapshot(projectId);
      if (response.type === "project.snapshot") {
        eventStream.synchronize(response.project.id, response.eventSequence);
      }
      return response;
    },
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

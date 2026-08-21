import {
  DESKTOP_IPC_CHANNELS,
  type DesktopCommand,
  type ProjectEvent,
  ProjectEventSchema,
} from "@open-chords/contracts";
import { ipcMain, type IpcMainInvokeEvent, type WebContents } from "electron";

import {
  DesktopCommandGateway,
  type DesktopGatewayAction,
  type DesktopSenderContext,
  type ProjectAuthority,
} from "./desktop-command-gateway.ts";

type CommandType = DesktopCommand["type"];

const commandChannels = [
  [DESKTOP_IPC_CHANNELS.shellGetSecuritySnapshot, "shell.get_security_snapshot"],
  [DESKTOP_IPC_CHANNELS.projectGetSnapshot, "project.get_snapshot"],
  [DESKTOP_IPC_CHANNELS.projectCommitEditTransaction, "project.commit_edit_transaction"],
] as const satisfies ReadonlyArray<readonly [string, CommandType]>;

export type DesktopIpcOptions = {
  onSenderAction(action: Exclude<DesktopGatewayAction, "none">, sender: WebContents): void;
  rendererContextFor(
    sender: WebContents,
  ): Pick<DesktopSenderContext, "generationId" | "security"> | null;
};

export function installDesktopIpc(authority: ProjectAuthority, options: DesktopIpcOptions): void {
  const gateway = new DesktopCommandGateway(authority);

  for (const [channel, expectedType] of commandChannels) {
    ipcMain.handle(channel, async (event, rawCommand: unknown) => {
      const sender = senderContext(event, options.rendererContextFor(event.sender));
      const result = await gateway.execute(rawCommand, sender, expectedType);
      if (result.action !== "none") options.onSenderAction(result.action, event.sender);
      return result.response;
    });
  }
}

export function publishProjectEvent(sender: WebContents, rawEvent: ProjectEvent): void {
  const event = ProjectEventSchema.parse(rawEvent);
  if (!sender.isDestroyed()) sender.send(DESKTOP_IPC_CHANNELS.projectChanged, event);
}

function senderContext(
  event: IpcMainInvokeEvent,
  rendererContext: Pick<DesktopSenderContext, "generationId" | "security"> | null,
) {
  const senderFrame = event.senderFrame;
  const isMainFrame = senderFrame !== null && senderFrame === event.sender.mainFrame;
  return {
    frameUrl: isMainFrame ? senderFrame.url : "",
    generationId: rendererContext?.generationId ?? "generation_missing",
    isMainFrame,
    security: rendererContext?.security ?? {
      contextIsolation: false,
      nodeIntegration: true,
      persistentSession: true,
      sandbox: false,
      webSecurity: false,
    },
    senderId: event.sender.id,
  };
}

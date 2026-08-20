import { EditTransactionSchema, ProjectContractSchema } from "@open-chords/domain";
import { z } from "zod";

export const DESKTOP_IPC_PROTOCOL = "open-chords/desktop-ipc";
export const DESKTOP_IPC_VERSION = "1.0";
export const DESKTOP_IPC_CHANNELS = {
  projectChanged: "open-chords:project:changed",
  projectCommitEditTransaction: "open-chords:project:commit-edit-transaction",
  projectGetSnapshot: "open-chords:project:get-snapshot",
  shellGetSecuritySnapshot: "open-chords:shell:get-security-snapshot",
} as const;

export const DesktopMessageIdSchema = z
  .string()
  .max(128)
  .regex(/^[a-z][a-z0-9]*_[a-z0-9][a-z0-9_-]*$/);

const commandEnvelope = {
  generationId: DesktopMessageIdSchema,
  protocol: z.literal(DESKTOP_IPC_PROTOCOL),
  protocolVersion: z.literal(DESKTOP_IPC_VERSION),
  requestId: DesktopMessageIdSchema,
};

export const ShellSecuritySnapshotCommandSchema = z.strictObject({
  ...commandEnvelope,
  runtimeSecurity: z.strictObject({
    contextIsolation: z.literal(true),
    sandbox: z.literal(true),
  }),
  type: z.literal("shell.get_security_snapshot"),
});

export const ProjectSnapshotCommandSchema = z.strictObject({
  ...commandEnvelope,
  projectId: DesktopMessageIdSchema,
  type: z.literal("project.get_snapshot"),
});

export const CommitEditTransactionCommandSchema = z.strictObject({
  ...commandEnvelope,
  expectedProjectRevisionId: DesktopMessageIdSchema,
  projectId: DesktopMessageIdSchema,
  transaction: EditTransactionSchema.extend({ id: DesktopMessageIdSchema }),
  type: z.literal("project.commit_edit_transaction"),
});

export const DesktopCommandSchema = z.discriminatedUnion("type", [
  CommitEditTransactionCommandSchema,
  ProjectSnapshotCommandSchema,
  ShellSecuritySnapshotCommandSchema,
]);

const responseEnvelope = {
  generationId: DesktopMessageIdSchema,
  protocol: z.literal(DESKTOP_IPC_PROTOCOL),
  protocolVersion: z.literal(DESKTOP_IPC_VERSION),
  requestId: DesktopMessageIdSchema,
};

export const DesktopErrorResponseSchema = z.strictObject({
  code: z.enum([
    "busy",
    "internal_error",
    "invalid_command",
    "invalid_generation",
    "project_not_found",
    "stale_revision",
    "unauthorized_sender",
  ]),
  generationId: DesktopMessageIdSchema.nullable(),
  message: z.string().min(1).max(256),
  protocol: z.literal(DESKTOP_IPC_PROTOCOL),
  protocolVersion: z.literal(DESKTOP_IPC_VERSION),
  requestId: DesktopMessageIdSchema.nullable(),
  retryable: z.boolean(),
  type: z.literal("desktop.error"),
});

export const DesktopResponseSchema = z.discriminatedUnion("type", [
  z.strictObject({
    ...responseEnvelope,
    security: z.strictObject({
      contextIsolation: z.literal(true),
      nodeIntegration: z.literal(false),
      sandbox: z.literal(true),
      webSecurity: z.literal(true),
    }),
    type: z.literal("shell.security_snapshot"),
  }),
  z.strictObject({
    ...responseEnvelope,
    eventSequence: z.number().int().nonnegative(),
    project: ProjectContractSchema,
    projectRevisionId: DesktopMessageIdSchema,
    type: z.literal("project.snapshot"),
  }),
  z.strictObject({
    ...responseEnvelope,
    projectId: DesktopMessageIdSchema,
    projectRevisionId: DesktopMessageIdSchema,
    transactionId: DesktopMessageIdSchema,
    type: z.literal("project.committed"),
  }),
  DesktopErrorResponseSchema,
]);

export const ProjectEventSchema = z.strictObject({
  generationId: DesktopMessageIdSchema,
  projectId: DesktopMessageIdSchema,
  projectRevisionId: DesktopMessageIdSchema,
  protocol: z.literal(DESKTOP_IPC_PROTOCOL),
  protocolVersion: z.literal(DESKTOP_IPC_VERSION),
  sequence: z.number().int().positive(),
  type: z.literal("project.changed"),
});

export type DesktopCommand = z.infer<typeof DesktopCommandSchema>;
export type DesktopResponse = z.infer<typeof DesktopResponseSchema>;
export type ProjectEvent = z.infer<typeof ProjectEventSchema>;
export type DesktopErrorResponse = Extract<DesktopResponse, { type: "desktop.error" }>;
export type ProjectSnapshotResponse = Extract<DesktopResponse, { type: "project.snapshot" }>;
export type ProjectCommittedResponse = Extract<DesktopResponse, { type: "project.committed" }>;
export type ShellSecuritySnapshotResponse = Extract<
  DesktopResponse,
  { type: "shell.security_snapshot" }
>;

export type OpenChordsDesktopApi = {
  project: {
    commitEditTransaction(input: {
      expectedProjectRevisionId: string;
      projectId: string;
      transaction: z.infer<typeof EditTransactionSchema>;
    }): Promise<DesktopErrorResponse | ProjectCommittedResponse>;
    getSnapshot(projectId: string): Promise<DesktopErrorResponse | ProjectSnapshotResponse>;
    subscribe(
      listener: (
        update:
          | { event: ProjectEvent; kind: "event" }
          | { kind: "snapshot"; snapshot: ProjectSnapshotResponse },
      ) => void,
    ): () => void;
  };
  shell: {
    getSecuritySnapshot(): Promise<DesktopErrorResponse | ShellSecuritySnapshotResponse>;
  };
};

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
export const DesktopGenerationIdSchema = DesktopMessageIdSchema.brand<"DesktopGenerationId">();
export const DesktopProjectIdSchema = DesktopMessageIdSchema.brand<"DesktopProjectId">();
export const DesktopProjectRevisionIdSchema =
  DesktopMessageIdSchema.brand<"DesktopProjectRevisionId">();
export const DesktopRequestIdSchema = DesktopMessageIdSchema.brand<"DesktopRequestId">();
export const DesktopTransactionIdSchema = DesktopMessageIdSchema.brand<"DesktopTransactionId">();

const protocolEnvelope = {
  protocol: z.literal(DESKTOP_IPC_PROTOCOL),
  protocolVersion: z.literal(DESKTOP_IPC_VERSION),
};

const generationEnvelope = {
  ...protocolEnvelope,
  generationId: DesktopGenerationIdSchema,
};

const correlatedEnvelope = {
  ...generationEnvelope,
  requestId: DesktopRequestIdSchema,
};

export const ShellSecuritySnapshotCommandSchema = z.strictObject({
  ...correlatedEnvelope,
  runtimeSecurity: z.strictObject({
    contextIsolation: z.literal(true),
    sandbox: z.literal(true),
  }),
  type: z.literal("shell.get_security_snapshot"),
});

export const ProjectSnapshotCommandSchema = z.strictObject({
  ...correlatedEnvelope,
  projectId: DesktopProjectIdSchema,
  type: z.literal("project.get_snapshot"),
});

export const CommitEditTransactionCommandSchema = z.strictObject({
  ...correlatedEnvelope,
  expectedProjectRevisionId: DesktopProjectRevisionIdSchema,
  projectId: DesktopProjectIdSchema,
  transaction: EditTransactionSchema.extend({ id: DesktopTransactionIdSchema }),
  type: z.literal("project.commit_edit_transaction"),
});

export const DesktopCommandSchema = z.discriminatedUnion("type", [
  CommitEditTransactionCommandSchema,
  ProjectSnapshotCommandSchema,
  ShellSecuritySnapshotCommandSchema,
]);

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
  generationId: DesktopGenerationIdSchema.nullable(),
  message: z.string().min(1).max(256),
  ...protocolEnvelope,
  requestId: DesktopRequestIdSchema.nullable(),
  retryable: z.boolean(),
  type: z.literal("desktop.error"),
});

export const DesktopResponseSchema = z.discriminatedUnion("type", [
  z.strictObject({
    ...correlatedEnvelope,
    security: z.strictObject({
      contextIsolation: z.literal(true),
      nodeIntegration: z.literal(false),
      persistentSession: z.literal(false),
      sandbox: z.literal(true),
      webSecurity: z.literal(true),
    }),
    type: z.literal("shell.security_snapshot"),
  }),
  z.strictObject({
    ...correlatedEnvelope,
    eventSequence: z.number().int().nonnegative(),
    project: ProjectContractSchema,
    projectRevisionId: DesktopProjectRevisionIdSchema,
    type: z.literal("project.snapshot"),
  }),
  z.strictObject({
    ...correlatedEnvelope,
    projectId: DesktopProjectIdSchema,
    projectRevisionId: DesktopProjectRevisionIdSchema,
    transactionId: DesktopTransactionIdSchema,
    type: z.literal("project.committed"),
  }),
  DesktopErrorResponseSchema,
]);

export const ProjectEventSchema = z.strictObject({
  ...generationEnvelope,
  projectId: DesktopProjectIdSchema,
  projectRevisionId: DesktopProjectRevisionIdSchema,
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

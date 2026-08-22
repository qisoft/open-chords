import { EditTransactionSchema, ProjectContractSchema } from "@open-chords/domain";
import { z } from "zod";

export const DESKTOP_IPC_PROTOCOL = "open-chords/desktop-ipc";
export const DESKTOP_IPC_VERSION = "1.0";
export const DESKTOP_IPC_CHANNELS = {
  projectChanged: "open-chords:project:changed",
  projectCommitEditTransaction: "open-chords:project:commit-edit-transaction",
  projectGetSnapshot: "open-chords:project:get-snapshot",
  mediaCreateProject: "open-chords:media:create-project",
  mediaOpenPlayback: "open-chords:media:open-playback",
  mediaPickLocalFile: "open-chords:media:pick-local-file",
  mediaRelinkSource: "open-chords:media:relink-source",
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
export const DesktopMediaCapabilityIdSchema = z
  .string()
  .regex(/^(?:media|playback)capability_[a-f0-9]{32}$/)
  .brand<"DesktopMediaCapabilityId">();

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

export const PickLocalFileCommandSchema = z.strictObject({
  ...correlatedEnvelope,
  type: z.literal("media.pick_local_file"),
});

export const CreateMediaProjectCommandSchema = z.strictObject({
  ...correlatedEnvelope,
  capabilityId: DesktopMediaCapabilityIdSchema,
  endSourceSample: z.number().int().positive(),
  startSourceSample: z.number().int().nonnegative(),
  type: z.literal("media.create_project"),
});

export const RelinkMediaSourceCommandSchema = z.strictObject({
  ...correlatedEnvelope,
  sourceId: DesktopMessageIdSchema,
  type: z.literal("media.relink_source"),
});

export const OpenMediaPlaybackCommandSchema = z.strictObject({
  ...correlatedEnvelope,
  projectId: DesktopProjectIdSchema,
  type: z.literal("media.open_playback"),
});

export const DesktopCommandSchema = z.discriminatedUnion("type", [
  CommitEditTransactionCommandSchema,
  CreateMediaProjectCommandSchema,
  OpenMediaPlaybackCommandSchema,
  PickLocalFileCommandSchema,
  ProjectSnapshotCommandSchema,
  RelinkMediaSourceCommandSchema,
  ShellSecuritySnapshotCommandSchema,
]);

export const DesktopErrorResponseSchema = z.strictObject({
  code: z.enum([
    "busy",
    "capability_unavailable",
    "internal_error",
    "invalid_media",
    "invalid_command",
    "invalid_generation",
    "project_not_found",
    "project_read_only",
    "source_unavailable",
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
  z.strictObject({
    ...correlatedEnvelope,
    operation: z.enum(["pick", "relink"]),
    type: z.literal("media.selection_cancelled"),
  }),
  z.strictObject({
    ...correlatedEnvelope,
    byteSize: z.number().int().positive(),
    capabilityId: DesktopMediaCapabilityIdSchema,
    durationSamples: z.number().int().positive(),
    mimeType: z.string().min(1).max(128),
    sampleRate: z.number().int().positive().max(384_000),
    type: z.literal("media.selected"),
  }),
  z.strictObject({
    ...correlatedEnvelope,
    projectId: DesktopProjectIdSchema,
    projectRevisionId: DesktopProjectRevisionIdSchema,
    sourceId: DesktopMessageIdSchema,
    type: z.literal("media.project_created"),
  }),
  z.strictObject({
    ...correlatedEnvelope,
    sourceId: DesktopMessageIdSchema,
    type: z.literal("media.relinked"),
  }),
  z.strictObject({
    ...correlatedEnvelope,
    byteSize: z.number().int().positive(),
    capabilityId: DesktopMediaCapabilityIdSchema,
    durationSamples: z.number().int().positive(),
    mimeType: z.string().min(1).max(128),
    sampleRate: z.number().int().positive().max(384_000),
    type: z.literal("media.different_source"),
  }),
  z.strictObject({
    ...correlatedEnvelope,
    byteSize: z.number().int().positive(),
    capabilityId: DesktopMediaCapabilityIdSchema,
    endSourceSample: z.number().int().positive(),
    mimeType: z.string().min(1).max(128),
    playbackUrl: z.string().regex(/^open-chords:\/\/app\/media\/playbackcapability_[a-f0-9]{32}$/),
    projectId: DesktopProjectIdSchema,
    sampleRate: z.number().int().positive().max(384_000),
    startSourceSample: z.number().int().nonnegative(),
    type: z.literal("media.playback_ready"),
  }),
  z.strictObject({
    ...correlatedEnvelope,
    projectId: DesktopProjectIdSchema,
    sourceId: DesktopMessageIdSchema,
    type: z.literal("media.source_unavailable"),
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
export type MediaSelectedResponse = Extract<DesktopResponse, { type: "media.selected" }>;
export type MediaProjectCreatedResponse = Extract<
  DesktopResponse,
  { type: "media.project_created" }
>;
export type MediaRelinkResponse = Extract<
  DesktopResponse,
  { type: "media.different_source" | "media.relinked" | "media.selection_cancelled" }
>;
export type MediaPlaybackResponse = Extract<
  DesktopResponse,
  { type: "media.playback_ready" | "media.source_unavailable" }
>;

export type OpenChordsDesktopApi = {
  media: {
    createProject(input: {
      capabilityId: string;
      endSourceSample: number;
      startSourceSample: number;
    }): Promise<DesktopErrorResponse | MediaProjectCreatedResponse>;
    openPlayback(projectId: string): Promise<DesktopErrorResponse | MediaPlaybackResponse>;
    pickLocalFile(): Promise<
      | DesktopErrorResponse
      | MediaSelectedResponse
      | Extract<DesktopResponse, { type: "media.selection_cancelled" }>
    >;
    relinkSource(sourceId: string): Promise<DesktopErrorResponse | MediaRelinkResponse>;
  };
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

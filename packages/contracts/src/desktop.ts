import {
  LyricsInputSchema,
  PracticeActionSchema,
  EditHistoryActionSchema,
  EditTransactionSchema,
  ProjectContractSchema,
} from "@open-chords/domain";
import { z } from "zod";

import { AlignmentActionSchema, AlignmentJobSummarySchema } from "./alignment.ts";
import { ExportActionSchema, ExportReceiptSummarySchema } from "./exports.ts";
import { DesktopMessageIdSchema } from "./identifiers.ts";
import {
  YouTubeActionSchema,
  YouTubePlayerStateSchema,
  YouTubeSourceSummarySchema,
} from "./youtube.ts";
export { DesktopMessageIdSchema } from "./identifiers.ts";
import { LyricsCandidateSchema, LyricsSearchSchema } from "./lyrics.ts";
import {
  ModelActionSchema,
  ModelPackInfoSchema,
  ModelRemovalImpactSchema,
  ModelRuntimeInfoSchema,
} from "./models.ts";

export const DESKTOP_IPC_PROTOCOL = "open-chords/desktop-ipc";
export const DESKTOP_IPC_VERSION = "1.0";
export const DESKTOP_IPC_CHANNELS = {
  youtubePerform: "open-chords:youtube:perform",
  exportsPerform: "open-chords:exports:perform",
  alignmentPerform: "open-chords:alignment:perform",
  modelsPerform: "open-chords:models:perform",
  lyricsPerform: "open-chords:lyrics:perform",
  projectAddLyrics: "open-chords:project:add-lyrics",
  projectChangePractice: "open-chords:project:change-practice",
  projectChangeEditHistory: "open-chords:project:change-edit-history",
  projectChanged: "open-chords:project:changed",
  projectCommitEditTransaction: "open-chords:project:commit-edit-transaction",
  projectGetSnapshot: "open-chords:project:get-snapshot",
  projectList: "open-chords:project:list",
  mediaCreateProject: "open-chords:media:create-project",
  mediaOpenPlayback: "open-chords:media:open-playback",
  mediaPickLocalFile: "open-chords:media:pick-local-file",
  mediaRelinkSource: "open-chords:media:relink-source",
  shellGetSecuritySnapshot: "open-chords:shell:get-security-snapshot",
} as const;

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

export const ProjectListCommandSchema = z.strictObject({
  ...correlatedEnvelope,
  type: z.literal("project.list"),
});

export const CommitEditTransactionCommandSchema = z.strictObject({
  ...correlatedEnvelope,
  expectedProjectRevisionId: DesktopProjectRevisionIdSchema,
  projectId: DesktopProjectIdSchema,
  transaction: EditTransactionSchema.extend({ id: DesktopTransactionIdSchema }),
  type: z.literal("project.commit_edit_transaction"),
});

export const ChangeEditHistoryCommandSchema = z.strictObject({
  ...correlatedEnvelope,
  expectedProjectRevisionId: DesktopProjectRevisionIdSchema,
  projectId: DesktopProjectIdSchema,
  action: EditHistoryActionSchema,
  type: z.literal("project.change_edit_history"),
});

export const ChangePracticeCommandSchema = z.strictObject({
  ...correlatedEnvelope,
  expectedProjectRevisionId: DesktopProjectRevisionIdSchema,
  projectId: DesktopProjectIdSchema,
  action: PracticeActionSchema,
  type: z.literal("project.change_practice"),
});

export const AddLyricsCommandSchema = z.strictObject({
  ...correlatedEnvelope,
  expectedProjectRevisionId: DesktopProjectRevisionIdSchema,
  projectId: DesktopProjectIdSchema,
  input: LyricsInputSchema,
  type: z.literal("project.add_lyrics"),
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

export const LyricsActionSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("status") }),
  z.strictObject({ type: z.literal("cancel") }),
  z.strictObject({ type: z.literal("set_offline"), offline: z.boolean() }),
  LyricsSearchSchema.extend({ type: z.literal("search"), projectId: DesktopProjectIdSchema }),
  z.strictObject({
    type: z.literal("select"),
    projectId: DesktopProjectIdSchema,
    expectedProjectRevisionId: DesktopProjectRevisionIdSchema,
    candidateId: z.string().regex(/^candidate_[a-f0-9]{32}$/),
    language: z
      .string()
      .regex(/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/)
      .max(35),
  }),
  z.strictObject({ type: z.literal("open_genius"), query: z.string().trim().min(1).max(200) }),
]);
export const LyricsCommandSchema = z.strictObject({
  ...correlatedEnvelope,
  type: z.literal("lyrics.perform"),
  action: LyricsActionSchema,
});

export const ModelsCommandSchema = z.strictObject({
  ...correlatedEnvelope,
  type: z.literal("models.perform"),
  action: ModelActionSchema,
});
export const AlignmentCommandSchema = z.strictObject({
  ...correlatedEnvelope,
  type: z.literal("alignment.perform"),
  action: AlignmentActionSchema,
});

export const DesktopCommandSchema = z.discriminatedUnion("type", [
  z.strictObject({
    ...correlatedEnvelope,
    type: z.literal("exports.perform"),
    action: ExportActionSchema,
  }),
  z.strictObject({
    ...correlatedEnvelope,
    type: z.literal("youtube.perform"),
    action: YouTubeActionSchema,
  }),
  AlignmentCommandSchema,
  ModelsCommandSchema,
  LyricsCommandSchema,
  CommitEditTransactionCommandSchema,
  ChangeEditHistoryCommandSchema,
  ChangePracticeCommandSchema,
  AddLyricsCommandSchema,
  CreateMediaProjectCommandSchema,
  OpenMediaPlaybackCommandSchema,
  PickLocalFileCommandSchema,
  ProjectListCommandSchema,
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

const mediaSelectionEnvelope = {
  ...correlatedEnvelope,
  byteSize: z.number().int().positive(),
  capabilityId: DesktopMediaCapabilityIdSchema,
  durationSamples: z.number().int().positive(),
  mimeType: z.string().min(1).max(128),
  sampleRate: z.number().int().positive().max(384_000),
};

export const DesktopResponseSchema = z.discriminatedUnion("type", [
  z.strictObject({
    ...correlatedEnvelope,
    type: z.literal("exports.result"),
    projectId: DesktopProjectIdSchema,
    state: z.enum(["idle", "saved", "cancelled", "cancelling", "receipt_pending"]),
    busy: z.boolean(),
    pendingRecovery: z.number().int().nonnegative(),
    receipts: z.array(ExportReceiptSummarySchema).max(100),
  }),
  z.strictObject({
    ...correlatedEnvelope,
    type: z.literal("youtube.result"),
    offline: z.boolean(),
    sources: z.array(YouTubeSourceSummarySchema).max(100),
    player: YouTubePlayerStateSchema.nullable(),
  }),
  z.strictObject({
    ...correlatedEnvelope,
    type: z.literal("alignment.result"),
    projectId: DesktopProjectIdSchema,
    jobs: z.array(AlignmentJobSummarySchema).max(100),
  }),
  z.strictObject({
    ...correlatedEnvelope,
    type: z.literal("models.result"),
    offline: z.boolean(),
    packs: z.array(ModelPackInfoSchema).max(2),
    runtime: ModelRuntimeInfoSchema,
    removal: ModelRemovalImpactSchema.optional(),
  }),
  z.strictObject({
    ...correlatedEnvelope,
    type: z.literal("lyrics.result"),
    offline: z.boolean(),
    candidates: z.array(LyricsCandidateSchema).max(20).optional(),
    projectRevisionId: DesktopProjectRevisionIdSchema.optional(),
  }),
  z.strictObject({
    ...correlatedEnvelope,
    projectId: DesktopProjectIdSchema,
    projectRevisionId: DesktopProjectRevisionIdSchema,
    type: z.literal("project.lyrics_added"),
  }),
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
    projects: z
      .array(
        z.strictObject({
          compatibility: z.enum(["read_only", "writable"]),
          projectId: DesktopProjectIdSchema,
          projectRevisionId: DesktopProjectRevisionIdSchema,
        }),
      )
      .max(10_000),
    type: z.literal("project.list"),
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
    projectId: DesktopProjectIdSchema,
    projectRevisionId: DesktopProjectRevisionIdSchema,
    type: z.literal("project.history_changed"),
  }),
  z.strictObject({
    ...correlatedEnvelope,
    projectId: DesktopProjectIdSchema,
    projectRevisionId: DesktopProjectRevisionIdSchema,
    type: z.literal("project.practice_changed"),
  }),
  z.strictObject({
    ...correlatedEnvelope,
    conflicts: z.array(z.strictObject({ sourceId: z.string(), message: z.string() })),
    type: z.literal("project.edit_conflicts"),
  }),
  z.strictObject({
    ...correlatedEnvelope,
    operation: z.enum(["pick", "relink"]),
    type: z.literal("media.selection_cancelled"),
  }),
  z.strictObject({
    ...mediaSelectionEnvelope,
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
    ...mediaSelectionEnvelope,
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
export type ProjectListResponse = Extract<DesktopResponse, { type: "project.list" }>;
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
  exports: {
    perform(
      action: z.infer<typeof ExportActionSchema>,
    ): Promise<DesktopErrorResponse | Extract<DesktopResponse, { type: "exports.result" }>>;
  };
  youtube: {
    perform(
      action: z.infer<typeof YouTubeActionSchema>,
    ): Promise<DesktopErrorResponse | Extract<DesktopResponse, { type: "youtube.result" }>>;
  };
  alignment: {
    perform(
      action: z.infer<typeof AlignmentActionSchema>,
    ): Promise<DesktopErrorResponse | Extract<DesktopResponse, { type: "alignment.result" }>>;
  };
  models: {
    perform(
      action: z.infer<typeof ModelActionSchema>,
    ): Promise<DesktopErrorResponse | Extract<DesktopResponse, { type: "models.result" }>>;
  };
  lyrics: {
    perform(
      action: z.input<typeof LyricsActionSchema>,
    ): Promise<DesktopErrorResponse | Extract<DesktopResponse, { type: "lyrics.result" }>>;
  };
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
    addLyrics(input: {
      expectedProjectRevisionId: string;
      projectId: string;
      input: z.infer<typeof LyricsInputSchema>;
    }): Promise<DesktopErrorResponse | Extract<DesktopResponse, { type: "project.lyrics_added" }>>;
    changePractice(input: {
      expectedProjectRevisionId: string;
      projectId: string;
      action: z.infer<typeof PracticeActionSchema>;
    }): Promise<
      DesktopErrorResponse | Extract<DesktopResponse, { type: "project.practice_changed" }>
    >;
    changeEditHistory(input: {
      expectedProjectRevisionId: string;
      projectId: string;
      action: z.infer<typeof EditHistoryActionSchema>;
    }): Promise<
      | DesktopErrorResponse
      | Extract<DesktopResponse, { type: "project.history_changed" | "project.edit_conflicts" }>
    >;
    commitEditTransaction(input: {
      expectedProjectRevisionId: string;
      projectId: string;
      transaction: z.infer<typeof EditTransactionSchema>;
    }): Promise<DesktopErrorResponse | ProjectCommittedResponse>;
    getSnapshot(projectId: string): Promise<DesktopErrorResponse | ProjectSnapshotResponse>;
    list(): Promise<DesktopErrorResponse | ProjectListResponse>;
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

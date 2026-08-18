import {
  parseProjectContract,
  ProjectContractSchema,
  type ProjectContract,
} from "@open-chords/domain";
import { z } from "zod";

export const CONTRACT_MAJOR = 1;
export const CONTRACT_MINOR = 0;
export const CONTRACT_VERSION = `${String(CONTRACT_MAJOR)}.${String(CONTRACT_MINOR)}`;

export const ProjectEnvelopeSchema = z
  .strictObject({
    extensions: z.record(z.string().regex(/^[a-z0-9]+(?:\.[a-z0-9-]+)+$/), z.unknown()),
    payload: ProjectContractSchema,
    protocol: z.literal("open-chords/contracts"),
    schemaVersion: z.string().regex(/^\d+\.\d+$/),
    type: z.literal("project_snapshot"),
  })
  .meta({ id: "ProjectEnvelope" });

export type ContractCompatibility = "writable" | "read_only";
export type ParsedProjectEnvelope = {
  compatibility: ContractCompatibility;
  envelope: z.infer<typeof ProjectEnvelopeSchema>;
  project: ProjectContract;
};

export function parseContractEnvelope(input: unknown): ParsedProjectEnvelope {
  const envelope = ProjectEnvelopeSchema.parse(input);
  const [major, minor] = envelope.schemaVersion.split(".").map(Number);
  if (major !== CONTRACT_MAJOR)
    throw new Error(`Unsupported contract major version ${String(major)}`);
  const project = parseProjectContract(envelope.payload);
  const [, projectMinor] = project.schemaVersion.split(".").map(Number);
  return {
    compatibility:
      (minor ?? 0) > CONTRACT_MINOR || (projectMinor ?? 0) > CONTRACT_MINOR
        ? "read_only"
        : "writable",
    envelope,
    project,
  };
}

export function generateContractJsonSchema(): z.core.JSONSchema.BaseSchema {
  const schema = z.toJSONSchema(ProjectEnvelopeSchema, {
    reused: "inline",
    target: "draft-2020-12",
  });
  return {
    ...schema,
    $id: `https://openchords.dev/contracts/v${CONTRACT_MAJOR}/project-envelope.schema.json`,
    title: `Open Chords project contract envelope v${CONTRACT_VERSION}`,
  };
}

import {
  DesktopCommandSchema,
  DesktopResponseSchema,
  ProjectEventSchema,
} from "@open-chords/contracts";
import { describe, expect, it } from "vitest";

describe("desktop IPC contracts", () => {
  it("accepts only the named shell security capability with a strict versioned envelope", () => {
    const command = {
      generationId: "generation_fixture",
      protocol: "open-chords/desktop-ipc",
      protocolVersion: "1.0",
      requestId: "request_security_snapshot",
      runtimeSecurity: {
        contextIsolation: true,
        sandbox: true,
      },
      type: "shell.get_security_snapshot",
    };

    expect(DesktopCommandSchema.parse(command)).toEqual(command);
    expect(() =>
      DesktopCommandSchema.parse({
        ...command,
        runtimeSecurity: { ...command.runtimeSecurity, sandbox: false },
      }),
    ).toThrow(/Invalid input/);
    expect(() => DesktopCommandSchema.parse({ ...command, channel: "generic.invoke" })).toThrow(
      /unrecognized|unknown/i,
    );
  });

  it("defines strict named Project read, mutation, response, event, and bounded-error envelopes", () => {
    const base = {
      generationId: "generation_fixture",
      protocol: "open-chords/desktop-ipc",
      protocolVersion: "1.0",
      requestId: "request_project",
    } as const;
    const snapshot = {
      ...base,
      projectId: "project_fixture",
      type: "project.get_snapshot",
    };
    const mutation = {
      ...base,
      expectedProjectRevisionId: "projectrevision_current",
      projectId: "project_fixture",
      transaction: {
        id: "transaction_fixture",
        operations: [
          {
            eventId: "chord_fixture",
            type: "replace_chord_value",
            value: { kind: "no_chord" },
          },
        ],
        parentTransactionId: null,
      },
      type: "project.commit_edit_transaction",
    };

    expect(DesktopCommandSchema.parse(snapshot)).toEqual(snapshot);
    expect(DesktopCommandSchema.parse(mutation)).toEqual(mutation);
    expect(() =>
      DesktopCommandSchema.parse({
        ...mutation,
        transaction: { ...mutation.transaction, id: `transaction_${"a".repeat(117)}` },
      }),
    ).toThrow(/too big|maximum|<=128/i);
    expect(
      ProjectEventSchema.parse({
        generationId: "generation_fixture",
        projectId: "project_fixture",
        projectRevisionId: "projectrevision_next",
        protocol: "open-chords/desktop-ipc",
        protocolVersion: "1.0",
        sequence: 2,
        type: "project.changed",
      }),
    ).toMatchObject({ sequence: 2, type: "project.changed" });
    expect(
      DesktopResponseSchema.parse({
        code: "stale_revision",
        generationId: "generation_fixture",
        message: "Project changed before this transaction could commit",
        protocol: "open-chords/desktop-ipc",
        protocolVersion: "1.0",
        requestId: "request_project",
        retryable: true,
        type: "desktop.error",
      }),
    ).toMatchObject({ code: "stale_revision", type: "desktop.error" });
    expect(() =>
      DesktopResponseSchema.parse({
        code: "invalid_command",
        generationId: null,
        message: "x".repeat(257),
        protocol: "open-chords/desktop-ipc",
        protocolVersion: "1.0",
        requestId: null,
        retryable: false,
        type: "desktop.error",
      }),
    ).toThrow(/too big|maximum|<=256/i);
  });

  it("defines only opaque local-media capabilities and never accepts a renderer path", () => {
    const base = {
      generationId: "generation_fixture",
      protocol: "open-chords/desktop-ipc",
      protocolVersion: "1.0",
      requestId: "request_media",
    } as const;
    const pick = { ...base, type: "media.pick_local_file" } as const;
    const create = {
      ...base,
      capabilityId: "mediacapability_11111111111141118111111111111111",
      endSourceSample: 48_000,
      startSourceSample: 0,
      type: "media.create_project",
    } as const;

    expect(DesktopCommandSchema.parse(pick)).toEqual(pick);
    expect(DesktopCommandSchema.parse(create)).toEqual(create);
    expect(() => DesktopCommandSchema.parse({ ...pick, path: "/private/recording.wav" })).toThrow(
      /unrecognized|unknown/i,
    );
    expect(() => DesktopCommandSchema.parse({ ...pick, directory: true })).toThrow(
      /unrecognized|unknown/i,
    );
    expect(
      DesktopResponseSchema.parse({
        ...base,
        byteSize: 1_024,
        capabilityId: create.capabilityId,
        durationSamples: 48_000,
        mimeType: "audio/wav",
        sampleRate: 48_000,
        type: "media.selected",
      }),
    ).toMatchObject({ type: "media.selected" });
    expect(() =>
      DesktopResponseSchema.parse({
        ...base,
        byteSize: 1_024,
        capabilityId: create.capabilityId,
        durationSamples: 48_000,
        mimeType: "audio/wav",
        path: "/private/recording.wav",
        sampleRate: 48_000,
        type: "media.selected",
      }),
    ).toThrow(/unrecognized|unknown/i);
  });
});

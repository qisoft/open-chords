import { readFileSync } from "node:fs";
import { mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";

import { ProjectEnvelopeSchema } from "@open-chords/contracts";
import { afterEach, expect, it } from "vitest";

import { openOfflineMediaCache } from "../apps/desktop/src/main/offline-media-cache.ts";
import {
  archivedProjectFor,
  type ArchivedProject,
} from "../apps/desktop/src/main/project-archive-format.ts";
import { ProjectArchiveImports } from "../apps/desktop/src/main/project-archive-imports.ts";
import { openProjectLibrary } from "../apps/desktop/src/main/project-library.ts";
import { rawZip, signedArchiveEntries, type RawZipEntry } from "./support/archive-zip.ts";
import { goldenRecords } from "./support/editor-fixture.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const document = (): ArchivedProject =>
  archivedProjectFor({
    envelope: ProjectEnvelopeSchema.parse(
      JSON.parse(readFileSync("packages/testkit/contracts/v1/valid/project-envelope.json", "utf8")),
    ),
    records: goldenRecords(),
  }).document;
const valid = () => signedArchiveEntries(document());
const withDocument = (change: (value: ArchivedProject) => void) => {
  const value = document();
  change(value);
  return rawZip(signedArchiveEntries(value));
};
const replaceEntry = (entries: RawZipEntry[], name: string, change: Partial<RawZipEntry>) =>
  entries.map((entry) => (entry.name === name ? { ...entry, ...change } : entry));

const hostileArchives: Array<[string, () => Buffer, string]> = [
  [
    "parent traversal",
    () => rawZip([...valid(), { name: "../escape.json", data: Buffer.from("{}") }]),
    "unsafe_path",
  ],
  [
    "nested traversal",
    () => rawZip([...valid(), { name: "media/../../escape", data: Buffer.from("x") }]),
    "unsafe_path",
  ],
  [
    "absolute POSIX path",
    () => rawZip([...valid(), { name: "/etc/passwd", data: Buffer.from("x") }]),
    "unsafe_path",
  ],
  [
    "Windows drive path",
    () => rawZip([...valid(), { name: "C:/Windows/x", data: Buffer.from("x") }]),
    "unsafe_path",
  ],
  [
    "backslash separator",
    () => rawZip([...valid(), { name: "media\\..\\x", data: Buffer.from("x") }]),
    "unsafe_path",
  ],
  [
    "control character",
    () => rawZip([...valid(), { name: "media/\u0007bell", data: Buffer.from("x") }]),
    "unsafe_path",
  ],
  [
    "bidirectional override",
    () => rawZip([...valid(), { name: "media/\u202egpj.exe", data: Buffer.from("x") }]),
    "unsafe_path",
  ],
  [
    "invalid UTF-8 name",
    () => rawZip([...valid(), { name: Buffer.from([0x6d, 0xff, 0x2e]), data: Buffer.from("x") }]),
    "unsafe_path",
  ],
  [
    "directory entry",
    () => rawZip([...valid(), { name: "media/", data: Buffer.alloc(0), method: 0 }]),
    "unsafe_path",
  ],
  [
    "symbolic link",
    () =>
      rawZip([
        ...valid(),
        {
          name: "media/link",
          data: Buffer.from("/etc/passwd"),
          externalAttributes: 0o120777 * 0x10000,
        },
      ]),
    "link_entry",
  ],
  [
    "Windows reparse point",
    () =>
      rawZip([
        ...valid(),
        { name: "media/junction", data: Buffer.from("x"), externalAttributes: 0x0400 },
      ]),
    "link_entry",
  ],
  [
    "device node",
    () =>
      rawZip([
        ...valid(),
        {
          name: "media/device",
          data: Buffer.alloc(0),
          method: 0,
          externalAttributes: 0o020644 * 0x10000,
        },
      ]),
    "link_entry",
  ],
  [
    "case collision",
    () => rawZip([...valid(), { name: "PROJECT.json", data: Buffer.from("{}") }]),
    "name_collision",
  ],
  [
    "Unicode normalization collision",
    () =>
      rawZip([
        ...valid(),
        { name: "media/caf\u00e9", data: Buffer.from("a") },
        { name: "media/cafe\u0301", data: Buffer.from("b") },
      ]),
    "name_collision",
  ],
  [
    "compatibility normalization collision",
    () =>
      rawZip([
        ...valid(),
        { name: "media/\ufb01le", data: Buffer.from("a") },
        { name: "media/file", data: Buffer.from("b") },
      ]),
    "name_collision",
  ],
  ["exact duplicate name", () => rawZip([...valid(), valid()[1]!]), "name_collision"],
  [
    "undeclared file",
    () => rawZip([...valid(), { name: "notes.txt", data: Buffer.from("hello") }]),
    "undeclared_entry",
  ],
  [
    "undeclared media",
    () => rawZip([...valid(), { name: "media/project-range.pcm", data: Buffer.alloc(4) }]),
    "undeclared_entry",
  ],
  ["missing project entry", () => rawZip(valid().slice(0, 1)), "missing_entry"],
  ["missing manifest", () => rawZip(valid().slice(1)), "missing_entry"],
  [
    "executable content",
    () => rawZip([...valid(), { name: "tools/run.exe", data: Buffer.from("MZ") }]),
    "active_content",
  ],
  [
    "script content",
    () => rawZip([...valid(), { name: "index.html", data: Buffer.from("<script>") }]),
    "active_content",
  ],
  [
    "shell script",
    () => rawZip([...valid(), { name: "media/install.sh", data: Buffer.from("#!/bin/sh") }]),
    "active_content",
  ],
  [
    "traditional encryption",
    () => rawZip(replaceEntry(valid(), "project.json", { flags: 0x0801 })),
    "encrypted_entry",
  ],
  [
    "strong encryption",
    () => rawZip(replaceEntry(valid(), "project.json", { flags: 0x0841 })),
    "encrypted_entry",
  ],
  [
    "AES encryption method",
    () => rawZip(replaceEntry(valid(), "project.json", { method: 99 })),
    "encrypted_entry",
  ],
  [
    "compression bomb ratio",
    () => rawZip([...valid(), { name: "media/bomb", data: Buffer.alloc(64 * 1024 * 1024) }]),
    "compression_ratio",
  ],
  [
    "declared size beyond entry budget",
    () => rawZip(replaceEntry(valid(), "project.json", { declaredSize: 200 * 1024 * 1024 })),
    "size_limit",
  ],
  [
    "inflation beyond declared size",
    () => rawZip(replaceEntry(valid(), "manifest.json", { declaredSize: 10 })),
    "size_limit",
  ],
  [
    "entry size contradicting its manifest",
    () => rawZip(replaceEntry(valid(), "project.json", { declaredSize: 10 })),
    "declaration_mismatch",
  ],
  [
    "archive beyond the total budget",
    () => Buffer.concat([rawZip(valid()), Buffer.alloc(161 * 1024 * 1024)]),
    "size_limit",
  ],
  [
    "unsupported compression",
    () => rawZip(replaceEntry(valid(), "project.json", { method: 12 })),
    "unsupported_zip_feature",
  ],
  [
    "data descriptor",
    () => rawZip(replaceEntry(valid(), "project.json", { flags: 0x0808 })),
    "unsupported_zip_feature",
  ],
  [
    "extra field",
    () =>
      rawZip(replaceEntry(valid(), "project.json", { extra: Buffer.from([0x75, 0x70, 1, 0, 0]) })),
    "unsupported_zip_feature",
  ],
  ["ZIP64 locator", () => rawZip(valid(), { zip64Locator: true }), "unsupported_zip_feature"],
  [
    "prefixed polyglot",
    () => rawZip(valid(), { prefix: Buffer.from("#!/bin/sh\n") }),
    "malformed_zip",
  ],
  ["trailing data", () => rawZip(valid(), { suffix: Buffer.from("tail") }), "malformed_zip"],
  ["not a ZIP", () => Buffer.from("not an archive at all"), "malformed_zip"],
  [
    "corrupt deflate stream",
    () =>
      rawZip(
        replaceEntry(valid(), "project.json", {
          method: 0,
          data: deflateRawSync(Buffer.from("{}")),
          declaredSize: 9999,
        }),
      ),
    "malformed_zip",
  ],
  [
    "tampered project hash",
    () => {
      const entries = valid();
      const project = Buffer.from(entries[1]!.data.toString("utf8").replace("go go", "no no"));
      return rawZip(replaceEntry(entries, "project.json", { data: project }));
    },
    "hash_mismatch",
  ],
  [
    "tampered project size",
    () =>
      rawZip(
        signedArchiveEntries(document(), {
          manifest: (manifest) => ({
            ...manifest,
            project: Object.assign({}, manifest.project, { byteSize: 12 }),
          }),
        }),
      ),
    "declaration_mismatch",
  ],
  [
    "undeclared model requirement",
    () =>
      rawZip(
        signedArchiveEntries(document(), {
          requirements: [
            {
              id: "model",
              kind: "model_artifact",
              sha256: `sha256:${"4".repeat(64)}`,
              version: "1",
            },
          ],
        }),
      ),
    "declaration_mismatch",
  ],
  [
    "unknown manifest format",
    () =>
      rawZip(
        signedArchiveEntries(document(), {
          manifest: (manifest) => ({ ...manifest, format: "zip" }),
        }),
      ),
    "schema_invalid",
  ],
  [
    "newer archive format",
    () =>
      rawZip(
        signedArchiveEntries(document(), {
          manifest: (manifest) => ({ ...manifest, formatVersion: "2.0" }),
        }),
      ),
    "unsupported_version",
  ],
  [
    "unknown manifest field",
    () =>
      rawZip(
        signedArchiveEntries(document(), {
          manifest: (manifest) => ({ ...manifest, autorun: "open.sh" }),
        }),
      ),
    "schema_invalid",
  ],
  [
    "non-canonical JSON",
    () => {
      const entries = valid();
      const manifest = Buffer.from(JSON.stringify(JSON.parse(entries[0]!.data.toString("utf8"))));
      return rawZip(replaceEntry(entries, "manifest.json", { data: manifest }));
    },
    "schema_invalid",
  ],
  [
    "duplicate JSON keys",
    () => {
      const entries = valid();
      const manifest = Buffer.from(
        entries[0]!.data.toString("utf8").replace('"format":', '"format": "x",\n  "format":'),
      );
      return rawZip(replaceEntry(entries, "manifest.json", { data: manifest }));
    },
    "schema_invalid",
  ],
  [
    "newer Project contract",
    () =>
      withDocument((value) => {
        value.envelope.schemaVersion = "1.99";
      }),
    "unsupported_version",
  ],
  [
    "unknown Project contract major",
    () =>
      withDocument((value) => {
        value.envelope.payload.schemaVersion = "2.0";
      }),
    "unsupported_version",
  ],
  [
    "unknown Project field",
    () =>
      withDocument((value) => {
        Object.assign(value.envelope.payload, { script: "alert(1)" });
      }),
    "schema_invalid",
  ],
  [
    "private local Locator",
    () =>
      withDocument((value) => {
        value.records.sources[0]!.locators = goldenRecords().sources[0]!.locators;
      }),
    "schema_invalid",
  ],
  [
    "private Receipt destination",
    () =>
      withDocument((value) => {
        value.records.exportReceipts = [
          {
            activeViewHash: `sha256:${"5".repeat(64)}`,
            createdAt: "2026-09-01T00:00:00Z",
            format: "open_chords_json",
            id: "export_private",
            omissions: [],
            outputHash: `sha256:${"6".repeat(64)}`,
            outputLocation: "/Users/someone/score.json",
            profileVersion: "open_chords_json/1.0/current",
          },
        ];
      }),
    "schema_invalid",
  ],
  [
    "unknown Source reference",
    () =>
      withDocument((value) => {
        value.records.projectRange.sourceId = "source_missing";
      }),
    "reference_invalid",
  ],
  [
    "unknown Analysis Revision reference",
    () =>
      withDocument((value) => {
        value.envelope.payload.editLayers[0]!.analysisRevisionId = "revision_missing";
      }),
    "invariant_invalid",
  ],
  [
    "foreign Analysis Revision",
    () =>
      withDocument((value) => {
        value.envelope.payload.analysisRevisions[0]!.projectId = "project_foreign";
      }),
    "invariant_invalid",
  ],
  [
    "Project Range length invariant",
    () =>
      withDocument((value) => {
        value.records.projectRange.endSourceSample = 24_000;
      }),
    "invariant_invalid",
  ],
  [
    "media outside the Project Range",
    () =>
      rawZip(
        signedArchiveEntries(document(), {
          media: {
            bytes: Buffer.alloc(4),
            declaration: {
              channels: 1,
              encoding: "pcm_s16le",
              endSourceSample: 2,
              sampleRate: 48_000,
              sourceId: "source_fixture",
              sourceSnapshotId: "snapshot_fixture",
              startSourceSample: 0,
            },
          },
        }),
      ),
    "reference_invalid",
  ],
  [
    "media with a foreign sample rate",
    () =>
      rawZip(
        signedArchiveEntries(document(), {
          media: {
            bytes: Buffer.alloc(96_000),
            declaration: {
              channels: 1,
              encoding: "pcm_s16le",
              endSourceSample: 48_000,
              sampleRate: 44_100,
              sourceId: "source_fixture",
              sourceSnapshotId: "snapshot_fixture",
              startSourceSample: 0,
            },
          },
        }),
      ),
    "declaration_mismatch",
  ],
];

it.each(hostileArchives)(
  "rejects %s before any Library or Offline Media Cache mutation",
  async (_name, build, reason) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "oc-hostile-archive-")));
    roots.push(root);
    const stateRoot = join(root, "state");
    const library = await openProjectLibrary({ stateRoot });
    const cache = await openOfflineMediaCache({ stateRoot });
    const archive = join(root, "hostile.ocarchive");
    await writeFile(archive, build());
    const before = await readdir(library.activeRoot, { recursive: true });
    const imports = new ProjectArchiveImports({
      cache,
      library,
      pickArchive: async () => archive,
    });
    expect(await imports.importArchive()).toEqual({ reason, state: "rejected" });
    expect(library.listProjects()).toEqual([]);
    expect(await readdir(library.activeRoot, { recursive: true })).toEqual(before);
    expect(await readdir(join(stateRoot, "offline-media-cache"))).toEqual([]);
  },
  20_000,
);

it("rejects a linked archive path without following it", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "oc-hostile-archive-link-")));
  roots.push(root);
  const target = join(root, "real.ocarchive");
  await writeFile(target, rawZip(valid()));
  const link = join(root, "link.ocarchive");
  await symlink(target, link);
  const stateRoot = join(root, "state");
  const library = await openProjectLibrary({ stateRoot });
  const imports = new ProjectArchiveImports({
    cache: await openOfflineMediaCache({ stateRoot }),
    library,
    pickArchive: async () => link,
  });
  expect(await imports.importArchive()).toEqual({
    reason: "unreadable_archive",
    state: "rejected",
  });
  expect(library.listProjects()).toEqual([]);
});

it("accepts the unmodified signed baseline so each hostile case isolates one violation", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "oc-hostile-archive-baseline-")));
  roots.push(root);
  const archive = join(root, "valid.ocarchive");
  await writeFile(archive, rawZip(valid()));
  const stateRoot = join(root, "state");
  const library = await openProjectLibrary({ stateRoot });
  const imports = new ProjectArchiveImports({
    cache: await openOfflineMediaCache({ stateRoot }),
    library,
    pickArchive: async () => archive,
  });
  expect(await imports.importArchive()).toMatchObject({
    projectId: "project_golden",
    state: "imported",
  });
});

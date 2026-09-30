import { readFileSync } from "node:fs";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { ProjectEnvelopeSchema } from "@open-chords/contracts";
import { expect, it, vi } from "vitest";

import { openOfflineMediaCache } from "../apps/desktop/src/main/offline-media-cache.ts";
import {
  archivedProjectFor,
  writePortableProjectArchive,
} from "../apps/desktop/src/main/project-archive-format.ts";
import { ProjectArchiveImports } from "../apps/desktop/src/main/project-archive-imports.ts";
import { openProjectLibrary } from "../apps/desktop/src/main/project-library.ts";
import { goldenRecords } from "./support/editor-fixture.ts";

const FORBIDDEN_MODULES =
  /^(?:electron|effect|node:child_process|node:cluster|node:dgram|node:dns|node:http|node:http2|node:https|node:inspector|node:net|node:tls|node:vm|node:worker_threads)$/u;
const FORBIDDEN_LOCAL_MODULES =
  /(?:acquisition|alignment|analysis|lyrics-discovery|model-store|network-mode|sidecar|youtube|local-media|project-library)\.ts$/u;
const FORBIDDEN_SOURCE = /\b(?:fetch|safeStorage|openExternal|spawn|execFile|eval|Function)\s*\(/u;

function valueImports(path: string): string[] {
  const source = readFileSync(path, "utf8");
  return [...source.matchAll(/^import\s+(?!type\s)[^;]*?from\s+"([^"]+)";/gmsu)].map(
    (match) => match[1]!,
  );
}

function importGraph(entry: string): { local: string[]; packages: string[]; sources: string[] } {
  const local = new Set<string>();
  const packages = new Set<string>();
  const pending = [resolve(entry)];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (local.has(current)) continue;
    local.add(current);
    for (const specifier of valueImports(current)) {
      if (specifier.startsWith(".")) pending.push(resolve(dirname(current), specifier));
      else packages.add(specifier);
    }
  }
  return {
    local: [...local],
    packages: [...packages],
    sources: [...local].map((path) => readFileSync(path, "utf8")),
  };
}

it("import has no network, model, credential, process or code-execution capability", () => {
  const graph = importGraph("apps/desktop/src/main/project-archive-imports.ts");
  expect(
    graph.local
      .map((path) => path.split("/").at(-1) ?? path)
      .toSorted((left, right) => left.localeCompare(right)),
  ).toEqual([
    "bounded-file.ts",
    "filesystem-durability.ts",
    "offline-media-cache.ts",
    "project-archive-format.ts",
    "project-archive-imports.ts",
    "project-archive-inspection.ts",
    "project-archive-zip.ts",
    "project-library-records.ts",
    "project-payload.ts",
  ]);
  expect(graph.local.filter((path) => FORBIDDEN_LOCAL_MODULES.test(path))).toEqual([]);
  expect(graph.packages.filter((name) => FORBIDDEN_MODULES.test(name))).toEqual([]);
  expect(graph.sources.filter((source) => FORBIDDEN_SOURCE.test(source))).toEqual([]);
});

it("an import completes while every network entry point fails loudly", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "oc-archive-offline-")));
  try {
    const archive = join(root, "offline.ocarchive");
    await writeFile(
      archive,
      writePortableProjectArchive({
        document: archivedProjectFor({
          envelope: ProjectEnvelopeSchema.parse(
            JSON.parse(
              readFileSync("packages/testkit/contracts/v1/valid/project-envelope.json", "utf8"),
            ),
          ),
          records: goldenRecords(),
        }).document,
      }).archive,
    );
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("network is forbidden during archive import");
    });
    const stateRoot = join(root, "state");
    const imports = new ProjectArchiveImports({
      cache: await openOfflineMediaCache({ stateRoot }),
      library: await openProjectLibrary({ stateRoot }),
      pickArchive: async () => archive,
    });
    expect(await imports.importArchive()).toMatchObject({ state: "imported" });
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  }
});

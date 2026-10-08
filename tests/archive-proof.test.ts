import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import { runPackagedArchiveProof } from "../apps/desktop/src/main/packaged-archive-proof.ts";
import { runPackagedExportProof } from "../apps/desktop/src/main/packaged-export-proof.ts";
import { prepareArchiveProofFixture } from "./support/archive-proof-fixture.ts";

it("imports the generated archive and leaves durable Library bytes unchanged on duplicate, cancel and hostile refusals", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "oc-archive-proof-")));
  try {
    const stateRoot = join(root, "state");
    await prepareArchiveProofFixture(stateRoot);
    await runPackagedExportProof(stateRoot);
    expect(await runPackagedArchiveProof(stateRoot)).toEqual({
      proof: "installed-archives",
      roundtrip: true,
      duplicateUnchanged: true,
      cancellationUnchanged: true,
      rejectedUnchanged: 8,
      durableReopen: true,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30000);

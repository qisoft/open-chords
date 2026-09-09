import { readFile } from "node:fs/promises";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ProjectEnvelopeSchema } from "@open-chords/contracts";
import { monoPcmWav } from "@open-chords/testkit/media";

import { LocalMediaService } from "../apps/desktop/src/main/local-media.ts";
import { openProjectLibrary } from "../apps/desktop/src/main/project-library.ts";

// Synthetic, disposable AT fixture. Never opens or modifies the user's Library.
const root = await realpath(await mkdtemp(join(tmpdir(), "open-chords-native-at-")));
const stateRoot = join(root, "user-data");
const mediaPath = join(root, "synthetic.wav");
const samples = Array.from({ length: 48_000 * 30 }, (_, index) =>
  Math.round(Math.sin((index * 2 * Math.PI * 220) / 48_000) * 300),
);
await writeFile(mediaPath, monoPcmWav(samples));
const catalog = await openProjectLibrary({ stateRoot: join(root, "media-catalog") });
const media = new LocalMediaService({ library: catalog, pickFile: async () => mediaPath });
media.activateGeneration("generation_native_at");
try {
  const selected = await media.pickLocalFile("generation_native_at");
  if (selected.kind !== "selected") throw new Error("Synthetic media selection failed");
  const created = await media.createProject({
    capabilityId: selected.capabilityId,
    generationId: "generation_native_at",
    startSourceSample: 0,
    endSourceSample: samples.length,
  });
  const { records } = await catalog.readProject(created.projectId);
  const original: unknown = JSON.parse(
    await readFile(
      new URL("../packages/testkit/contracts/v1/valid/project-envelope.json", import.meta.url),
      "utf8",
    ),
  );
  // The golden project is one second. Scale all Project Time sample coordinates together.
  const scaled: unknown = JSON.parse(JSON.stringify(original), (key, value: unknown) =>
    ["durationSamples", "startSample", "endSample", "atSample"].includes(key) &&
    typeof value === "number"
      ? value * 30
      : value,
  );
  const envelope = ProjectEnvelopeSchema.parse(scaled);
  records.legacyManifestlessAnalysisRevisionIds = envelope.payload.analysisRevisions.map(
    ({ id }) => id,
  );
  const library = await openProjectLibrary({ stateRoot });
  await library.createProject({ envelope, records });
  console.log(
    JSON.stringify(
      {
        root,
        stateRoot,
        mediaPath,
        projectId: envelope.payload.id,
        purpose: "Synthetic 30-second AT journey; not musical or alignment quality evidence",
      },
      null,
      2,
    ),
  );
} finally {
  await media.dispose();
}

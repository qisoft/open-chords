import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { generateContractJsonSchema } from "@open-chords/contracts";
import { OpenChordsJsonSnapshotSchema } from "@open-chords/domain";
import { canonicalSerialize } from "@open-chords/domain";
import { z } from "zod";

const output = join(
  import.meta.dirname,
  "../packages/testkit/contracts/v1/schema/project-envelope.schema.json",
);
const generated = canonicalSerialize(generateContractJsonSchema());

if (process.argv.includes("--check")) {
  if (readFileSync(output, "utf8") !== generated)
    throw new Error("Generated contract JSON Schema is stale");
} else {
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, generated, "utf8");
}

const exportOutput = join(
  import.meta.dirname,
  "../packages/testkit/contracts/v1/schema/open-chords-json.schema.json",
);
const exportSchema = canonicalSerialize(
  z.toJSONSchema(OpenChordsJsonSnapshotSchema, { target: "draft-2020-12" }),
);
if (process.argv.includes("--check")) {
  if (readFileSync(exportOutput, "utf8") !== exportSchema)
    throw new Error("Generated export JSON Schema is stale");
} else {
  writeFileSync(exportOutput, exportSchema, "utf8");
}

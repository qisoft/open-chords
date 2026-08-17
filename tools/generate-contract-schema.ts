import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { generateContractJsonSchema } from "@open-chords/contracts";
import { canonicalSerialize } from "@open-chords/domain";

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

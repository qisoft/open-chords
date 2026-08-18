import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { parseContractEnvelope } from "@open-chords/contracts";
import { mutateFixture, parseMutationCases } from "@open-chords/testkit/mutations";

const root = join(import.meta.dirname, "../packages/testkit/contracts/v1");

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

let validCount = 0;
for (const name of readdirSync(join(root, "valid"))) {
  if (!name.endsWith("envelope.json")) continue;
  parseContractEnvelope(readJson(join(root, "valid", name)));
  validCount += 1;
}
if (validCount === 0) throw new Error("No valid contract fixtures were found");

const golden = readJson(join(root, "valid/project-envelope.json"));
const cases = parseMutationCases(readJson(join(root, "invalid/cases.json")));
for (const fixture of cases) {
  const mutated = mutateFixture(golden, fixture);
  let rejected = false;
  try {
    parseContractEnvelope(mutated);
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error(`Invalid fixture was accepted: ${fixture.name}`);
}

process.stdout.write(
  `TypeScript contract fixtures: ${String(validCount)} valid, ${String(cases.length)} invalid\n`,
);

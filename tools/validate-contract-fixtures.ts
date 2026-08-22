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
  let errorType: string | undefined;
  try {
    parseContractEnvelope(mutated);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    errorType = error.constructor.name;
  }
  if (errorType === undefined) throw new Error(`Invalid fixture was accepted: ${fixture.name}`);
  if (errorType !== fixture.expectedErrorType)
    throw new Error(
      `Invalid fixture ${fixture.name} raised ${errorType}, expected ${fixture.expectedErrorType}`,
    );
}

let standaloneInvalidCount = 0;
for (const name of readdirSync(join(root, "invalid"))) {
  if (!name.endsWith("envelope.json")) continue;
  let accepted = true;
  try {
    parseContractEnvelope(readJson(join(root, "invalid", name)));
  } catch {
    accepted = false;
  }
  if (accepted) throw new Error(`Invalid fixture was accepted: ${name}`);
  standaloneInvalidCount += 1;
}

process.stdout.write(
  `TypeScript contract fixtures: ${String(validCount)} valid, ${String(cases.length + standaloneInvalidCount)} invalid\n`,
);

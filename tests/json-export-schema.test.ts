import { readFileSync } from "node:fs";

import addFormats from "ajv-formats";
import { Ajv2020 } from "ajv/dist/2020.js";
import { expect, it } from "vitest";

it("an independent JSON Schema validator accepts the canonical fixture and rejects private fields and unknown versions", () => {
  const validator = new Ajv2020({ strict: true });
  addFormats(validator);
  const validate = validator.compile(
    JSON.parse(
      readFileSync("packages/testkit/contracts/v1/schema/open-chords-json.schema.json", "utf8"),
    ),
  );
  const fixture = JSON.parse(readFileSync("tests/fixtures/json-export-golden.json", "utf8"));
  expect(validate(fixture)).toBe(true);
  expect(validate({ ...fixture, schemaVersion: "2.0" })).toBe(false);
  expect(validate({ ...fixture, privatePath: "/private/source.wav" })).toBe(false);
  fixture.lyrics.document.provenance.reference = "/private/source.wav";
  expect(validate(fixture)).toBe(false);
});

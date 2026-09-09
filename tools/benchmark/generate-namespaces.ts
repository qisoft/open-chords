import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { canonicalSerialize } from "@open-chords/domain";
import { z } from "zod";

import { AdjudicationSchema, RawAnnotationSchema } from "./annotations.ts";

// JAMS 0.3.5 uses draft-04. Inline local definitions before embedding a record
// schema inside the namespace value, so JSON pointers never change their meaning.
function draft04(root: Record<string, unknown>): unknown {
  const convert = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(convert);
    if (value === null || typeof value !== "object") return value;
    const object = z.record(z.string(), z.unknown()).parse(value);
    if (typeof object.$ref === "string") {
      if (!object.$ref.startsWith("#/definitions/"))
        throw new Error("Unsupported schema reference");
      const definitions = z.record(z.string(), z.unknown()).parse(root.definitions);
      const resolved = definitions[object.$ref.slice("#/definitions/".length)];
      if (resolved === undefined) throw new Error("Missing schema definition");
      return convert(resolved);
    }
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(object)) {
      if (key === "$schema" || key === "definitions") continue;
      if (key === "const") result.enum = [item];
      else if (
        (key === "exclusiveMinimum" || key === "exclusiveMaximum") &&
        typeof item === "number"
      ) {
        result[key === "exclusiveMinimum" ? "minimum" : "maximum"] = item;
        result[key] = true;
      } else result[key] = convert(item);
    }
    return result;
  };
  return convert(root);
}
const namespaces = Object.fromEntries(
  [
    ["open_chords_raw_v1", RawAnnotationSchema] as const,
    ["open_chords_gold_v1", AdjudicationSchema] as const,
  ].map(([name, schema]) => {
    const record = schema === RawAnnotationSchema ? RawAnnotationSchema : AdjudicationSchema;
    const value = z.strictObject({
      startSample: z.literal(0),
      endSample: z.number().int().positive(),
      sampleRate: z.number().int().positive().max(768000),
      record,
    });
    return [
      name,
      {
        value: draft04(z.toJSONSchema(value, { target: "draft-7" })),
        confidence: { type: "null" },
        dense: false,
        description:
          "Open Chords 1.0 canonical sample records; semantic validation and hash verification require the Open Chords Gold Reference API.",
      },
    ];
  }),
);
const target = join(import.meta.dirname, "schemata/open-chords-namespaces.json");
const bytes = canonicalSerialize(namespaces);
if (process.argv.includes("--check")) {
  if (readFileSync(target, "utf8") !== bytes)
    throw new Error("Benchmark namespace schema is stale");
} else writeFileSync(target, bytes);

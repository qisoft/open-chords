import { readFile } from "node:fs/promises";

import { buildGoldReference, parseGoldReference } from "./annotations.ts";
import { goldFromJams, goldToJams } from "./jams.ts";
import {
  auditCorpusFiles,
  openSealedCorpus,
  publishCorpus,
  readJson,
  verifyBundle,
  writeArtifact,
} from "./storage.ts";

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const count = (expected: number) => {
    if (args.length !== expected) throw new Error("Invalid arguments");
  };
  if (command === "audit") {
    count(2);
    await writeArtifact(args[1]!, await auditCorpusFiles(await readJson(args[0]!)));
  } else if (command === "adjudicate" || command === "to-jams" || command === "from-jams") {
    count(2);
    const input = await readJson(args[0]!);
    const output =
      command === "adjudicate"
        ? buildGoldReference(input)
        : command === "to-jams"
          ? goldToJams(input)
          : goldFromJams(input);
    await writeArtifact(args[1]!, output);
  } else if (command === "validate-gold") {
    count(1);
    parseGoldReference(await readJson(args[0]!));
  } else if (command === "verify") {
    count(1);
    await verifyBundle(args[0]!);
  } else if (command === "publish") {
    count(4);
    await publishCorpus(
      await readJson(args[0]!),
      args[1]!,
      await readFile(args[2]!, "utf8"),
      await readFile(args[3]!, "utf8"),
    );
  } else if (command === "open-sealed") {
    count(6);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > 16384) throw new Error("Invalid key size");
      chunks.push(bytes);
    }
    const key = Buffer.concat(chunks);
    try {
      await openSealedCorpus(
        args[0]!,
        args[1]!,
        args[2]!,
        await readJson(args[3]!),
        await readJson(args[4]!),
        await readFile(args[5]!, "utf8"),
        key.toString("utf8"),
      );
    } finally {
      key.fill(0);
      for (const chunk of chunks) chunk.fill(0);
    }
  } else throw new Error("Unknown command");
  process.stdout.write("benchmark_ok\n");
}
main().catch(() => {
  process.stderr.write("benchmark_failed\n");
  process.exitCode = 1;
});

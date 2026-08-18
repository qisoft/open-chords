import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "../packages/domain");

function files(path: string): string[] {
  return readdirSync(path).flatMap((name) => {
    const child = join(path, name);
    return statSync(child).isDirectory() ? files(child) : [child];
  });
}

describe("domain package dependency boundary", () => {
  it("does not depend on Electron, filesystem, network, React, or Effect", () => {
    const manifest: unknown = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    if (typeof manifest !== "object" || manifest === null || !("dependencies" in manifest)) {
      throw new Error("Domain package manifest has no dependencies object");
    }
    const dependencies = manifest.dependencies;
    if (typeof dependencies !== "object" || dependencies === null) {
      throw new Error("Domain package dependencies must be an object");
    }
    expect(Object.keys(dependencies).toSorted()).toEqual(["zod"]);

    const source = files(join(root, "src"))
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");
    expect(source).not.toMatch(
      /(?:from\s*|import\s*\(\s*|import\s+|require\s*\(\s*)["'](?:electron|effect|react|node:child_process|node:dns|node:fs|node:http|node:https|node:net|node:tls|node:worker_threads)(?:["'/])/,
    );
    expect(source).not.toContain("fetch(");
  });
});

import { expect, it } from "vitest";

import { proofTreeDifference } from "../apps/desktop/src/main/packaged-proof-tree-difference.ts";
it("separates durable Library and browser changes without exposing paths or hashes", () => {
  const before = {
    "project-library/projects/private-id/HEAD": "private-hash",
    Preferences: "a",
    "Network/private-token": "a",
    "private-path.json": "b",
  };
  const after: Record<string, string> = {
    ...before,
    "project-library/projects/private-id/HEAD": "changed-private-hash",
    Preferences: "b",
    "Cache/private-cache": "c",
  };
  delete after["private-path.json"];
  const result = proofTreeDifference(before, after);
  expect(result).toBe(
    "Export disk proof source delta: added=1 removed=1 changed=2 library=1 location=0 network=0 export_pending=0 chromium_preferences=1 chromium_storage=0 chromium_cache=1 other=1",
  );
  expect(result).not.toContain("private");
  expect(result).not.toContain("hash");
});
it("does not report changes for identical maps with a different insertion order", () => {
  expect(proofTreeDifference({ a: "1", b: "2" }, { b: "2", a: "1" })).toContain(
    "added=0 removed=0 changed=0",
  );
});
it("bounds numeric diagnostics even for an oversized private tree", () => {
  const tree = Object.fromEntries(
    Array.from({ length: 10001 }, (_, i) => [`private-${i}`, "secret"]),
  );
  expect(proofTreeDifference({}, tree)).toContain("added=9999");
  expect(proofTreeDifference({}, tree)).toContain("other=9999");
});

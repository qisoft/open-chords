import { expect, it } from "vitest";

import {
  proofTreeDifference,
  withoutChromiumPreferences,
} from "../apps/desktop/src/main/packaged-proof-tree-difference.ts";
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

it("allows only the two exact root preference files to change while preserving all durable entries", () => {
  const baseline = {
    "project-library/projects/id/HEAD": "head",
    "project-library-location.json": "location",
    "network-mode.json": "offline",
    "export-pending/journal.json": "journal",
    "unknown.json": "unknown",
  };
  const withPreferences = { ...baseline, Preferences: "new", "Local State": "new" };
  expect(withoutChromiumPreferences(withPreferences)).toEqual(baseline);
  expect(withPreferences).toHaveProperty("Preferences", "new");
});
it.each([
  "project-library/Preferences",
  "project-library/Local State",
  "other/Preferences",
  "Preferences/",
  "preferences",
  "local state",
  "project-library-location.json",
  "network-mode.json",
  "export-pending/journal.json",
  "unknown.json",
])("never filters durable/nested or unknown path %s", (path) => {
  const before = { [path]: "before" };
  const after = { [path]: "after", Preferences: "new" };
  expect(withoutChromiumPreferences(after)).not.toEqual(withoutChromiumPreferences(before));
  expect(withoutChromiumPreferences(after)[path]).toBe("after");
  expect(withoutChromiumPreferences({})).not.toEqual(withoutChromiumPreferences(before));
});

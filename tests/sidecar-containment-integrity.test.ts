import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { verifyContainmentRuntime } from "../apps/desktop/src/main/sidecar-containment-integrity.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

it("returns only the exact helper authorized by the embedded manifest hash", () => {
  const fixture = containmentFixture();

  expect(verifyContainmentRuntime(fixture.root, fixture.manifestHash, "win32")).toMatchObject({
    backend: "windows-appcontainer-job",
    helperPath: join(realpathSync(fixture.root), "open-chords-containment-launcher.exe"),
  });
});

it("rejects changed and extra containment files", () => {
  const changed = containmentFixture();
  writeFileSync(join(changed.root, "open-chords-containment-launcher.exe"), "changed");
  expect(() => verifyContainmentRuntime(changed.root, changed.manifestHash, "win32")).toThrow(
    /hash mismatch/,
  );

  const extra = containmentFixture();
  writeFileSync(join(extra.root, "unexpected.dll"), "extra");
  expect(() => verifyContainmentRuntime(extra.root, extra.manifestHash, "win32")).toThrow(
    /unmanifested/,
  );
});

it("verifies an external packaged helper against the manifested helper", () => {
  const fixture = containmentFixture();
  const external = `${fixture.root}-packaged-containment-helper.exe`;
  roots.push(external);
  writeFileSync(external, "fixture-helper");

  expect(
    verifyContainmentRuntime(fixture.root, fixture.manifestHash, "win32", external),
  ).toMatchObject({ helperPath: realpathSync(external) });
  writeFileSync(external, "changed");
  expect(() =>
    verifyContainmentRuntime(fixture.root, fixture.manifestHash, "win32", external),
  ).toThrow("External containment helper hash mismatch");
});

function containmentFixture() {
  const root = mkdtempSync(join(tmpdir(), "open-chords-containment-integrity-"));
  roots.push(root);
  const relative = "open-chords-containment-launcher.exe";
  const bytes = Buffer.from("fixture-helper");
  writeFileSync(join(root, relative), bytes);
  const manifest = Buffer.from(
    `${JSON.stringify(
      {
        backend: "windows-appcontainer-job",
        files: [{ path: relative, sha256: createHash("sha256").update(bytes).digest("hex") }],
        version: 1,
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(root, "containment-manifest.json"), manifest);
  return { manifestHash: createHash("sha256").update(manifest).digest("hex"), root };
}

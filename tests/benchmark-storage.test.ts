import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { canonicalSerialize } from "@open-chords/domain";
import { expect, it } from "vitest";

import { contentHash } from "../tools/benchmark/index.ts";
import { corpusFixture, fixtureContext } from "./support/benchmark-fixture.ts";

const cli = (args: string[], input?: string) =>
  spawnSync(process.execPath, ["tools/benchmark/cli.ts", ...args], { encoding: "utf8", input });
it("publishes real files, keeps sealed plaintext and custody key out of tuning, and requires an authenticated frozen policy", () => {
  const root = mkdtempSync(join(tmpdir(), "oc-benchmark-"));
  try {
    const { manifest, gold } = corpusFixture();
    const media = manifest.tracks.map((track, i) => {
      const bytes = Buffer.from(`SYNTHETIC AUDIO ${i} private marker`),
        path = join(root, `input-${i}.bin`);
      writeFileSync(path, bytes);
      const hash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
      track.sourceHashes = [hash];
      return { trackId: track.id, path, hash };
    });
    const custodian = generateKeyPairSync("rsa", { modulusLength: 2048 }),
      authority = generateKeyPairSync("ed25519");
    const publicKey = join(root, "custodian.pem"),
      trustedKey = join(root, "authority.pem");
    writeFileSync(publicKey, custodian.publicKey.export({ type: "spki", format: "pem" }));
    writeFileSync(trustedKey, authority.publicKey.export({ type: "spki", format: "pem" }));
    const input = join(root, "input.json"),
      bundle = join(root, "bundle");
    writeFileSync(input, JSON.stringify({ manifest, gold, context: fixtureContext, media }));
    const published = cli(["publish", input, bundle, publicKey, trustedKey]);
    expect({ status: published.status, stderr: published.stderr }).toEqual({
      status: 0,
      stderr: "",
    });
    expect(cli(["publish", input, bundle, publicKey, trustedKey]).status).toBe(1);
    const calibration = readFileSync(join(bundle, "calibration.json"), "utf8");
    expect(calibration).toContain("track_calibration");
    expect(calibration).not.toContain("track_sealed");
    for (const name of readdirSync(bundle)) {
      const bytes = readFileSync(join(bundle, name));
      expect(bytes.includes(Buffer.from("SYNTHETIC AUDIO 1 private marker"))).toBe(false);
      expect(bytes.includes(Buffer.from("PRIVATE KEY"))).toBe(false);
    }
    const index = JSON.parse(readFileSync(join(bundle, "index.json"), "utf8"));
    const policy = join(root, "policy.json"),
      freeze = join(root, "freeze.json"),
      output = join(root, "release");
    writeFileSync(policy, JSON.stringify({ version: "fixture", thresholds: "synthetic only" }));
    const declaration = {
      version: "1.0",
      bundleHash: contentHash(index),
      corpusHash: index.corpusHash,
      policyHash: `sha256:${createHash("sha256").update(readFileSync(policy)).digest("hex")}`,
      frozenAt: "2026-01-01T00:00:00Z",
      parametersFrozen: true,
    };
    writeFileSync(
      freeze,
      JSON.stringify({
        declaration,
        signature: sign(
          null,
          Buffer.from(canonicalSerialize(declaration)),
          authority.privateKey,
        ).toString("base64"),
      }),
    );
    const reviewPath = join(root, "rights-review.json");
    const rightsDeclaration = {
      version: "1.0",
      corpusHash: index.corpusHash,
      reviewedAt: new Date(Date.now() - 1000).toISOString(),
      validUntil: new Date(Date.now() + 60000).toISOString(),
      context: { territory: "NL", executionLocation: "local_reference" },
      tracks: manifest.tracks.map((track) => ({ id: track.id, rights: track.rights })),
    };
    const saveReview = (rightsValue: unknown) =>
      writeFileSync(
        reviewPath,
        JSON.stringify({
          declaration: rightsValue,
          signature: sign(
            null,
            Buffer.from(canonicalSerialize(rightsValue)),
            authority.privateKey,
          ).toString("base64"),
        }),
      );
    saveReview(rightsDeclaration);
    const args = ["open-sealed", bundle, output, policy, freeze, reviewPath, trustedKey];
    expect(cli(args).status).toBe(1);
    const privateKey = custodian.privateKey.export({ type: "pkcs8", format: "pem" });
    const bad = JSON.parse(readFileSync(freeze, "utf8"));
    bad.declaration.parametersFrozen = false;
    writeFileSync(join(root, "bad-freeze.json"), JSON.stringify(bad));
    expect(
      cli(
        [
          "open-sealed",
          bundle,
          output,
          policy,
          join(root, "bad-freeze.json"),
          reviewPath,
          trustedKey,
        ],
        privateKey,
      ).status,
    ).toBe(1);
    const revoked = structuredClone(rightsDeclaration);
    revoked.tracks[1]!.rights[0]!.disposition = "revoked";
    saveReview(revoked);
    expect(cli(args, privateKey).status).toBe(1);
    expect(readdirSync(root)).not.toContain("release");
    saveReview(rightsDeclaration);
    const unsigned = JSON.parse(readFileSync(reviewPath, "utf8"));
    unsigned.declaration.context.territory = "US";
    writeFileSync(reviewPath, JSON.stringify(unsigned));
    expect(cli(args, privateKey).status).toBe(1);
    saveReview(rightsDeclaration);
    const opened = cli(args, privateKey);
    expect({ status: opened.status, stderr: opened.stderr }).toEqual({ status: 0, stderr: "" });
    expect(readFileSync(join(output, "sealed.json"), "utf8")).toContain("track_sealed");
    expect(readFileSync(join(output, "track_sealed.bin"), "utf8")).toBe(
      "SYNTHETIC AUDIO 1 private marker",
    );
    expect(cli(args, privateKey).status).toBe(1);
    const wrongKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
      type: "pkcs8",
      format: "pem",
    });
    const rejected = cli(
      ["open-sealed", bundle, join(root, "wrong-key"), policy, freeze, reviewPath, trustedKey],
      wrongKey,
    );
    expect({ status: rejected.status, stderr: rejected.stderr }).toEqual({
      status: 1,
      stderr: "benchmark_failed\n",
    });
    const encryptedPath = join(bundle, "sealed.enc"),
      encrypted = readFileSync(encryptedPath);
    const changedCipher = Buffer.from(encrypted);
    changedCipher[0] = changedCipher[0]! ^ 1;
    writeFileSync(encryptedPath, changedCipher);
    expect(
      cli(
        ["open-sealed", bundle, join(root, "tampered"), policy, freeze, reviewPath, trustedKey],
        privateKey,
      ).status,
    ).toBe(1);
    expect(readdirSync(root)).not.toContain("tampered");
    writeFileSync(encryptedPath, encrypted);
    const reportA = join(root, "audit-a.json"),
      reportB = join(root, "audit-b.json");
    expect(cli(["audit", input, reportA]).status).toBe(0);
    expect(cli(["audit", input, reportB]).status).toBe(0);
    expect(readFileSync(reportA)).toEqual(readFileSync(reportB));
    // Policy bytes cannot change after signing, even with a valid custodian key.
    writeFileSync(policy, "{}");
    expect(
      cli(
        ["open-sealed", bundle, join(root, "changed"), policy, freeze, reviewPath, trustedKey],
        privateKey,
      ).status,
    ).toBe(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);

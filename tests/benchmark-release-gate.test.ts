import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { canonicalSerialize } from "@open-chords/domain";
import { expect, it } from "vitest";

import { contentHash, sealedGateFiles } from "../tools/benchmark/index.ts";
import { fixtureContext } from "./support/benchmark-fixture.ts";
import {
  completed,
  gateCorpus,
  goldChords,
  perfect,
  policyFor,
  procedure,
  run,
  threshold,
  type Output,
} from "./support/benchmark-gate-fixture.ts";

const cli = (args: string[], input?: string) =>
  spawnSync(process.execPath, ["tools/benchmark/cli.ts", ...args], { encoding: "utf8", input });
const sha = (bytes: Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const signed = (declaration: unknown, key: KeyObject) => ({
  declaration,
  signature: sign(null, Buffer.from(canonicalSerialize(declaration)), key).toString("base64"),
});

it("freezes calibration-derived policy before opening and records one unrepairable sealed verdict", async () => {
  const root = mkdtempSync(join(tmpdir(), "oc-release-gate-"));
  const path = (name: string) => join(root, name);
  const save = (name: string, value: unknown) => {
    writeFileSync(path(name), JSON.stringify(value));
    return path(name);
  };
  try {
    const { manifest, gold } = gateCorpus(3);
    const media = manifest.tracks.map((track, index) => {
      const bytes = Buffer.from(`SYNTHETIC AUDIO ${index}`);
      writeFileSync(path(`audio-${index}.bin`), bytes);
      track.sourceHashes = [sha(bytes)];
      return { trackId: track.id, path: path(`audio-${index}.bin`), hash: sha(bytes) };
    });
    const custodian = generateKeyPairSync("rsa", { modulusLength: 2048 }),
      authority = generateKeyPairSync("ed25519");
    const custodianKey = path("custodian.pem");
    writeFileSync(custodianKey, custodian.publicKey.export({ type: "spki", format: "pem" }));
    const trustedKey = path("authority.pem");
    writeFileSync(trustedKey, authority.publicKey.export({ type: "spki", format: "pem" }));
    const corpusInput = save("input.json", { manifest, gold, context: fixtureContext, media });
    expect(cli(["publish", corpusInput, path("bundle"), custodianKey, trustedKey]).status).toBe(0);
    const index = JSON.parse(readFileSync(path("bundle/index.json"), "utf8"));
    const corpusHash: string = index.corpusHash;
    expect(corpusHash).toBe(contentHash(manifest));

    const outputs = (cohort: string, output: (id: string) => Output) =>
      new Map(manifest.tracks.filter((t) => t.cohort === cohort).map((t) => [t.id, output(t.id)]));
    const procedurePath = save("procedure.json", procedure(corpusHash));
    const calibrationRun = (role: "candidate" | "baseline") =>
      save(`${role}-calibration.json`, run(role, corpusHash, outputs("calibration", perfect)));
    const reportPath = path("calibration-report.json");
    const calibrate = [
      "calibrate",
      path("bundle"),
      procedurePath,
      calibrationRun("candidate"),
      calibrationRun("baseline"),
      reportPath,
    ];
    expect(cli(calibrate)).toMatchObject({ status: 0, stdout: "benchmark_ok\n" });
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    expect(report).toMatchObject({ cohort: "calibration", syntheticEvidence: true });
    expect(JSON.stringify(report)).not.toContain("track_3");
    const wrongCorpus = save("procedure-other.json", procedure(`sha256:${"9".repeat(64)}`));
    expect(
      cli(["calibrate", path("bundle"), wrongCorpus, ...calibrate.slice(3, 5), path("other.json")])
        .status,
    ).toBe(1);

    const policy = policyFor(report, corpusHash);
    const policyPath = save("policy.json", policy);
    expect(cli(["validate-policy", policyPath, reportPath]).status).toBe(0);
    const tamperedReport = save("report-tampered.json", { ...report, syntheticEvidence: false });
    expect(cli(["validate-policy", policyPath, tamperedReport]).status).toBe(1);

    const freeze = save(
      "freeze.json",
      signed(
        {
          version: "1.0",
          bundleHash: contentHash(index),
          corpusHash,
          policyHash: sha(readFileSync(policyPath)),
          frozenAt: "2026-01-01T00:00:00Z",
          parametersFrozen: true,
        },
        authority.privateKey,
      ),
    );
    const review = save(
      "rights.json",
      signed(
        {
          version: "1.0",
          corpusHash,
          reviewedAt: new Date(Date.now() - 1000).toISOString(),
          validUntil: new Date(Date.now() + 60000).toISOString(),
          context: { territory: "NL", executionLocation: "local_reference" },
          tracks: manifest.tracks.map((track) => ({ id: track.id, rights: track.rights })),
        },
        authority.privateKey,
      ),
    );
    const release = path("release");
    const privateKey = custodian.privateKey.export({ type: "pkcs8", format: "pem" });
    const opened = cli(
      ["open-sealed", path("bundle"), release, policyPath, freeze, review, trustedKey],
      privateKey,
    );
    expect(opened.status).toBe(0);

    const halfAbstained = (id: string): Output =>
      id === "track_3"
        ? completed([
            { ...goldChords[0]!, confidence: 0.9 },
            { ...goldChords[1]!, state: "abstained" },
          ])
        : perfect();
    const baseline = save(
      "baseline-sealed.json",
      run("baseline", corpusHash, outputs("sealed", perfect)),
    );
    const candidatePath = (candidateOutputs: Map<string, Output>) =>
      save("candidate-sealed.json", run("candidate", corpusHash, candidateOutputs));
    const gate = (policyFile: string, candidateOutputs: Map<string, Output>) =>
      cli([
        "sealed-gate",
        release,
        policyFile,
        reportPath,
        trustedKey,
        candidatePath(candidateOutputs),
        baseline,
      ]);
    const repair = (policyFile: string, candidateOutputs: Map<string, Output>) =>
      sealedGateFiles(
        release,
        policyFile,
        reportPath,
        readFileSync(trustedKey, "utf8"),
        candidatePath(candidateOutputs),
        baseline,
      );
    expect(gate(policyPath, outputs("sealed", halfAbstained))).toMatchObject({
      status: 0,
      stderr: "",
    });
    const verdictPath = join(release, "verdict.json");
    const first = readFileSync(verdictPath);
    const recorded = JSON.parse(first.toString("utf8"));
    expect(recorded).toMatchObject({
      bundleHash: contentHash(index),
      policyFileHash: sha(readFileSync(policyPath)),
      verdict: { verdict: "fail", releaseAuthority: false, syntheticEvidence: true },
    });
    expect(recorded.verdict.gates[0]).toMatchObject({
      status: "fail",
      quality: { n: 3 },
      coverage: { n: 3, status: "fail" },
    });

    const lowered = structuredClone(policy);
    lowered.qualityGates[0]!.quality.bound = threshold(0);
    lowered.qualityGates[0]!.coverage.minimum = threshold(0);
    await expect(
      repair(save("policy-lowered.json", lowered), outputs("sealed", perfect)),
    ).rejects.toThrow(/differs from the frozen policy/);
    const narrowed = structuredClone(policy);
    narrowed.supportClaims[0]!.required = false;
    await expect(
      repair(save("policy-narrowed.json", narrowed), outputs("sealed", perfect)),
    ).rejects.toThrow(/differs from the frozen policy/);
    await expect(repair(policyPath, outputs("sealed", perfect))).rejects.toThrow(/already exists/);
    expect(gate(policyPath, outputs("sealed", perfect)).status).toBe(1);
    expect(readFileSync(verdictPath)).toEqual(first);

    unlinkSync(verdictPath);
    const sealedPath = join(release, "sealed.json");
    const sealed = JSON.parse(readFileSync(sealedPath, "utf8"));
    const original = JSON.stringify(sealed);
    sealed.input.manifest.tracks = sealed.input.manifest.tracks.filter(
      (track: { id: string }) => track.id !== "track_3",
    );
    sealed.input.gold = sealed.input.gold.filter(
      (reference: { annotations: { trackId: string }[] }) =>
        reference.annotations[0]!.trackId !== "track_3",
    );
    writeFileSync(sealedPath, JSON.stringify(sealed));
    await expect(repair(policyPath, outputs("sealed", perfect))).rejects.toThrow(
      /differs from the frozen corpus/,
    );
    writeFileSync(sealedPath, original);

    const dropped = outputs("sealed", halfAbstained);
    dropped.delete("track_3");
    expect(gate(policyPath, dropped).status).toBe(0);
    expect(JSON.parse(readFileSync(verdictPath, "utf8")).verdict).toMatchObject({
      verdict: "fail",
      hardGates: [
        { status: "fail", reasons: ["candidate:profile_fixture:output_inventory"] },
        { status: "pass" },
      ],
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);

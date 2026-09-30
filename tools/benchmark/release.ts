import { join } from "node:path";

import { z } from "zod";

import { contentHash } from "./annotations.ts";
import { CorpusManifestSchema, parseCorpusManifest } from "./corpus.ts";
import { characterize, evaluateGates } from "./gates.ts";
import { parsePolicy, ProcedureSchema } from "./policy.ts";
import { HashSchema } from "./rights.ts";
import {
  bytesHash,
  FreezeSchema,
  publicKeyHash,
  readJson,
  SealedCorpusSchema,
  verifyBundle,
  verifyFreeze,
  writeArtifact,
} from "./storage.ts";

const CalibrationFileSchema = z.strictObject({
  version: z.literal("1.0"),
  purpose: CorpusManifestSchema.shape.purpose,
  tracks: CorpusManifestSchema.shape.tracks,
  gold: z.array(z.unknown()),
  media: z.array(z.unknown()),
  context: z.unknown(),
});
const ReceiptSchema = z.looseObject({ version: z.literal("1.0"), freeze: FreezeSchema });

export async function calibrateFiles(
  bundle: string,
  procedurePath: string,
  candidatePath: string,
  baselinePath: string,
) {
  const index = await verifyBundle(bundle);
  const calibration = CalibrationFileSchema.parse(await readJson(join(bundle, "calibration.json")));
  const procedure = ProcedureSchema.parse(await readJson(procedurePath));
  if (procedure.corpusHash !== index.corpusHash)
    throw new Error("Procedure names a different corpus");
  return characterize({
    procedure,
    purpose: calibration.purpose,
    cohort: "calibration",
    tracks: calibration.tracks,
    gold: calibration.gold,
    candidate: await readJson(candidatePath),
    baseline: await readJson(baselinePath),
  });
}

export async function validatePolicyFiles(policyPath: string, reportPath: string) {
  return parsePolicy(await readJson(policyPath), await readJson(reportPath));
}

export async function sealedGateFiles(
  bundle: string,
  release: string,
  policyPath: string,
  reportPath: string,
  trustedAuthorityPublicKey: string,
  candidatePath: string,
  baselinePath: string,
) {
  const receipt = ReceiptSchema.parse(await readJson(join(release, "opening-receipt.json")));
  const index = await verifyBundle(bundle);
  if (receipt.freeze.declaration.policyHash !== (await bytesHash(policyPath)))
    throw new Error("Policy differs from the frozen policy");
  const freeze = (await verifyFreeze(receipt.freeze, trustedAuthorityPublicKey, index, policyPath))
    .declaration;
  const policy = await validatePolicyFiles(policyPath, reportPath);
  const sealed = SealedCorpusSchema.parse(await readJson(join(release, "sealed.json")));
  const manifest = parseCorpusManifest(sealed.input.manifest);
  if (
    contentHash(manifest) !== freeze.corpusHash ||
    policy.procedure.corpusHash !== freeze.corpusHash
  )
    throw new Error("Released corpus differs from the frozen corpus");
  const sealedHashes = new Set(
    manifest.tracks.flatMap((track) => (track.cohort === "sealed" ? track.goldHashes : [])),
  );
  const verdict = evaluateGates(policy, {
    procedure: policy.procedure,
    purpose: manifest.purpose,
    cohort: "sealed",
    tracks: manifest.tracks.filter((track) => track.cohort === "sealed"),
    gold: sealed.input.gold.filter((reference) =>
      sealedHashes.has(z.looseObject({ hash: HashSchema }).parse(reference).hash),
    ),
    candidate: await readJson(candidatePath),
    baseline: await readJson(baselinePath),
  });
  const binding = {
    version: "1.0",
    bundleHash: freeze.bundleHash,
    policyFileHash: freeze.policyHash,
    authorityHash: publicKeyHash(trustedAuthorityPublicKey),
    receiptHash: contentHash(receipt),
    verdict,
  };
  const record = { ...binding, hash: contentHash(binding) };
  await writeArtifact(join(release, "verdict.json"), record);
  return record;
}

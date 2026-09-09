import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPublicKey,
  publicEncrypt,
  privateDecrypt,
  randomBytes,
  verify,
} from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { link, lstat, mkdtemp, open, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { canonicalSerialize } from "@open-chords/domain";
import { z } from "zod";

import { contentHash, parseGoldReference } from "./annotations.ts";
import { auditCorpus, AuditContextSchema, parseCorpusManifest } from "./corpus.ts";
import { HashSchema, TimeSchema } from "./rights.ts";

const maxJsonBytes = 32 * 1024 * 1024;
const mediaSchema = z.strictObject({
  trackId: z.string(),
  path: z.string().min(1),
  hash: HashSchema,
});
const inputSchema = z.strictObject({
  manifest: z.unknown(),
  gold: z.array(z.unknown()),
  context: AuditContextSchema,
  media: z.array(mediaSchema),
});
const fileSchema = z.strictObject({
  name: z
    .string()
    .regex(/^(?:calibration\.json|audio_[0-9]+\.bin|sealed\.enc|sealed_[0-9]+\.enc)$/),
  hash: HashSchema,
  nonce: z
    .string()
    .regex(/^[a-f0-9]{24}$/)
    .nullable(),
  tag: z
    .string()
    .regex(/^[a-f0-9]{32}$/)
    .nullable(),
});
const indexSchema = z.strictObject({
  version: z.literal("1.0"),
  corpusHash: HashSchema,
  authorityHash: HashSchema,
  wrappedKey: z
    .string()
    .regex(/^[A-Za-z0-9+/]+={0,2}$/)
    .max(2048),
  files: z.array(fileSchema).min(2).max(52),
});
const freezeSchema = z.strictObject({
  declaration: z.strictObject({
    version: z.literal("1.0"),
    bundleHash: HashSchema,
    corpusHash: HashSchema,
    policyHash: HashSchema,
    frozenAt: TimeSchema,
    parametersFrozen: z.literal(true),
  }),
  signature: z
    .string()
    .regex(/^[A-Za-z0-9+/]+={0,2}$/)
    .max(256),
});
const sealedSchema = z.strictObject({
  input: inputSchema.omit({ media: true }),
  report: z.unknown(),
  media: z.array(
    z.strictObject({
      trackId: z.string(),
      storageName: z.string().regex(/^sealed_[0-9]+\.enc$/),
      hash: HashSchema,
    }),
  ),
});
type FileRecord = z.infer<typeof fileSchema>;
export async function readJson(path: string): Promise<unknown> {
  const handle = await open(path, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxJsonBytes) throw new Error("Invalid JSON file size");
    const bytes = Buffer.alloc(stat.size + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== stat.size) throw new Error("JSON file changed while reading");
    return JSON.parse(bytes.subarray(0, bytesRead).toString("utf8")) as unknown;
  } finally {
    await handle.close();
  }
}
async function syncFile(path: string) {
  const handle = await open(path, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function syncDirectory(path: string) {
  if (process.platform === "win32") return;
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function ensureAbsent(path: string) {
  try {
    await lstat(path);
  } catch (error) {
    if ((error instanceof Error && "code" in error ? error.code : undefined) === "ENOENT") return;
    throw error;
  }
  throw new Error("Destination already exists");
}
async function stageDirectory<T>(
  destination: string,
  work: (stage: string) => Promise<T>,
): Promise<T> {
  const target = resolve(destination);
  await ensureAbsent(target);
  const stage = await mkdtemp(join(dirname(target), ".benchmark-"));
  try {
    const result = await work(stage);
    await syncDirectory(stage);
    await ensureAbsent(target);
    await rename(stage, target);
    await syncDirectory(dirname(target));
    return result;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
export async function writeArtifact(path: string, value: unknown) {
  const target = resolve(path);
  await ensureAbsent(target);
  const stage = await mkdtemp(join(dirname(target), ".benchmark-artifact-"));
  try {
    const temporary = join(stage, "artifact.json"),
      handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(canonicalSerialize(value));
      await handle.sync();
    } finally {
      await handle.close();
    }
    // An exclusive hard link publishes complete bytes and cannot replace an existing file.
    await link(temporary, target);
    await syncDirectory(dirname(target));
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
async function bytesHash(path: string) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Expected regular file");
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return `sha256:${hash.digest("hex")}`;
}
function publicKeyHash(pem: string) {
  return `sha256:${createHash("sha256")
    .update(createPublicKey(pem).export({ type: "spki", format: "der" }))
    .digest("hex")}`;
}
async function encrypt(
  source: string,
  destination: string,
  key: Buffer,
  name: string,
  expectedHash?: string,
): Promise<FileRecord> {
  const nonce = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(name));
  const digest = createHash("sha256");
  const hashing = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      digest.update(chunk);
      callback(null, chunk);
    },
  });
  await pipeline(
    createReadStream(source),
    hashing,
    cipher,
    createWriteStream(destination, { flags: "wx", mode: 0o600 }),
  );
  await syncFile(destination);
  const actual = `sha256:${digest.digest("hex")}`;
  if (expectedHash !== undefined && actual !== expectedHash)
    throw new Error("Media changed during encryption");
  return {
    name,
    hash: await bytesHash(destination),
    nonce: nonce.toString("hex"),
    tag: cipher.getAuthTag().toString("hex"),
  };
}
function validateInput(raw: unknown) {
  const input = inputSchema.parse(raw),
    manifest = parseCorpusManifest(input.manifest),
    gold = input.gold.map(parseGoldReference);
  const report = auditCorpus(manifest, gold, input.context);
  if (
    input.media.length !== manifest.tracks.length ||
    new Set(input.media.map((m) => m.trackId)).size !== input.media.length
  )
    throw new Error("Media inventory mismatch");
  for (const media of input.media)
    if (!manifest.tracks.find((t) => t.id === media.trackId)?.sourceHashes.includes(media.hash))
      throw new Error("Media source binding mismatch");
  return { input, manifest, gold, report };
}
export async function publishCorpus(
  raw: unknown,
  destination: string,
  custodianPublicKey: string,
  freezeAuthorityPublicKey: string,
) {
  const { input, manifest, gold, report } = validateInput(raw);
  if (report.denied.length > 0 || !report.coverageComplete)
    throw new Error("Corpus rights or coverage are insufficient");
  const custodyKey = createPublicKey(custodianPublicKey),
    authorityKey = createPublicKey(freezeAuthorityPublicKey);
  if (
    custodyKey.asymmetricKeyType !== "rsa" ||
    (custodyKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048 ||
    authorityKey.asymmetricKeyType !== "ed25519"
  )
    throw new Error("Invalid custody or freeze authority key");
  for (const media of input.media)
    if ((await bytesHash(media.path)) !== media.hash)
      throw new Error("Media bytes differ from ledger");
  const key = randomBytes(32);
  try {
    return await stageDirectory(destination, async (stage) => {
      const files: FileRecord[] = [],
        sealedMedia: z.infer<typeof sealedSchema>["media"] = [],
        calibrationMedia: { trackId: string; storageName: string; hash: string }[] = [];
      for (const [position, media] of input.media.entries()) {
        const track = manifest.tracks.find((t) => t.id === media.trackId)!;
        if (track.cohort === "sealed") {
          const name = `sealed_${position}.enc`;
          files.push(await encrypt(media.path, join(stage, name), key, name, media.hash));
          sealedMedia.push({ trackId: track.id, storageName: name, hash: media.hash });
        } else {
          const name = `audio_${position}.bin`,
            path = join(stage, name);
          await pipeline(
            createReadStream(media.path),
            createWriteStream(path, { flags: "wx", mode: 0o600 }),
          );
          await syncFile(path);
          if ((await bytesHash(path)) !== media.hash)
            throw new Error("Media changed during publication");
          files.push({ name, hash: media.hash, nonce: null, tag: null });
          calibrationMedia.push({ trackId: track.id, storageName: name, hash: media.hash });
        }
      }
      const calibrationTracks = manifest.tracks.filter((t) => t.cohort === "calibration");
      await writeArtifact(join(stage, "calibration.json"), {
        version: "1.0",
        purpose: manifest.purpose,
        tracks: calibrationTracks,
        gold: gold.filter((g) => calibrationTracks.some((t) => t.goldHashes.includes(g.hash))),
        media: calibrationMedia,
        context: input.context,
      });
      files.push({
        name: "calibration.json",
        hash: await bytesHash(join(stage, "calibration.json")),
        nonce: null,
        tag: null,
      });
      // This staging directory belongs to the custodian; tuning receives only the final bundle.
      const secretPath = join(stage, "private.json");
      await writeArtifact(secretPath, {
        input: { manifest, gold, context: input.context },
        report,
        media: sealedMedia,
      });
      files.push(await encrypt(secretPath, join(stage, "sealed.enc"), key, "sealed.enc"));
      await rm(secretPath);
      // Verify encrypted source bytes too: no changed file can become a successful publication.
      for (const media of input.media)
        if ((await bytesHash(media.path)) !== media.hash)
          throw new Error("Media changed during publication");
      const index = indexSchema.parse({
        version: "1.0",
        corpusHash: contentHash(manifest),
        authorityHash: publicKeyHash(freezeAuthorityPublicKey),
        wrappedKey: publicEncrypt({ key: custodyKey, oaepHash: "sha256" }, key).toString("base64"),
        files: files.toSorted((a, b) => (a.name < b.name ? -1 : 1)),
      });
      await writeArtifact(join(stage, "index.json"), index);
      return { bundleHash: contentHash(index), corpusHash: index.corpusHash };
    });
  } finally {
    key.fill(0);
  }
}
export async function verifyBundle(directory: string) {
  const index = indexSchema.parse(await readJson(join(directory, "index.json")));
  if (
    new Set(index.files.map((f) => f.name)).size !== index.files.length ||
    !index.files.some((f) => f.name === "sealed.enc") ||
    !index.files.some((f) => f.name === "calibration.json")
  )
    throw new Error("Invalid bundle inventory");
  for (const file of index.files) {
    const encrypted = file.name.endsWith(".enc");
    if (
      encrypted !== (file.nonce !== null && file.tag !== null) ||
      (!encrypted && (file.nonce !== null || file.tag !== null))
    )
      throw new Error("Invalid encryption record");
    if ((await bytesHash(join(directory, file.name))) !== file.hash)
      throw new Error("Bundle file hash mismatch");
  }
  return index;
}
async function decryptFile(
  directory: string,
  record: FileRecord,
  key: Buffer,
  destination: string,
) {
  if (record.nonce === null || record.tag === null) throw new Error("Expected encrypted file");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(record.nonce, "hex"));
  decipher.setAAD(Buffer.from(record.name));
  decipher.setAuthTag(Buffer.from(record.tag, "hex"));
  await pipeline(
    createReadStream(join(directory, record.name)),
    decipher,
    createWriteStream(destination, { flags: "wx", mode: 0o600 }),
  );
  await syncFile(destination);
}
export async function openSealedCorpus(
  directory: string,
  destination: string,
  policyPath: string,
  rawFreeze: unknown,
  trustedAuthorityPublicKey: string,
  custodianPrivateKey: string,
) {
  const index = await verifyBundle(directory),
    freeze = freezeSchema.parse(rawFreeze),
    declaration = freeze.declaration;
  const trustedKey = createPublicKey(trustedAuthorityPublicKey);
  if (
    trustedKey.asymmetricKeyType !== "ed25519" ||
    publicKeyHash(trustedAuthorityPublicKey) !== index.authorityHash ||
    !verify(
      null,
      Buffer.from(canonicalSerialize(declaration)),
      trustedKey,
      Buffer.from(freeze.signature, "base64"),
    )
  )
    throw new Error("Unauthenticated policy freeze");
  if (
    declaration.bundleHash !== contentHash(index) ||
    declaration.corpusHash !== index.corpusHash ||
    declaration.policyHash !== (await bytesHash(policyPath)) ||
    Date.parse(declaration.frozenAt) > Date.now()
  )
    throw new Error("Policy freeze binding mismatch");
  const key = privateDecrypt(
    { key: custodianPrivateKey, oaepHash: "sha256" },
    Buffer.from(index.wrappedKey, "base64"),
  );
  if (key.length !== 32) {
    key.fill(0);
    throw new Error("Invalid custody key");
  }
  try {
    return await stageDirectory(destination, async (stage) => {
      await decryptFile(
        directory,
        index.files.find((f) => f.name === "sealed.enc")!,
        key,
        join(stage, "sealed.json"),
      );
      const sealed = sealedSchema.parse(await readJson(join(stage, "sealed.json")));
      const manifest = parseCorpusManifest(sealed.input.manifest);
      const original = auditCorpus(manifest, sealed.input.gold, sealed.input.context);
      if (
        contentHash(manifest) !== index.corpusHash ||
        canonicalSerialize(original) !== canonicalSerialize(sealed.report)
      )
        throw new Error("Sealed corpus audit mismatch");
      const current = auditCorpus(manifest, sealed.input.gold, {
        ...sealed.input.context,
        at: new Date().toISOString(),
      });
      if (current.denied.length > 0 || !current.coverageComplete)
        throw new Error("Current corpus rights are insufficient");
      const tracks = manifest.tracks.filter((t) => t.cohort === "sealed");
      if (
        sealed.media.length !== tracks.length ||
        new Set(sealed.media.map((m) => m.trackId)).size !== tracks.length ||
        new Set(sealed.media.map((m) => m.storageName)).size !== tracks.length
      )
        throw new Error("Sealed media inventory mismatch");
      for (const media of sealed.media) {
        if (!tracks.find((t) => t.id === media.trackId)?.sourceHashes.includes(media.hash))
          throw new Error("Sealed media scope mismatch");
        const record = index.files.find((f) => f.name === media.storageName);
        if (!record) throw new Error("Missing sealed media");
        const target = join(stage, `${media.trackId}.bin`);
        await decryptFile(directory, record, key, target);
        if ((await bytesHash(target)) !== media.hash) throw new Error("Sealed media hash mismatch");
      }
      await writeArtifact(join(stage, "opening-receipt.json"), {
        version: "1.0",
        freeze,
        openedAt: new Date().toISOString(),
        currentAuditHash: current.hash,
      });
      return { bundleHash: declaration.bundleHash, policyHash: declaration.policyHash };
    });
  } finally {
    key.fill(0);
  }
}
export async function auditCorpusFiles(raw: unknown) {
  const { input, report } = validateInput(raw);
  for (const media of input.media)
    if ((await bytesHash(media.path)) !== media.hash)
      throw new Error("Media bytes differ from ledger");
  return report;
}

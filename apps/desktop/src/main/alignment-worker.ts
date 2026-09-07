import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, lstat, mkdir, writeFile, open, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { canonicalSerialize } from "@open-chords/domain";

import type { AlignmentWorker } from "./alignment-jobs.ts";
import { inspectAlignmentRuntime } from "./alignment-runtime.ts";
import { syncDirectory } from "./filesystem-durability.ts";
import type { LocalMediaService } from "./local-media.ts";
import type { ModelStore } from "./model-store.ts";
import {
  preparePackagedWorkspace,
  cleanupPackagedWorkspace,
} from "./packaged-sidecar-proof-workspace.ts";
import { verifyContainmentRuntime } from "./sidecar-containment-integrity.ts";
import { createNativeContainmentLauncher } from "./sidecar-containment-launcher.ts";
import { createExecutableNativeContainmentBroker } from "./sidecar-native-broker.ts";
import { parseSidecarSessionRequest, type SidecarProcess } from "./sidecar-protocol.ts";

type Options = {
  stateRoot: string;
  runtimeRoot: string;
  runtimeManifestHash: string;
  containmentRoot: string;
  containmentManifestHash: string;
  bridgePath?: string;
  modelStore: ModelStore;
  media: LocalMediaService;
};

export function createContainedAlignmentWorker(options: Options): AlignmentWorker {
  return async (input) => {
    if (input.recipe.runtimeManifestHash !== options.runtimeManifestHash)
      throw new Error("Exact Alignment runtime changed; request a new Job");
    if (
      !(await inspectAlignmentRuntime(options.runtimeRoot, options.runtimeManifestHash)).available
    )
      throw new Error("Alignment runtime is unavailable");
    if (process.platform !== "darwin" && process.platform !== "win32")
      throw new Error("Native Alignment runtime is unsupported");
    const signal = AbortSignal.any([input.signal, AbortSignal.timeout(30 * 60 * 1000)]);
    signal.throwIfAborted();
    const containment = verifyContainmentRuntime(
      options.containmentRoot,
      options.containmentManifestHash,
      process.platform,
      options.bridgePath,
    );
    const source = await options.media.getAnalysisSource(input.recipe.projectId);
    if (source.canonicalAudioFingerprint !== input.recipe.canonicalAudioFingerprint)
      throw new Error("Alignment Source identity changed");
    const packs = await options.modelStore.list();
    const pack = packs.find((item) => item.id === input.recipe.packId);
    if (
      !pack?.installed ||
      canonicalSerialize(
        pack.artifacts.map(({ id, version, sha256 }) => ({ id, version, sha256 })),
      ) !== canonicalSerialize(input.recipe.artifacts)
    )
      throw new Error("Exact Alignment pack is unavailable");
    const acoustic = pack.artifacts.find((item) => item.format === "zip");
    const dictionary = pack.artifacts.find((item) => item.format === "file");
    if (!acoustic || !dictionary) throw new Error("Alignment pack is incomplete");
    await input.reportStage("staging");
    const journal = await journalRoot(options.stateRoot);
    const identifier = randomUUID();
    const marker = join(journal, identifier);
    const handle = await open(marker, "wx", 0o600);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await syncDirectory(journal);
    const prepared = preparePackagedWorkspace(
      process.platform,
      containment.helperPath,
      options.runtimeRoot,
      identifier,
    );
    let processHandle: SidecarProcess | undefined;
    try {
      if (
        !(await inspectAlignmentRuntime(prepared.runtimeRoot, options.runtimeManifestHash))
          .available
      )
        throw new Error("Staged Alignment runtime is invalid");
      await mkdir(join(prepared.workspace, "temporary"), { recursive: true, mode: 0o700 });
      const dimensions = await options.media.stageAnalysisInput({
        projectId: input.recipe.projectId,
        destinationPath: join(prepared.workspace, "audio.wav"),
      });
      if (
        dimensions.durationSamples !== input.recipe.durationSamples ||
        dimensions.sampleRate !== input.recipe.sampleRate
      )
        throw new Error("Alignment audio dimensions changed");
      for (const [artifact, destination] of [
        [acoustic, "acoustic"],
        [dictionary, "dictionary.dict"],
      ] as const) {
        const sourcePath = await options.modelStore.resolve(artifact);
        if (!sourcePath) throw new Error("Exact Alignment artifact is unavailable");
        await cp(sourcePath, join(prepared.workspace, destination), {
          recursive: true,
          dereference: false,
          errorOnExist: true,
          force: false,
        });
        const files = artifact.files ?? [
          { path: "", bytes: artifact.bytes, sha256: artifact.sha256 },
        ];
        for (const file of files) {
          const path = join(prepared.workspace, destination, file.path);
          const stat = await lstat(path);
          if (
            !stat.isFile() ||
            stat.size !== file.bytes ||
            (await digestFile(path)) !== file.sha256
          )
            throw new Error("Staged Alignment artifact changed");
        }
      }
      const request = canonicalSerialize({
        recipe: input.recipe,
        recipeHash: input.recipeHash,
        document: input.document,
        audioHash: await digestFile(join(prepared.workspace, "audio.wav")),
      });
      if (Buffer.byteLength(request) > 256 * 1024)
        throw new Error("Alignment input exceeds the protocol bound");
      await writeFile(join(prepared.workspace, "request.json"), request, {
        flag: "wx",
        mode: 0o600,
      });
      signal.throwIfAborted();
      const launcher = createNativeContainmentLauncher(
        createExecutableNativeContainmentBroker({
          containment,
          platform: process.platform,
          runtimeRoot: prepared.runtimeRoot,
          workspace: prepared.workspace,
          ...(prepared.windowsProfile ? { windowsProfile: prepared.windowsProfile } : {}),
          executablePath: join(
            prepared.runtimeRoot,
            `open-chords-alignment-worker${process.platform === "win32" ? ".exe" : ""}`,
          ),
          args: ["--align", prepared.workspace],
        }),
        process.platform,
      );
      processHandle = await launcher.launch(
        parseSidecarSessionRequest({
          jobId: "alignment-worker",
          manifestHash: options.runtimeManifestHash,
          nonce: randomUUID(),
          requestId: randomUUID(),
          timeoutMs: 30 * 60 * 1000,
        }),
        signal,
      );
      await input.reportStage("aligning");
      const abort = () => {
        void processHandle?.stop("cancelled").catch(() => undefined);
      };
      signal.addEventListener("abort", abort, { once: true });
      try {
        let length = 0;
        const chunks: Buffer[] = [];
        for await (const bytes of processHandle.stdout) {
          length += bytes.byteLength;
          if (length > 2 * 1024 * 1024)
            throw new Error("Alignment output exceeds the protocol bound");
          chunks.push(Buffer.from(bytes));
        }
        signal.throwIfAborted();
        return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
      } finally {
        signal.removeEventListener("abort", abort);
      }
    } finally {
      // Cleanup is part of success: no result reaches publication before the domain is reaped.
      try {
        await input.reportStage("cleanup");
      } finally {
        await processHandle?.stop(signal.aborted ? "cancelled" : "completed");
        prepared.cleanup();
        await rm(marker);
        await syncDirectory(journal);
      }
    }
  };
}

async function journalRoot(stateRoot: string) {
  const root = join(stateRoot, "alignment-workspaces");
  await mkdir(root, { recursive: true, mode: 0o700 });
  if (!(await lstat(root)).isDirectory()) throw new Error("Invalid Alignment workspace journal");
  return root;
}

export async function recoverAlignmentWorkspaces(
  options: Pick<
    Options,
    "stateRoot" | "containmentRoot" | "containmentManifestHash" | "bridgePath"
  >,
) {
  const root = await journalRoot(options.stateRoot);
  const entries = await readdir(root);
  if (entries.length === 0) return;
  if (entries.length > 64 || (process.platform !== "darwin" && process.platform !== "win32"))
    throw new Error("Alignment cleanup is unavailable");
  const containment = verifyContainmentRuntime(
    options.containmentRoot,
    options.containmentManifestHash,
    process.platform,
    options.bridgePath,
  );
  for (const identifier of entries) {
    cleanupPackagedWorkspace(process.platform, containment.helperPath, identifier);
    await rm(join(root, identifier));
    await syncDirectory(root);
  }
}

async function digestFile(path: string) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}

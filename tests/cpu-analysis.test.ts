import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AnalysisRecipeSchema,
  AnalysisStageOutcomeSchema,
  parseAnalysisTimeline,
  type AnalysisRecipe,
} from "@open-chords/domain";
import { monoPcmWav } from "@open-chords/testkit/media";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("CPU analysis cross-language candidate", () => {
  it("validates a complete abstaining fixture through the main domain seam", () => {
    const root = mkdtempSync(join(tmpdir(), "open-chords-cpu-candidate-"));
    temporaryRoots.push(root);
    const input = join(root, "canonical.wav");
    const recipePath = join(root, "recipe.json");
    writeFileSync(input, monoPcmWav(Array.from({ length: 48_000 }, () => 0)));
    writeFileSync(recipePath, JSON.stringify(recipe));
    const python =
      process.env.OPEN_CHORDS_PYTHON ?? (process.platform === "win32" ? "python" : "python3");

    const emitted = spawnSync(
      python,
      ["tools/emit-cpu-analysis.py", "--input", input, "--recipe", recipePath],
      { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, PYTHONHASHSEED: "0" } },
    );

    if (emitted.status !== 0) throw new Error(emitted.stderr);
    const document = z
      .strictObject({
        durationSamples: z.number().int().positive(),
        recipe: AnalysisRecipeSchema,
        sampleRate: z.literal(48_000),
        stageOutcomes: z.array(AnalysisStageOutcomeSchema),
        supportClaimIds: z.array(z.string()),
        timeline: z.unknown(),
        warnings: z.array(z.string()),
      })
      .parse(JSON.parse(emitted.stdout));
    const timeline = parseAnalysisTimeline(document.timeline, document.durationSamples);

    expect(timeline.chordEvents).toMatchObject([
      { assertion: { state: "abstained" }, value: { kind: "no_chord" } },
    ]);
    expect(document.supportClaimIds).toEqual([]);
    expect(document.recipe).toEqual(recipe);
    expect(document.stageOutcomes.map(({ stage }) => stage)).toEqual([
      "shared_features",
      "rhythm",
      "harmony",
      "sections",
      "assemble",
    ]);
  });

  it("validates tonal rhythm and harmony through timeline invariants", () => {
    const root = mkdtempSync(join(tmpdir(), "open-chords-cpu-tonal-candidate-"));
    temporaryRoots.push(root);
    const input = join(root, "canonical.wav");
    const recipePath = join(root, "recipe.json");
    const sampleRate = 48_000;
    writeFileSync(
      input,
      monoPcmWav(
        Array.from({ length: 8 * sampleRate }, (_value, index) => {
          const chord =
            0.25 * Math.sin((2 * Math.PI * 261.625565 * index) / sampleRate) +
            0.1 * Math.sin((2 * Math.PI * 329.627557 * index) / sampleRate) +
            0.1 * Math.sin((2 * Math.PI * 391.995436 * index) / sampleRate);
          const withinBeat = index % (sampleRate / 2);
          const click = withinBeat < 240 ? 0.65 * (1 - withinBeat / 240) : 0;
          return Math.round(Math.max(-1, Math.min(1, chord + click)) * 30_000);
        }),
      ),
    );
    writeFileSync(recipePath, JSON.stringify(recipe));

    const document = emitCandidate(input, recipePath);
    const timeline = parseAnalysisTimeline(document.timeline, document.durationSamples);

    expect(timeline.bars.length).toBeGreaterThan(0);
    expect(timeline.chordEvents[0]).toMatchObject({
      assertion: { state: "low_confidence" },
      value: { kind: "chord", quality: "major", root: "C" },
    });
    expect(timeline.keyRegions[0]).toMatchObject({
      assertion: { state: "low_confidence" },
      value: { kind: "key", mode: "major", tonic: "C" },
    });
  });

  it("keeps the frozen dependency closure weight-free and GPU-optional", () => {
    const requirements = readFileSync("sidecar/requirements-build.txt", "utf8");

    expect(requirements).toContain("librosa==0.11.0");
    expect(requirements).not.toMatch(/^(?:torch|tensorflow|cupy|onnxruntime)==/mu);
  });
});

function emitCandidate(input: string, recipePath: string) {
  const python =
    process.env.OPEN_CHORDS_PYTHON ?? (process.platform === "win32" ? "python" : "python3");
  const emitted = spawnSync(
    python,
    ["tools/emit-cpu-analysis.py", "--input", input, "--recipe", recipePath],
    { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, PYTHONHASHSEED: "0" } },
  );
  if (emitted.status !== 0) throw new Error(emitted.stderr);
  return z
    .strictObject({
      durationSamples: z.number().int().positive(),
      recipe: AnalysisRecipeSchema,
      sampleRate: z.literal(48_000),
      stageOutcomes: z.array(AnalysisStageOutcomeSchema),
      supportClaimIds: z.array(z.string()),
      timeline: z.unknown(),
      warnings: z.array(z.string()),
    })
    .parse(JSON.parse(emitted.stdout));
}

const recipe: AnalysisRecipe = {
  capabilities: ["rhythm", "meter", "key", "chords", "sections"],
  components: [
    {
      hash: `sha256:${"1".repeat(64)}`,
      id: "open-chords-cpu-dsp",
      version: "1.0.0",
    },
  ],
  numericalBackend: {
    hash: `sha256:${"2".repeat(64)}`,
    id: "numpy",
    version: "2.5.2",
  },
  pipeline: [
    "preflight",
    "canonical_decode",
    "shared_features",
    "rhythm",
    "harmony",
    "sections",
    "assemble",
    "main_validation",
    "publish",
  ],
  profile: {
    hash: `sha256:${"3".repeat(64)}`,
    id: "balanced",
    name: "balanced",
    version: "1.0.0",
  },
  seeds: { decoder: 0 },
  settings: { analysisWindowSamples: 96_000, hopLength: 1_024, nFft: 8_192 },
};

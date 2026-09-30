import { z } from "zod";

import { median, type CalibrationCell } from "./metrics.ts";

export const UncertaintySchema = z.strictObject({
  method: z.literal("paired_percentile_bootstrap"),
  confidence: z.number().gt(0.5).lt(1),
  resamples: z.number().int().min(100).max(100000),
  seed: z.number().int().min(0).max(0xffffffff),
  minTracks: z.number().int().min(2),
});
export type Uncertainty = z.infer<typeof UncertaintySchema>;

function generator(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;

export function trackInterval(values: number[], uncertainty: Uncertainty) {
  const random = generator(uncertainty.seed);
  const means = Array.from({ length: uncertainty.resamples }, () => {
    let sum = 0;
    for (let index = 0; index < values.length; index++)
      sum += values[Math.floor(random() * values.length)]!;
    return sum / values.length;
  }).sort((a, b) => a - b);
  const rank = (quantile: number) => means[Math.floor(quantile * (means.length - 1))]!;
  return { lower: rank(1 - uncertainty.confidence), upper: rank(uncertainty.confidence) };
}

export function summarize(values: number[], pooled: [number, number][], uncertainty: Uncertainty) {
  if (values.length === 0) return null;
  const numerator = pooled.reduce((sum, [value]) => sum + value, 0),
    denominator = pooled.reduce((sum, [, value]) => sum + value, 0);
  return {
    mean: mean(values),
    pooled: pooled.length === values.length && denominator > 0 ? numerator / denominator : null,
    min: Math.min(...values),
    median: median(values),
    max: Math.max(...values),
    ...(values.length >= uncertainty.minTracks
      ? trackInterval(values, uncertainty)
      : { lower: null, upper: null }),
  };
}

export function reliability(cells: CalibrationCell[], edges: number[], totalSamples: number) {
  const bins = edges.slice(1).map((upper, index) => {
    const lower = edges[index]!;
    const members = cells.filter(
      (cell) => cell.confidence >= lower && (cell.confidence < upper || upper === 1),
    );
    const samples = members.reduce((sum, cell) => sum + cell.samples, 0);
    return {
      lower,
      upper,
      samples,
      meanConfidence:
        samples === 0
          ? null
          : members.reduce((sum, c) => sum + c.confidence * c.samples, 0) / samples,
      accuracy:
        samples === 0
          ? null
          : members.reduce((sum, c) => sum + (c.correct ? c.samples : 0), 0) / samples,
    };
  });
  const riskCoverage = edges.map((threshold) => {
    const kept = cells.filter((cell) => cell.confidence >= threshold);
    const samples = kept.reduce((sum, cell) => sum + cell.samples, 0);
    return {
      threshold,
      coverage: totalSamples === 0 ? null : samples / totalSamples,
      risk:
        samples === 0
          ? null
          : kept.reduce((sum, c) => sum + (c.correct ? 0 : c.samples), 0) / samples,
    };
  });
  return { bins, riskCoverage };
}

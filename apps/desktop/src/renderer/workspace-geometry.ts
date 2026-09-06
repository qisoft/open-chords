/** One coordinate system for painting, click seeking, and fixed-playhead scrubbing. */
export function createTimelineGeometry(
  durationSamples: number,
  viewportWidth: number,
  zoom: number,
) {
  const pixelsPerSample = (Math.max(1, viewportWidth) * Math.max(1, zoom)) / durationSamples;
  const bound = (sample: number) => Math.max(0, Math.min(durationSamples, Math.round(sample)));
  return {
    trackWidth: durationSamples * pixelsPerSample,
    widthOf: (startSample: number, endSample: number) =>
      (endSample - startSample) * pixelsPerSample,
    xAt: (sample: number, position: number) =>
      viewportWidth / 2 + (sample - position) * pixelsPerSample,
    sampleAt: (x: number, position: number) =>
      bound(position + (x - viewportWidth / 2) / pixelsPerSample),
    scrub: (startPosition: number, deltaPixels: number) =>
      bound(startPosition - deltaPixels / pixelsPerSample),
  };
}

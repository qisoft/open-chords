export function monoPcmWav(samples: readonly number[], sampleRate = 48_000): Buffer {
  const bytesPerSample = 2;
  const dataSize = samples.length * bytesPerSample;
  const wav = Buffer.alloc(44 + dataSize);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(36 + dataSize, 4);
  wav.write("WAVE", 8, "ascii");
  wav.write("fmt ", 12, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * bytesPerSample, 28);
  wav.writeUInt16LE(bytesPerSample, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(dataSize, 40);
  samples.forEach((sample, index) => wav.writeInt16LE(sample, 44 + index * bytesPerSample));
  return wav;
}

const MAX_FRAME_BYTES = 1024 * 1024;
let buffered = Buffer.alloc(0);

function write(message) {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  const frame = Buffer.allocUnsafe(payload.length + 4);
  frame.writeUInt32BE(payload.length, 0);
  payload.copy(frame, 4);
  process.stdout.write(frame);
}

process.stdin.on("data", (chunk) => {
  buffered = Buffer.concat([buffered, chunk]);
  while (buffered.length >= 4) {
    const length = buffered.readUInt32BE(0);
    if (length > MAX_FRAME_BYTES) process.exit(2);
    if (buffered.length < length + 4) return;
    const message = JSON.parse(buffered.subarray(4, length + 4).toString("utf8"));
    buffered = buffered.subarray(length + 4);
    if (message.type !== "start") continue;
    write({
      capabilities: ["analysis"],
      manifestHash: message.manifestHash,
      nonce: message.nonce,
      protocolVersion: 1,
      sequence: 0,
      type: "handshake",
    });
    write({
      artifact: { byteSize: 42, path: "result.json", sha256: "b".repeat(64) },
      jobId: message.jobId,
      nonce: message.nonce,
      requestId: message.requestId,
      sequence: 1,
      type: "result",
    });
  }
});

setInterval(() => undefined, 1_000);

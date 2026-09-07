"""One bounded session using the shared desktop sidecar wire protocol."""
import hashlib
import json
import struct
import sys
import threading
from pathlib import Path
from queue import Empty, Queue

LIMIT = 1024 * 1024


def read_frame():
    header = sys.stdin.buffer.read(4)
    if len(header) != 4:
        raise ValueError("Invalid frame header")
    size = struct.unpack(">I", header)[0]
    if not 0 < size <= LIMIT:
        raise ValueError("Invalid frame size")
    body = sys.stdin.buffer.read(size)
    if len(body) != size:
        raise ValueError("Truncated frame")
    return json.loads(body)


def write_frame(message):
    body = json.dumps(message, ensure_ascii=True, allow_nan=False).encode("utf8")
    if len(body) > LIMIT:
        raise ValueError("Oversized frame")
    sys.stdout.buffer.write(struct.pack(">I", len(body)) + body)
    sys.stdout.buffer.flush()


def serve():
    start = read_frame()
    if set(start) != {"type", "sequence", "jobId", "requestId", "nonce", "manifestHash"} or start["type"] != "start" or start["sequence"] != 0:
        raise ValueError("Invalid start")
    if any(not isinstance(start[key], str) or not 0 < len(start[key].encode("utf8")) <= 256 for key in ("jobId", "requestId", "nonce")):
        raise ValueError("Invalid identity")
    manifest = Path(sys.executable).parent / "runtime-info.json"
    with manifest.open("rb") as source:
        digest = hashlib.file_digest(source, "sha256").hexdigest()
    write_frame({"type": "handshake", "sequence": 0, "protocolVersion": 1, "nonce": start["nonce"], "manifestHash": digest, "capabilities": ["analysis", "lyrics_alignment"]})
    if digest != start["manifestHash"]:
        return
    events = Queue(maxsize=4)
    cancelled = threading.Event()
    invalid_control = threading.Event()
    identity = {key: start[key] for key in ("jobId", "nonce", "requestId")}

    def control():
        try:
            message = read_frame()
            if set(message) != {"type", "sequence", *identity} or message["type"] != "cancel" or type(message["sequence"]) is not int or not 1 <= message["sequence"] <= 2**53 - 1 or any(message[key] != value for key, value in identity.items()):
                raise ValueError("Invalid cancel")
            events.put(("cancel", message["sequence"]))
        except Exception:
            invalid_control.set()
            cancelled.set()
            events.put(("control_error", None))

    def execute():
        try:
            from worker import align
            result = align(cancelled)
            if cancelled.is_set():
                events.put(("finished", None))
                return
            encoded = json.dumps(result, ensure_ascii=True, allow_nan=False).encode("utf8")
            if len(encoded) > 2 * LIMIT:
                raise ValueError("Oversized result")
            path = Path("alignment-result.json")
            with path.open("xb") as target:
                target.write(encoded)
            events.put(("result", {"path": str(path), "byteSize": len(encoded), "sha256": hashlib.sha256(encoded).hexdigest()}))
        except Exception:
            events.put(("finished" if cancelled.is_set() else "failure", None))

    sequence = 1
    acknowledged = False
    threading.Thread(target=control, daemon=True).start()
    threading.Thread(target=execute, daemon=True).start()
    while True:
        try:
            kind, payload = events.get(timeout=5)
        except Empty:
            write_frame({"type": "heartbeat", "sequence": sequence, "nonce": start["nonce"]})
            sequence += 1
            continue
        if kind == "control_error":
            # Wait for the executing thread, then report a terminal protocol
            # error rather than acknowledging an invalid cancellation frame.
            continue
        if kind == "cancel":
            cancelled.set()
            if payload > sequence:
                invalid_control.set()
                continue
            write_frame({**identity, "type": "cancel_ack", "sequence": sequence})
            sequence += 1
            acknowledged = True
            continue
        if cancelled.is_set():
            if invalid_control.is_set():
                write_frame({**identity, "type": "error", "sequence": sequence, "code": "alignment_control_failed", "message": "Alignment control failed safely"})
                return
            if not acknowledged:
                write_frame({**identity, "type": "cancel_ack", "sequence": sequence})
                sequence += 1
            write_frame({**identity, "type": "cleanup_complete", "sequence": sequence})
            return
        if kind == "result":
            write_frame({**identity, "type": "result", "sequence": sequence, "artifact": payload})
        else:
            write_frame({**identity, "type": "error", "sequence": sequence, "code": "alignment_failed", "message": "Alignment execution failed safely"})
        return

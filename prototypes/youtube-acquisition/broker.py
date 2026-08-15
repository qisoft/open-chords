"""PROTOTYPE: app-owned HTTPS broker and extractor-worker supervisor."""

from __future__ import annotations

import base64
import http.client
import json
import os
from pathlib import Path
import shutil
import socket
import ssl
import subprocess
import sys
import tempfile
import threading
from typing import BinaryIO
from urllib.parse import urljoin, urlsplit

from policy import EndpointPolicy, ProvisionalBudget, resolve_global_addresses
from protocol import read_frame, write_frame


REDIRECT_STATUSES = {301, 302, 303, 307, 308}
FORBIDDEN_REQUEST_HEADERS = {
    "authorization", "cookie", "host", "proxy-authorization", "proxy-connection",
    "connection", "keep-alive", "te", "trailer", "transfer-encoding", "upgrade",
}


class BrokerFailure(RuntimeError):
    pass


class NetworkBroker:
    def __init__(self, policy: EndpointPolicy, budget: ProvisionalBudget):
        self.policy = policy
        self.budget = budget
        self.requests = 0
        self.redirects = 0
        self.total_bytes = 0
        self.streams: dict[str, tuple[http.client.HTTPSConnection, http.client.HTTPResponse, int]] = {}
        self.trace: list[dict[str, object]] = []
        self._next_stream = 1

    def _headers(self, values: dict[str, str]) -> dict[str, str]:
        result: dict[str, str] = {}
        for name, value in values.items():
            lowered = name.lower().strip()
            if lowered in FORBIDDEN_REQUEST_HEADERS:
                continue
            if len(name) > 80 or len(value) > 8192 or "\r" in value or "\n" in value:
                raise BrokerFailure("invalid_header")
            result[name] = value
        result["Accept-Encoding"] = "identity"
        return result

    def _connect(self, url: str, method: str, headers: dict[str, str], body: bytes | None):
        decision = self.policy.validate_url(url)
        host = str(decision["host"])
        addresses = resolve_global_addresses(host)
        address = addresses[0]
        parsed = urlsplit(url)
        context = ssl.create_default_context()
        connection = http.client.HTTPSConnection(
            host, 443, timeout=self.budget.socket_timeout_seconds, context=context
        )

        def pinned_create_connection(*_args, **_kwargs):
            return socket.create_connection(
                (address, 443), timeout=self.budget.socket_timeout_seconds
            )

        connection._create_connection = pinned_create_connection  # type: ignore[attr-defined]
        target = parsed.path or "/"
        if parsed.query:
            target += f"?{parsed.query}"
        connection.request(method, target, body=body, headers=headers)
        response = connection.getresponse()
        self.trace.append({
            "category": decision["category"],
            "host": host,
            "ip_family": "ipv6" if ":" in address else "ipv4",
            "method": method,
            "status": response.status,
        })
        return connection, response

    def open(self, message: dict[str, object]) -> dict[str, object]:
        method = str(message.get("method", "GET")).upper()
        if method not in {"GET", "HEAD", "POST"}:
            raise BrokerFailure("method_forbidden")
        url = str(message["url"])
        raw_headers = message.get("headers") or {}
        if not isinstance(raw_headers, dict):
            raise BrokerFailure("headers_must_be_object")
        headers = self._headers({str(k): str(v) for k, v in raw_headers.items()})
        body_b64 = message.get("body_b64")
        body = base64.b64decode(str(body_b64), validate=True) if body_b64 else None
        if body and len(body) > self.budget.max_request_body_bytes:
            raise BrokerFailure("request_body_budget_exceeded")

        for hop in range(self.budget.max_redirects + 1):
            self.requests += 1
            if self.requests > self.budget.max_requests:
                raise BrokerFailure("request_count_budget_exceeded")
            connection, response = self._connect(url, method, headers, body)
            if response.status not in REDIRECT_STATUSES:
                stream_id = str(self._next_stream)
                self._next_stream += 1
                self.streams[stream_id] = (connection, response, 0)
                response_headers = {
                    name: value for name, value in response.getheaders()
                    if name.lower() not in {"set-cookie", "proxy-authenticate"}
                }
                return {
                    "stream_id": stream_id,
                    "url": url,
                    "status": response.status,
                    "reason": response.reason,
                    "headers": response_headers,
                    "redirect_hops": hop,
                }
            location = response.getheader("Location")
            response.read()
            connection.close()
            if not location:
                raise BrokerFailure("redirect_without_location")
            self.redirects += 1
            if self.redirects > self.budget.max_redirects:
                raise BrokerFailure("redirect_budget_exceeded")
            url = urljoin(url, location)
            self.policy.validate_url(url)
            if response.status == 303 or (response.status in {301, 302} and method == "POST"):
                method, body = "GET", None
        raise BrokerFailure("redirect_budget_exceeded")

    def read(self, stream_id: str, amount: int) -> dict[str, object]:
        if stream_id not in self.streams:
            raise BrokerFailure("unknown_stream")
        connection, response, response_bytes = self.streams[stream_id]
        amount = max(1, min(amount, self.budget.max_read_chunk_bytes))
        data = response.read(amount)
        response_bytes += len(data)
        self.total_bytes += len(data)
        if response_bytes > self.budget.max_response_bytes:
            raise BrokerFailure("response_byte_budget_exceeded")
        if self.total_bytes > self.budget.max_total_bytes:
            raise BrokerFailure("total_byte_budget_exceeded")
        self.streams[stream_id] = (connection, response, response_bytes)
        if not data:
            self.close_stream(stream_id)
        return {"data_b64": base64.b64encode(data).decode("ascii"), "eof": not data}

    def close_stream(self, stream_id: str) -> None:
        item = self.streams.pop(stream_id, None)
        if item:
            connection, response, _ = item
            response.close()
            connection.close()

    def close(self) -> None:
        for stream_id in list(self.streams):
            self.close_stream(stream_id)


def _drain_stderr(stream: BinaryIO, lines: list[str]) -> None:
    for raw in iter(stream.readline, b""):
        lines.append(raw.decode("utf-8", "replace").rstrip())


def run_worker(mode: str, video_id: str | None = None) -> dict[str, object]:
    root = Path(__file__).resolve().parent
    policy = EndpointPolicy()
    budget = ProvisionalBudget()
    broker = NetworkBroker(policy, budget)
    stderr_lines: list[str] = []
    workspace_path: Path | None = None
    with tempfile.TemporaryDirectory(prefix="open-chords-acquisition-prototype-") as workspace:
        workspace_path = Path(workspace)
        command = [sys.executable, str(root / "worker.py"), mode, workspace]
        if video_id:
            command.append(video_id)
        worker_env = {
            "PATH": str(Path(sys.executable).parent),
            "PYTHONUNBUFFERED": "1",
            "YTDLP_NO_PLUGINS": "1",
            "HOME": workspace,
            "TMPDIR": workspace,
            "TEMP": workspace,
            "TMP": workspace,
        }
        for name in ("SYSTEMROOT", "WINDIR", "COMSPEC"):
            if value := os.environ.get(name):
                worker_env[name] = value
        process = subprocess.Popen(
            command,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=workspace,
            env=worker_env,
        )
        assert process.stdin and process.stdout and process.stderr
        stderr_thread = threading.Thread(
            target=_drain_stderr, args=(process.stderr, stderr_lines), daemon=True
        )
        stderr_thread.start()
        result: dict[str, object] | None = None
        try:
            while True:
                message = read_frame(process.stdout)
                if message is None:
                    break
                op = message.get("op")
                if op == "result":
                    result = dict(message.get("value") or {})
                    break
                if op == "event":
                    continue
                request_id = message.get("request_id")
                try:
                    if op == "open":
                        value = broker.open(message)
                    elif op == "read":
                        value = broker.read(str(message["stream_id"]), int(message.get("amount", 65536)))
                    elif op == "close":
                        broker.close_stream(str(message["stream_id"]))
                        value = {}
                    else:
                        raise BrokerFailure("unknown_operation")
                    response = {"request_id": request_id, "ok": True, "value": value}
                except Exception as exc:
                    response = {"request_id": request_id, "ok": False, "error": str(exc)}
                write_frame(process.stdin, response)
        finally:
            broker.close()
            if process.stdin:
                process.stdin.close()
            try:
                return_code = process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                return_code = process.wait(timeout=5)
            stderr_thread.join(timeout=1)
        if result is None:
            result = {"ok": False, "error": "worker_exited_without_result"}
        result.update({
            "worker_exit_code": return_code,
            "broker": {
                "policy_version": policy.version,
                "budget": budget.to_dict(),
                "requests": broker.requests,
                "redirects": broker.redirects,
                "bytes": broker.total_bytes,
                "open_streams_after_exit": len(broker.streams),
                "trace": broker.trace,
            },
            "stderr_tail": stderr_lines[-12:],
        })
    assert workspace_path is not None
    result["workspace_removed"] = not workspace_path.exists()
    return result

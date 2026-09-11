"""Pinned Extractor Worker. Native containment is required by the launcher."""
from __future__ import annotations

import base64
import functools
import errno
import socket
import subprocess
import hashlib
import io
import json
import os
import re
import struct
import sys
from importlib.metadata import version
from pathlib import Path

if len(sys.argv) > 1 and sys.argv[1].startswith("--contained-workspace="):
    workspace = Path(sys.argv.pop(1).split("=", 1)[1])
    if not workspace.is_absolute():
        raise SystemExit(64)
    os.chdir(workspace)
os.environ["YTDLP_NO_PLUGINS"] = "1"
os.environ["DENO_DIR"] = str(Path.cwd() / "temporary" / "deno")

from yt_dlp import YoutubeDL
from yt_dlp.downloader.http import HttpFD
from yt_dlp.extractor.youtube import YoutubeIE
from yt_dlp.globals import plugin_dirs
from yt_dlp.networking import Request, RequestDirector, RequestHandler, Response
from yt_dlp.networking.exceptions import HTTPError, RequestError, TransportError
from yt_dlp.utils import DownloadError

plugin_dirs.value = []
MAX_FRAME = 1024 * 1024
MAX_READ = 256 * 1024


def read_frame():
    prefix = sys.stdin.buffer.read(4)
    if len(prefix) != 4:
        raise ValueError("protocol_violation")
    length = struct.unpack(">I", prefix)[0]
    if not 0 < length <= MAX_FRAME:
        raise ValueError("protocol_violation")
    payload = sys.stdin.buffer.read(length)
    if len(payload) != length:
        raise ValueError("protocol_violation")
    return json.loads(payload)


def write_frame(message):
    payload = json.dumps(message, separators=(",", ":")).encode("utf8")
    if len(payload) > MAX_FRAME:
        raise ValueError("protocol_violation")
    sys.stdout.buffer.write(struct.pack(">I", len(payload)) + payload)
    sys.stdout.buffer.flush()


class Client:
    def __init__(self, nonce):
        self.nonce = nonce
        self.sequence = 0

    def emit(self, op, **payload):
        sequence = self.sequence
        self.sequence += 1
        write_frame({"op": op, "nonce": self.nonce, "sequence": sequence, **payload})
        return sequence

    def call(self, op, **payload):
        sequence = self.emit(op, **payload)
        response = read_frame()
        if response.get("nonce") != self.nonce or response.get("sequence") != sequence:
            raise RequestError("broker_rejected")
        if response.get("ok") is not True:
            if response.get("error") == "network_unavailable":
                raise TransportError("network_unavailable")
            raise RequestError("broker_rejected")
        if not isinstance(response.get("value"), dict):
            raise RequestError("protocol_violation")
        return response["value"]


class BrokerStream(io.RawIOBase):
    def __init__(self, client, stream, eof=False):
        self.client, self.stream, self.done = client, stream, eof

    def readable(self):
        return True

    def read(self, size=-1):
        if self.done or size == 0:
            return b""
        if size is None or size < 0:
            chunks, total = [], 0
            while not self.done:
                chunk = self.read(MAX_READ)
                total += len(chunk)
                if total > 16 * 1024 * 1024:
                    raise RequestError("response_too_large")
                chunks.append(chunk)
            return b"".join(chunks)
        try:
            value = self.client.call("read", stream=self.stream, amount=min(size, MAX_READ))
        except TransportError:
            self.done = True
            raise
        data = base64.b64decode(value["data"], validate=True)
        if len(data) > min(size, MAX_READ) or (not data and not value["eof"]):
            raise RequestError("protocol_violation")
        self.done = value["eof"]
        return data

    def close(self):
        if not self.closed and not self.done:
            self.client.call("close", stream=self.stream)
        self.done = True
        super().close()


class BrokerRH(RequestHandler):
    _SUPPORTED_URL_SCHEMES = ("https",)
    _SUPPORTED_PROXY_SCHEMES = None
    _SUPPORTED_FEATURES = None

    def __init__(self, *, client, **kwargs):
        self.client = client
        super().__init__(**kwargs)

    def _check_proxies(self, proxies):
        if any(value not in (None, "", "__noproxy__") for value in proxies.values()):
            raise RequestError("proxy_forbidden")

    def _check_extensions(self, extensions):
        for key in ("cookiejar", "timeout", "keep_header_casing"):
            extensions.pop(key, None)

    def _send(self, request):
        body = request.data
        if body is not None and (not isinstance(body, bytes) or len(body) > 512 * 1024):
            raise RequestError("request_body_denied")
        payload = {"url": request.url, "method": request.method, "headers": dict(self._get_headers(request))}
        if body is not None:
            payload["body"] = base64.b64encode(body).decode("ascii")
        value = self.client.call("open", **payload)
        response = Response(BrokerStream(self.client, value["stream"], value["eof"]), url=value["url"], status=value["status"], headers=value["headers"])
        if response.status >= 400:
            raise HTTPError(response)
        return response


class SilentLogger:
    def debug(self, *_args, **_kwargs): pass
    def warning(self, *_args, **_kwargs): pass
    def error(self, *_args, **_kwargs): pass


class BrokeredYoutubeDL(YoutubeDL):
    def __init__(self, client, params):
        self.client = client
        super().__init__(params, auto_init=False)
        self.add_info_extractor(YoutubeIE())

    @functools.cached_property
    def _request_director(self):
        director = RequestDirector(logger=self)
        director.add_handler(BrokerRH(client=self.client, logger=self, headers=self.params["http_headers"], cookiejar=self.cookiejar, proxies={}, timeout=20, verify=True))
        return director


def parameters():
    deno = Path(sys.executable).parent / ("deno.exe" if os.name == "nt" else "deno")
    if not deno.is_file():
        raise ValueError("pinned_runtime_missing")
    return {
        "quiet": True, "no_warnings": True, "logger": SilentLogger(), "noprogress": True,
        "proxy": "", "socket_timeout": 20, "retries": 2, "extractor_retries": 2,
        "noplaylist": True, "allowed_extractors": ["youtube"], "cachedir": False,
        "js_runtimes": {"deno": {"path": str(deno)}}, "remote_components": set(),
        "extractor_args": {"youtube": {"player_client": ["web"], "player_skip": ["configs", "initial_data"], "skip": ["hls", "dash"]}, "youtube-ejs": {"jitless": ["true"]}},
        "postprocessors": [], "external_downloader": None, "enable_file_urls": False,
        "writesubtitles": False, "writeautomaticsub": False, "writethumbnail": False,
        "writeinfojson": False, "getcomments": False, "max_filesize": 256 * 1024 * 1024,
        "outtmpl": {"default": str(Path.cwd() / "media.bin")},
    }


def transport_proof(ydl, video_id):
    # Release-owned protocol proof. It does not claim real YouTube extraction.
    with ydl.urlopen(Request(f"https://www.youtube.com/watch?v={video_id}")) as response:
        fixture = json.loads(response.read())
    downloader = HttpFD(ydl, {**ydl.params, "continuedl": True})
    if not downloader.real_download("media.bin", {"url": fixture["url"], "ext": "m4a", "protocol": "https"}):
        raise ValueError("transfer_failed")


def acquire(ydl, video_id):
    info = ydl.extract_info(f"https://www.youtube.com/watch?v={video_id}", download=False, ie_key="Youtube")
    if not isinstance(info, dict) or info.get("id") != video_id or info.get("_type", "video") != "video" or info.get("is_live") or info.get("live_status") in ("is_live", "post_live", "is_upcoming"):
        raise ValueError("unsupported_delivery")
    eligible = [item for item in reversed(info.get("formats") or []) if item.get("protocol") == "https" and not item.get("manifest_url") and not item.get("fragments") and not item.get("has_drm") and item.get("acodec") not in (None, "none") and not item.get("is_from_start")]
    audio = [item for item in eligible if item.get("vcodec") == "none"]
    combined = [item for item in eligible if item.get("vcodec") not in (None, "none")]
    if not (audio or combined):
        raise ValueError("unsupported_delivery")
    selected = (audio or combined)[0]
    # Invoke only the built-in progressive HTTP downloader. No downloader selection,
    # external command, merger or postprocessor can be selected by provider data.
    downloader = HttpFD(ydl, {**ydl.params, "continuedl": True})
    if not downloader.real_download("media.bin", {"url": selected["url"], "ext": selected["ext"], "protocol": "https", "http_headers": selected.get("http_headers", {})}):
        raise ValueError("transfer_failed")
    return {"container": "mp4" if selected["ext"] in ("mp4", "m4a") else "webm", "audioCodec": selected["acodec"], "mimeType": "audio/mp4" if selected["ext"] == "m4a" else "video/webm" if selected["ext"] == "webm" else "video/mp4", "providerFormatId": selected["format_id"]}


def native_network_proof():
    denied = False
    try:
        with socket.create_connection(("1.1.1.1", 443), timeout=2):
            pass
    except OSError as error:
        denied = error.errno in (errno.EPERM, errno.EACCES, 10013)
    deno = Path(sys.executable).parent / ("deno.exe" if os.name == "nt" else "deno")
    result = subprocess.run([str(deno), "run", "--allow-net", "--no-prompt", "--no-config", "--no-remote", "--no-npm", "--cached-only", "--v8-flags=--jitless", "-"], input='try { const c = await Deno.connect({hostname:"1.1.1.1",port:443}); c.close(); console.log(false); } catch(e) { console.log(e.name === "PermissionDenied"); }', text=True, capture_output=True, timeout=10)
    return {"workerNetworkDenied": denied, "helperNetworkDenied": result.returncode == 0 and result.stdout.strip() == "true"}


def main():
    if sys.argv[1:] not in (["--transport-proof"], ["--containment-proof"], ["--acquire"]):
        return 64
    proof = sys.argv[1:] != ["--acquire"]
    containment = sys.argv[1:] == ["--containment-proof"]
    start = read_frame()
    if set(start) != {"op", "nonce", "videoId", "protocol"} or start["op"] != "start" or start["protocol"] != 1 or not re.fullmatch(r"[a-zA-Z0-9_-]{11}", start["videoId"]) or not re.fullmatch(r"[0-9a-f-]{36}", start["nonce"]):
        return 64
    client = Client(start["nonce"])
    try:
        if version("yt-dlp") != "2026.7.4" or version("yt-dlp-ejs") != "0.8.0":
            raise ValueError("component_mismatch")
        selected_format = None
        with BrokeredYoutubeDL(client, parameters()) as ydl:
            if list(ydl._ies) != ["Youtube"] or list(ydl._request_director.handlers) != ["Broker"] or plugin_dirs.value:
                raise ValueError("configuration_mismatch")
            client.emit("ready", extractor="Youtube", handler="BrokerRH", ytDlp="2026.07.04", ejs="0.8.0", proof=proof)
            if proof:
                transport_proof(ydl, start["videoId"])
            else:
                selected_format = acquire(ydl, start["videoId"])
        artifact = Path("media.bin")
        digest = hashlib.sha256()
        with artifact.open("rb") as stream:
            for chunk in iter(lambda: stream.read(MAX_READ), b""):
                digest.update(chunk)
        extra = {"containment": native_network_proof()} if containment else {}
        if selected_format is not None:
            extra["format"] = selected_format
        client.emit("result", proof=proof, artifact={"path": "media.bin", "bytes": artifact.stat().st_size, "sha256": digest.hexdigest()}, **extra)
        return 0
    except Exception as error:
        reason = "worker_failed"
        if isinstance(error, DownloadError):
            description = str(error).lower()
            reason = "bot_check" if "not a bot" in description or "captcha" in description else "provider_unavailable"
        elif isinstance(error, ValueError) and str(error) == "unsupported_delivery":
            reason = "unsupported_delivery"
        client.emit("failure", reason=reason)
        return 70


if __name__ == "__main__":
    raise SystemExit(main())

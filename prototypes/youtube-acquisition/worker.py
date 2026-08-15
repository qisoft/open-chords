"""PROTOTYPE: yt-dlp Extractor Worker with broker-only request handling."""

from __future__ import annotations

import base64
import functools
import io
import os
from pathlib import Path
import socket
import sys
from typing import Any

os.environ["YTDLP_NO_PLUGINS"] = "1"

from protocol import read_frame, write_frame  # noqa: E402
from policy import canonical_video_url  # noqa: E402
from yt_dlp import YoutubeDL, version as yt_dlp_version  # noqa: E402
from yt_dlp.extractor.youtube import YoutubeIE  # noqa: E402
from yt_dlp.globals import plugin_dirs  # noqa: E402
from yt_dlp.networking import RequestDirector, RequestHandler, Response  # noqa: E402
from yt_dlp.networking.exceptions import HTTPError, RequestError  # noqa: E402


plugin_dirs.value = []


class BrokerClient:
    def __init__(self):
        self.reader = sys.stdin.buffer
        self.writer = sys.stdout.buffer
        self.next_id = 1

    def call(self, op: str, **payload: Any) -> dict[str, Any]:
        request_id = self.next_id
        self.next_id += 1
        write_frame(self.writer, {"op": op, "request_id": request_id, **payload})
        response = read_frame(self.reader)
        if response is None or response.get("request_id") != request_id:
            raise RequestError("broker_protocol_mismatch")
        if not response.get("ok"):
            raise RequestError(f"broker_rejected:{response.get('error', 'unknown')}")
        value = response.get("value") or {}
        if not isinstance(value, dict):
            raise RequestError("broker_response_not_object")
        return value

    def result(self, value: dict[str, Any]) -> None:
        write_frame(self.writer, {"op": "result", "value": value})


class BrokerStream(io.RawIOBase):
    def __init__(self, client: BrokerClient, stream_id: str):
        self.client = client
        self.stream_id = stream_id
        self.done = False

    def readable(self) -> bool:
        return True

    def read(self, size: int = -1) -> bytes:
        if self.done:
            return b""
        amount = 256 * 1024 if size is None or size < 0 else size
        value = self.client.call("read", stream_id=self.stream_id, amount=amount)
        data = base64.b64decode(value.get("data_b64", ""), validate=True)
        if value.get("eof"):
            self.done = True
        return data

    def close(self) -> None:
        if not self.closed and not self.done:
            try:
                self.client.call("close", stream_id=self.stream_id)
            except Exception:
                pass
        self.done = True
        super().close()


class BrokerRH(RequestHandler):
    _SUPPORTED_URL_SCHEMES = ("https",)
    _SUPPORTED_PROXY_SCHEMES = None
    _SUPPORTED_FEATURES = None

    def __init__(self, *, broker_client: BrokerClient, **kwargs: Any):
        self.broker_client = broker_client
        super().__init__(**kwargs)

    def _check_proxies(self, proxies):
        if any(value not in (None, "", "__noproxy__") for value in proxies.values()):
            raise RequestError("proxy_configuration_forbidden")

    def _check_extensions(self, extensions):
        for key in ("cookiejar", "timeout", "legacy_ssl", "keep_header_casing"):
            extensions.pop(key, None)

    def _send(self, request):
        body = request.data
        if body is None:
            body_bytes = None
        elif isinstance(body, bytes):
            body_bytes = body
        elif hasattr(body, "read"):
            body_bytes = body.read(1024 * 1024 + 1)
        else:
            body_bytes = b"".join(body)
        value = self.broker_client.call(
            "open",
            method=request.method,
            url=request.url,
            headers=self._get_headers(request),
            body_b64=base64.b64encode(body_bytes).decode("ascii") if body_bytes else None,
        )
        response = Response(
            BrokerStream(self.broker_client, str(value["stream_id"])),
            url=str(value["url"]),
            headers=value.get("headers") or {},
            status=int(value["status"]),
            reason=str(value.get("reason") or ""),
            extensions={"redirect_hops": value.get("redirect_hops", 0)},
        )
        if response.status >= 400:
            raise HTTPError(response)
        return response


class BrokeredYoutubeDL(YoutubeDL):
    def __init__(self, broker_client: BrokerClient, params: dict[str, Any]):
        self.broker_client = broker_client
        super().__init__(params, auto_init=False)
        self.add_info_extractor(YoutubeIE())

    @functools.cached_property
    def _request_director(self):
        director = RequestDirector(logger=self)
        director.add_handler(BrokerRH(
            broker_client=self.broker_client,
            logger=self,
            headers=self.params["http_headers"],
            cookiejar=self.cookiejar,
            proxies={},
            timeout=self.params.get("socket_timeout", 20),
            verify=True,
        ))
        return director


def deny_python_network() -> None:
    def denied(*_args, **_kwargs):
        raise RuntimeError("direct_python_network_forbidden")

    socket.create_connection = denied  # type: ignore[assignment]
    socket.getaddrinfo = denied  # type: ignore[assignment]
    original_connect = socket.socket.connect

    def denied_connect(self, *args, **kwargs):
        del self, args, kwargs
        raise RuntimeError("direct_python_network_forbidden")

    socket.socket.connect = denied_connect  # type: ignore[assignment]
    deny_python_network.original_connect = original_connect  # type: ignore[attr-defined]


def select_single_stream(context):
    formats = list(reversed(context.get("formats") or []))
    allowed = [
        item for item in formats
        if item.get("protocol") == "https"
        and str(item.get("url", "")).startswith("https://")
        and not item.get("manifest_url")
        and not item.get("fragments")
        and item.get("acodec") not in (None, "none")
    ]
    audio_only = [item for item in allowed if item.get("vcodec") == "none"]
    combined = [item for item in allowed if item.get("vcodec") not in (None, "none")]
    selected = (audio_only or combined)
    if not selected:
        return
    yield selected[0]


def deno_path() -> str:
    candidate = Path(sys.executable).parent / ("deno.exe" if sys.platform == "win32" else "deno")
    if not candidate.is_file():
        raise RuntimeError(f"pinned_deno_missing:{candidate}")
    return str(candidate)


def params_for(workspace: Path) -> dict[str, Any]:
    return {
        "quiet": True,
        "no_warnings": True,
        "logtostderr": True,
        "proxy": "",
        "socket_timeout": 20,
        "noplaylist": True,
        "allowed_extractors": ["youtube"],
        "js_runtimes": {"deno": {"path": deno_path()}},
        "remote_components": set(),
        "extractor_args": {"youtube-ejs": {"jitless": ["true"]}},
        "cachedir": False,
        "paths": {"home": str(workspace), "temp": str(workspace)},
        "outtmpl": {"default": str(workspace / "artifact.%(ext)s")},
        "restrictfilenames": True,
        "overwrites": False,
        "format": select_single_stream,
        "postprocessors": [],
        "external_downloader": None,
        "writesubtitles": False,
        "writeautomaticsub": False,
        "writethumbnail": False,
        "writeinfojson": False,
        "getcomments": False,
        "max_filesize": 256 * 1024 * 1024,
    }


def effective_configuration(ydl: BrokeredYoutubeDL) -> dict[str, Any]:
    runtimes = {
        name: {
            "path": runtime.info.path if runtime and runtime.info else None,
            "version": runtime.info.version if runtime and runtime.info else None,
        }
        for name, runtime in ydl._js_runtimes.items()
    }
    return {
        "yt_dlp": yt_dlp_version.__version__,
        "request_handlers": list(ydl._request_director.handlers),
        "extractors": list(ydl._ies),
        "plugin_dirs": list(plugin_dirs.value),
        "remote_components": sorted(ydl.params["remote_components"]),
        "js_runtimes": runtimes,
        "postprocessors": sum(len(items) for items in ydl._pps.values()),
        "external_downloader": ydl.params.get("external_downloader"),
        "cookiefile": ydl.params.get("cookiefile"),
        "cookiesfrombrowser": ydl.params.get("cookiesfrombrowser"),
        "python_socket_guard": True,
        "native_os_containment": "not_proved_by_this_python_artifact",
    }


def sanitized_info(info: dict[str, Any], workspace: Path) -> dict[str, Any]:
    files = [
        {"name": path.name, "bytes": path.stat().st_size}
        for path in workspace.iterdir() if path.is_file()
    ]
    return {
        "id": info.get("id"),
        "extractor": info.get("extractor_key"),
        "duration": info.get("duration"),
        "format_id": info.get("format_id"),
        "protocol": info.get("protocol"),
        "ext": info.get("ext"),
        "is_live": info.get("is_live"),
        "files": files,
    }


def main() -> int:
    mode = sys.argv[1]
    workspace = Path(sys.argv[2]).resolve()
    video_id = sys.argv[3] if len(sys.argv) > 3 else None
    client = BrokerClient()
    try:
        ydl = BrokeredYoutubeDL(client, params_for(workspace))
        config = effective_configuration(ydl)
        deny_python_network()
        if mode == "inspect":
            value = {"ok": True, "configuration": config}
        elif mode in {"metadata", "acquire"}:
            if not video_id:
                raise ValueError("video_id_required")
            url = canonical_video_url(video_id)
            with ydl:
                info = ydl.extract_info(url, download=mode == "acquire", ie_key="Youtube")
            if info.get("id") != video_id:
                raise RuntimeError("extractor_identity_mismatch")
            value = {
                "ok": True,
                "mode": mode,
                "configuration": config,
                "result": sanitized_info(info, workspace),
            }
        else:
            raise ValueError(f"unknown_mode:{mode}")
    except Exception as exc:
        value = {"ok": False, "error": f"{type(exc).__name__}:{exc}"}
    client.result(value)
    return 0 if value.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())

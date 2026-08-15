"""PROTOTYPE: pure endpoint-policy and provisional budget logic."""

from __future__ import annotations

from dataclasses import asdict, dataclass
import ipaddress
import re
import socket
from urllib.parse import urlsplit


VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")


@dataclass(frozen=True)
class ProvisionalBudget:
    max_requests: int = 120
    max_redirects: int = 8
    max_response_bytes: int = 256 * 1024 * 1024
    max_total_bytes: int = 512 * 1024 * 1024
    max_request_body_bytes: int = 1024 * 1024
    max_read_chunk_bytes: int = 256 * 1024
    socket_timeout_seconds: int = 20

    def to_dict(self) -> dict[str, int]:
        return asdict(self)


@dataclass(frozen=True)
class EndpointPolicy:
    version: str = "prototype-2026-08-15"
    exact_hosts: tuple[str, ...] = (
        "www.youtube.com",
        "youtube.com",
        "music.youtube.com",
        "www.youtube-nocookie.com",
        "youtubei.googleapis.com",
        "i.ytimg.com",
    )
    suffix_hosts: tuple[str, ...] = (
        ".googlevideo.com",
        ".ytimg.com",
    )

    def classify_host(self, hostname: str) -> str:
        host = hostname.rstrip(".").lower()
        if host in self.exact_hosts:
            return f"exact:{host}"
        for suffix in self.suffix_hosts:
            if host.endswith(suffix) and host != suffix[1:]:
                return f"suffix:*{suffix}"
        raise ValueError("endpoint_not_allowlisted")

    def validate_url(self, url: str) -> dict[str, str | int]:
        parsed = urlsplit(url)
        if parsed.scheme.lower() != "https":
            raise ValueError("https_required")
        if parsed.username or parsed.password:
            raise ValueError("url_credentials_forbidden")
        if parsed.port not in (None, 443):
            raise ValueError("default_port_required")
        if not parsed.hostname:
            raise ValueError("hostname_required")
        try:
            ipaddress.ip_address(parsed.hostname)
        except ValueError:
            pass
        else:
            raise ValueError("ip_literal_forbidden")
        category = self.classify_host(parsed.hostname)
        return {
            "scheme": "https",
            "host": parsed.hostname.rstrip(".").lower(),
            "port": 443,
            "category": category,
        }


def canonical_video_url(video_id: str) -> str:
    if not VIDEO_ID_RE.fullmatch(video_id):
        raise ValueError("video_id_must_be_11_urlsafe_characters")
    return f"https://www.youtube.com/watch?v={video_id}"


def resolve_global_addresses(host: str, port: int = 443) -> list[str]:
    addresses: list[str] = []
    for family, socktype, proto, _, sockaddr in socket.getaddrinfo(
        host, port, type=socket.SOCK_STREAM
    ):
        if socktype != socket.SOCK_STREAM:
            continue
        address = sockaddr[0]
        parsed = ipaddress.ip_address(address)
        if not parsed.is_global:
            raise ValueError(f"non_global_dns_result:{address}")
        if address not in addresses:
            addresses.append(address)
    if not addresses:
        raise ValueError("dns_no_global_result")
    return addresses


def adversarial_policy_cases(policy: EndpointPolicy) -> list[dict[str, object]]:
    cases = [
        ("canonical", "https://www.youtube.com/watch?v=BaW_jenozKc", True),
        ("media-subdomain", "https://r1---sn-a5mekn6z.googlevideo.com/videoplayback", True),
        ("http-downgrade", "http://www.youtube.com/watch?v=BaW_jenozKc", False),
        ("credentials", "https://user:pass@www.youtube.com/watch?v=BaW_jenozKc", False),
        ("alternate-port", "https://www.youtube.com:444/watch?v=BaW_jenozKc", False),
        ("ip-literal", "https://127.0.0.1/watch?v=BaW_jenozKc", False),
        ("suffix-confusion", "https://googlevideo.com.evil.example/file", False),
        ("private-target", "https://localhost/file", False),
        ("unknown-public", "https://example.com/file", False),
    ]
    results: list[dict[str, object]] = []
    for name, url, expected in cases:
        try:
            policy.validate_url(url)
            allowed = True
            reason = "allowed"
        except Exception as exc:  # deliberate visibility in a throwaway prototype
            allowed = False
            reason = str(exc)
        results.append({
            "case": name,
            "allowed": allowed,
            "expected": expected,
            "pass": allowed is expected,
            "reason": reason,
        })
    return results

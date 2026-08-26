"""Adversarial installed-artifact checks for the native containment boundary."""

from __future__ import annotations

import json
import os
from pathlib import Path
import socket
import subprocess
import sys


def run_probe(plan_path: Path) -> dict[str, object]:
    plan = json.loads(plan_path.read_text("utf-8"))
    sentinel = Path(plan["sentinelPath"])
    workspace = Path.cwd().resolve(strict=True)
    path_blocked = not _can_read(sentinel)
    link = workspace / "containment-link-probe"
    try:
        link.symlink_to(sentinel)
        link_escape_blocked = not _can_read(link)
    except OSError:
        link_escape_blocked = True
    finally:
        link.unlink(missing_ok=True)
    network_blocked = not _can_connect_loopback(int(plan["loopbackPort"]))
    helper = Path(sys.executable).resolve().parent / "tools" / (
        "ffprobe.exe" if os.name == "nt" else "ffprobe"
    )
    try:
        packaged_helper_ran = subprocess.run(
            [str(helper), "-version"],
            check=False,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=10,
        ).returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        packaged_helper_ran = False
    shell_escape_blocked = _shell_cannot_read(sentinel)
    sensitive_environment = {
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "GITHUB_TOKEN",
        "HOME",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "SSH_AUTH_SOCK",
    }
    environment_isolated = all(
        key not in os.environ for key in sensitive_environment if key != "HOME"
    ) and Path(os.environ.get("HOME", workspace)).resolve() == workspace
    return {
        "controlHandleClosed": not _descriptor_is_open(3),
        "environmentIsolated": environment_isolated,
        "linkEscapeBlocked": link_escape_blocked,
        "networkBlocked": network_blocked,
        "packagedHelperRan": packaged_helper_ran,
        "pathBlocked": path_blocked,
        "shellEscapeBlocked": shell_escape_blocked,
    }


def _can_read(path: Path) -> bool:
    try:
        with path.open("rb") as stream:
            stream.read(1)
        return True
    except OSError:
        return False


def _can_connect_loopback(port: int) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=1):
            return True
    except OSError:
        return False


def _descriptor_is_open(descriptor: int) -> bool:
    try:
        os.fstat(descriptor)
        return True
    except OSError:
        return False


def _shell_cannot_read(path: Path) -> bool:
    windows = os.name == "nt"
    command = (
        [os.environ.get("COMSPEC", "C:\\Windows\\System32\\cmd.exe"), "/d", "/c", "type", str(path)]
        if windows
        else ["/bin/sh", "-c", 'test ! -r "$1"', "open-chords-probe", str(path)]
    )
    try:
        result = subprocess.run(
            command,
            check=False,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=5,
        )
    except (OSError, subprocess.TimeoutExpired):
        return True
    # The POSIX command asserts unreadability, while cmd.exe `type` attempts the read.
    return result.returncode != 0 if windows else result.returncode == 0

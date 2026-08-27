"""Adversarial installed-artifact checks for the native containment boundary."""

from __future__ import annotations

import json
import os
from pathlib import Path
import socket
import stat
import subprocess
import sys
import time


SENSITIVE_SURFACES = {
    "browserState",
    "credentials",
    "modelStore",
    "projectLibrary",
    "source",
}


def run_probe(plan_path: Path) -> dict[str, object]:
    plan = json.loads(plan_path.read_text("utf-8"))
    sensitive_paths = {
        name: Path(value) for name, value in plan["sensitivePaths"].items()
    }
    if set(sensitive_paths) != SENSITIVE_SURFACES:
        raise ValueError("containment probe plan has unexpected sensitive surfaces")
    workspace = Path.cwd()
    path_access_blocked = {
        name: not _can_read(path) for name, path in sensitive_paths.items()
    }
    sensitive_link_paths = {
        name: Path(value) for name, value in plan["sensitiveLinkPaths"].items()
    }
    if set(sensitive_link_paths) != SENSITIVE_SURFACES:
        raise ValueError("containment link probe plan has unexpected sensitive surfaces")
    link_access_blocked = {
        name: not _can_read(path) for name, path in sensitive_link_paths.items()
    }
    shell_access_blocked = {
        name: _shell_cannot_read(path) for name, path in sensitive_paths.items()
    }
    network_blocked = not _can_connect_loopback(int(plan["loopbackPort"]))
    helper = Path(sys.executable).parent / "tools" / (
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
    ) and _normalized_path(os.environ.get("HOME", workspace)) == _normalized_path(workspace)
    redirected_environment = (
        {
            "APPDATA": workspace,
            "HOME": workspace,
            "LOCALAPPDATA": workspace.parents[1],
            "USERPROFILE": workspace,
        }
        if os.name == "nt"
        else {"HOME": workspace, "TMPDIR": workspace / "tmp"}
    )
    environment_redirected = all(
        (value := os.environ.get(name)) is not None
        and _normalized_path(value) == _normalized_path(expected)
        for name, expected in redirected_environment.items()
    )
    return {
        "controlHandleClosed": not _descriptor_is_control_channel(3),
        "environmentIsolated": environment_isolated,
        "environmentRedirected": environment_redirected,
        "linkEscapeBlocked": all(value is True for value in link_access_blocked.values()),
        "networkBlocked": network_blocked,
        "packagedHelperRan": packaged_helper_ran,
        "pathBlocked": all(path_access_blocked.values()),
        "processEscapeBlocked": _process_escape_cannot_reach_host(plan_path),
        "sensitiveLinkEscapesBlocked": link_access_blocked,
        "sensitivePathsBlocked": path_access_blocked,
        "sensitiveShellEscapesBlocked": shell_access_blocked,
        "shellEscapeBlocked": all(shell_access_blocked.values()),
    }


def _normalized_path(path: str | os.PathLike[str]) -> str:
    return os.path.normcase(os.path.abspath(os.fspath(path)))


def run_descendant_probe(plan_path: Path) -> int:
    plan = json.loads(plan_path.read_text("utf-8"))
    sensitive_paths = [Path(value) for value in plan["sensitivePaths"].values()]
    blocked = all(not _can_read(path) for path in sensitive_paths) and not _can_connect_loopback(
        int(plan["loopbackPort"])
    )
    print(json.dumps({"hostAccessBlocked": blocked}), flush=True)
    return 0 if blocked else 1


def run_lifecycle_probe(plan_path: Path) -> None:
    plan = json.loads(plan_path.read_text("utf-8"))
    partial_path = Path(plan["partialPath"])
    partial_path.parent.mkdir(parents=True, exist_ok=True)
    partial_path.write_text("unpublished", "utf-8")
    descendant = subprocess.Popen(
        [sys.executable, "--containment-descendant-wait"],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    print(
        json.dumps(
            {
                "descendantPid": descendant.pid,
                "parentPid": os.getpid(),
                "partialPath": str(partial_path),
            },
            separators=(",", ":"),
            sort_keys=True,
        ),
        flush=True,
    )
    if plan["mode"] == "crash":
        os._exit(73)
    while True:
        time.sleep(60)


def wait_as_descendant() -> None:
    while True:
        time.sleep(60)


def _can_read(path: Path) -> bool:
    try:
        with path.open("rb") as stream:
            stream.read(1)
        return True
    except OSError:
        return False


def _process_escape_cannot_reach_host(plan_path: Path) -> bool:
    arguments = [sys.executable, f"--containment-descendant-probe={plan_path}"]
    options: dict[str, object] = {}
    if os.name == "nt":
        options["creationflags"] = getattr(subprocess, "CREATE_BREAKAWAY_FROM_JOB", 0x01000000)
    else:
        options["start_new_session"] = True
    try:
        result = subprocess.run(
            arguments,
            check=False,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=10,
            **options,
        )
    except subprocess.TimeoutExpired:
        return False
    except OSError as error:
        return os.name == "nt" and getattr(error, "winerror", None) == 5
    try:
        evidence = json.loads(result.stdout.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return False
    return result.returncode == 0 and evidence == {"hostAccessBlocked": True}


def _can_connect_loopback(port: int) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=1):
            return True
    except OSError:
        return False


def _descriptor_is_control_channel(descriptor: int) -> bool:
    try:
        mode = os.fstat(descriptor).st_mode
        return stat.S_ISFIFO(mode) or stat.S_ISSOCK(mode)
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

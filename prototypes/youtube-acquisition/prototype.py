"""PROTOTYPE TUI: expose broker-only yt-dlp configuration and acquisition evidence."""

from __future__ import annotations

import argparse
import json
import os
import platform
from typing import Any

from broker import run_worker
from policy import EndpointPolicy, ProvisionalBudget, adversarial_policy_cases


BOLD = "\x1b[1m"
DIM = "\x1b[2m"
RESET = "\x1b[0m"


def self_check() -> dict[str, Any]:
    policy = EndpointPolicy()
    inspect = run_worker("inspect")
    cases = adversarial_policy_cases(policy)
    config = inspect.get("configuration") or {}
    assertions = {
        "worker_inspection_succeeded": bool(inspect.get("ok")),
        "exactly_one_broker_handler": config.get("request_handlers") == ["Broker"],
        "exactly_one_youtube_extractor": config.get("extractors") == ["Youtube"],
        "plugins_disabled": config.get("plugin_dirs") == [],
        "remote_components_disabled": config.get("remote_components") == [],
        "postprocessors_disabled": config.get("postprocessors") == 0,
        "external_downloader_disabled": config.get("external_downloader") is None,
        "policy_cases_pass": all(item["pass"] for item in cases),
        "workspace_cleanup_observed": bool(inspect.get("workspace_removed")),
    }
    return {
        "question": "Can pinned yt-dlp use one broker-only RequestHandler and a single-stream format path?",
        "platform": platform.platform(),
        "python": platform.python_version(),
        "provisional_budget": ProvisionalBudget().to_dict(),
        "inspection": inspect,
        "policy_cases": cases,
        "assertions": assertions,
        "self_check_pass": all(assertions.values()),
        "explicit_gaps": [
            "No native XPC/AppContainer/Landlock-seccomp containment is proved by this Python artifact.",
            "No licensed 30-50-track corpus is included; a user-authorized video ID is required for live probes.",
            "The endpoint seed is provisional and must be generated from release-corpus traces.",
            "DNS CNAME-chain and rebinding enforcement need a production resolver/broker implementation.",
            "Signed packaging, process-tree kill, Deno child containment, and cross-platform resource caps remain release gates.",
        ],
    }


def render(state: dict[str, Any]) -> None:
    os.system("cls" if os.name == "nt" else "clear")
    print(f"{BOLD}Open Chords — brokered YouTube acquisition PROTOTYPE{RESET}")
    print(f"{DIM}Throwaway decision artifact; not product code or a security boundary.{RESET}\n")
    print(f"{BOLD}Last action{RESET}: {state['action']}")
    print(f"{BOLD}State{RESET}:")
    print(json.dumps(state["value"], indent=2, sort_keys=True))
    print()
    print(f"{BOLD}[i]{RESET} inspect/self-check  {BOLD}[m]{RESET} metadata probe")
    print(f"{BOLD}[a]{RESET} authorized acquisition  {BOLD}[p]{RESET} policy cases  {BOLD}[q]{RESET} quit")


def interactive() -> int:
    state: dict[str, Any] = {"action": "start", "value": self_check()}
    while True:
        render(state)
        choice = input("> ").strip().lower()
        if choice == "q":
            return 0
        if choice == "i":
            state = {"action": "self-check", "value": self_check()}
        elif choice == "p":
            state = {
                "action": "policy-cases",
                "value": adversarial_policy_cases(EndpointPolicy()),
            }
        elif choice in {"m", "a"}:
            video_id = input("Authorized public YouTube video ID (11 chars): ").strip()
            if choice == "a":
                consent = input("Confirm you may download this media [type YES]: ").strip()
                if consent != "YES":
                    state = {"action": "acquisition-cancelled", "value": {"ok": False}}
                    continue
            mode = "metadata" if choice == "m" else "acquire"
            state = {"action": mode, "value": run_worker(mode, video_id)}
        else:
            state = {"action": "unknown-key", "value": {"key": choice}}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--self-check", action="store_true")
    parser.add_argument("--metadata", metavar="VIDEO_ID")
    parser.add_argument("--acquire", metavar="VIDEO_ID")
    args = parser.parse_args()
    if args.self_check:
        result = self_check()
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0 if result["self_check_pass"] else 1
    if args.metadata or args.acquire:
        result = run_worker("metadata" if args.metadata else "acquire", args.metadata or args.acquire)
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0 if result.get("ok") else 1
    return interactive()


if __name__ == "__main__":
    raise SystemExit(main())

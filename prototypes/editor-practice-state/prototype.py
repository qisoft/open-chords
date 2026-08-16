#!/usr/bin/env python3
"""One-screen TUI for the throwaway editor/practice state prototype."""

from __future__ import annotations

import argparse
import os
import sys

from model import (
    current_bar,
    current_chord,
    history_summary,
    initial_state,
    materialize,
    presented_chord,
    reduce,
    resolve_loop,
    validate,
)


BOLD = "\x1b[1m"
DIM = "\x1b[2m"
RESET = "\x1b[0m"


COMMANDS = {
    "c": {"type": "edit_chord"},
    "n": {"type": "toggle_n"},
    "v": {"type": "move_chord_boundary"},
    "b": {"type": "move_beat"},
    "d": {"type": "move_downbeat"},
    "m": {"type": "cycle_meter"},
    "w": {"type": "shift_word"},
    "z": {"type": "split_bar"},
    "h": {"type": "merge_next_bar"},
    "u": {"type": "undo"},
    "r": {"type": "redo"},
    "f": {"type": "cycle_redo_branch"},
    "x": {"type": "reset_edits"},
    "[": {"type": "navigate", "direction": -1},
    "]": {"type": "navigate", "direction": 1},
    "j": {"type": "cycle_navigation_unit"},
    "p": {"type": "toggle_play"},
    "l": {"type": "save_loop"},
    "k": {"type": "clear_loop"},
    "s": {"type": "cycle_speed"},
    "i": {"type": "cycle_count_in"},
    "o": {"type": "toggle_metronome"},
    "t": {"type": "transpose"},
    "a": {"type": "cycle_capo"},
    "g": {"type": "toggle_beginner"},
}


def render(state: dict, clear: bool = True) -> None:
    if clear and sys.stdout.isatty():
        print("\033[2J\033[H", end="")
    timeline = materialize(state)
    errors = validate(timeline)
    playhead = state["transport"]["playhead"]
    bar = current_bar(timeline, playhead)
    chord = current_chord(timeline, playhead)
    history = history_summary(state)
    loop = resolve_loop(state, timeline)

    print(f"{BOLD}PROTOTYPE — nondestructive editor + practice state{RESET}")
    print(f"{DIM}Machine timeline is immutable; all numbers are Project Time samples.{RESET}\n")

    print(f"{BOLD}Edit Layer{RESET}  active={history['active']}  depth={history['depth']}  label={history['label']}")
    print(f"redo branches={history['redo_children'] or '—'}  selected={history['selected_redo'] or '—'}")

    bar_parts = []
    for item in timeline["bars"]:
        marker = ">" if item["id"] == bar["id"] else " "
        beat_samples = [str(beat["sample"]) for beat in timeline["beats"] if beat["bar_id"] == item["id"]]
        bar_parts.append(f"{marker}{item['id']}[{item['start']}..{item['end']}] {item['meter'][0]}/{item['meter'][1]} beats={','.join(beat_samples)}")
    print(f"\n{BOLD}Effective Bars / Beats{RESET}")
    for part in bar_parts:
        print(part)

    chord_parts = []
    for item in timeline["chords"]:
        marker = ">" if item["id"] == chord["id"] else " "
        display = presented_chord(item["value"], state["presentation"])
        chord_parts.append(f"{marker}{item['id']}[{item['start']}..{item['end']}] {item['value']}→{display}")
    print(f"\n{BOLD}Effective Chords{RESET}")
    print("  ".join(chord_parts))
    print(f"{BOLD}Word intervals{RESET}  " + "  ".join(f"{word['text']}[{word['start']}..{word['end']}]" for word in timeline["words"]))

    print(f"\n{BOLD}Transport{RESET}  playhead={playhead}  playing={state['transport']['playing']}  centered bar={bar['id']}  chord={chord['id']}")
    print(f"navigation={state['transport']['navigation_unit']}  previous/next resolves from Effective Timeline")
    print(
        f"{BOLD}Practice{RESET}  speed={state['practice']['speed']}×  count-in={state['practice']['count_in_bars']} bar(s)  "
        f"metronome={state['practice']['metronome']}  loop={loop}"
    )
    print(
        f"{BOLD}Presentation{RESET}  transpose=+{state['presentation']['transpose']}  capo={state['presentation']['capo']}  "
        f"Beginner={state['presentation']['beginner']}"
    )
    print(f"{BOLD}Invariants{RESET}  {'OK' if not errors else errors}")
    print(f"{BOLD}Last event{RESET}  {state['last_event']}")

    print(f"\n{BOLD}Edits{RESET}  [c] chord  [n] N  [v] chord boundary  [b] beat  [d] downbeat/Bar boundary")
    print("       [m] meter/grid  [w] word timing  [z] split Bar  [h] merge next Bar  [u] undo  [r] redo  [f] redo branch  [x] reset")
    print(f"{BOLD}Practice{RESET} [/] prev/next  [j] nav unit  [p] play  [l] save loop  [k] clear loop  [s] speed  [i] count-in  [o] metronome")
    print(f"{BOLD}View{RESET}     [t] transpose  [a] capo  [g] Beginner  [q] quit")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--snapshot", action="store_true", help="render initial state once and exit")
    args = parser.parse_args()

    state = initial_state()
    render(state, clear=False)
    if args.snapshot:
        return 0

    while True:
        try:
            command = input("\ncommand> ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            return 0
        if command == "q":
            return 0
        if command not in COMMANDS:
            state = {**state, "last_event": f"Unknown command: {command!r}"}
        else:
            state = reduce(state, COMMANDS[command])
        render(state)


if __name__ == "__main__":
    raise SystemExit(main())

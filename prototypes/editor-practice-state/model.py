"""Pure state model for the throwaway editor/practice prototype."""

from __future__ import annotations

from copy import deepcopy


ROOT = "machine"
CHORD_CYCLE = ["C", "G", "Am", "F", "Cmaj7", "Gsus4", "N"]
METER_CYCLE = [(4, 4), (3, 4), (6, 8)]
ROOTS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def initial_state() -> dict:
    bars = []
    beats = []
    for bar_index in range(4):
        start = bar_index * 400
        bar_id = f"bar-m{bar_index + 1}"
        bars.append(
            {
                "id": bar_id,
                "start": start,
                "end": start + 400,
                "meter": [4, 4],
                "status": "complete",
            }
        )
        for beat_index in range(4):
            beats.append(
                {
                    "id": f"beat-m{bar_index * 4 + beat_index + 1}",
                    "bar_id": bar_id,
                    "sample": start + beat_index * 100,
                    "role": "downbeat" if beat_index == 0 else "beat",
                }
            )

    chord_values = ["C", "G", "Am", "F", "C", "G7", "Am", "F"]
    chords = [
        {
            "id": f"chord-m{index + 1}",
            "start": index * 200,
            "end": (index + 1) * 200,
            "value": value,
            "origin": "machine",
        }
        for index, value in enumerate(chord_values)
    ]
    words = [
        {"id": "word-m1", "text": "hold", "start": 420, "end": 500},
        {"id": "word-m2", "text": "the", "start": 520, "end": 580},
        {"id": "word-m3", "text": "line", "start": 610, "end": 710},
        {"id": "word-m4", "text": "again", "start": 830, "end": 950},
    ]

    return {
        "machine": {
            "project_end": 1600,
            "bars": bars,
            "beats": beats,
            "chords": chords,
            "words": words,
        },
        "history": {
            "nodes": {
                ROOT: {
                    "id": ROOT,
                    "parent": None,
                    "label": "immutable machine output",
                    "operations": [],
                    "children": [],
                }
            },
            "active": ROOT,
            "next_id": 1,
            "redo_choice": {},
        },
        "transport": {
            "playhead": 450,
            "playing": False,
            "navigation_unit": "bar",
        },
        "practice": {
            "speed": 1.0,
            "count_in_bars": 1,
            "metronome": True,
            "saved_loop": None,
        },
        "presentation": {
            "transpose": 0,
            "capo": 0,
            "beginner": False,
        },
        "last_event": "Ready. Machine output is immutable.",
    }


def reduce(state: dict, action: dict) -> dict:
    """Return a new state. No I/O and no mutation of the supplied state."""
    next_state = deepcopy(state)
    kind = action["type"]

    try:
        if kind == "edit_chord":
            timeline = materialize(next_state)
            chord = current_chord(timeline, next_state["transport"]["playhead"])
            value = action.get("value") or _next_value(chord["value"], CHORD_CYCLE)
            _commit(next_state, f"Set {chord['id']} to {value}", [{"type": "set_chord", "id": chord["id"], "value": value}])
        elif kind == "toggle_n":
            timeline = materialize(next_state)
            chord = current_chord(timeline, next_state["transport"]["playhead"])
            value = "C" if chord["value"] == "N" else "N"
            _commit(next_state, f"Set {chord['id']} to {value}", [{"type": "set_chord", "id": chord["id"], "value": value}])
        elif kind == "move_chord_boundary":
            timeline = materialize(next_state)
            chord = current_chord(timeline, next_state["transport"]["playhead"])
            index = _index(timeline["chords"], chord["id"])
            if index >= len(timeline["chords"]) - 1:
                raise ValueError("The final Project boundary cannot move.")
            boundary = chord["end"] + action.get("delta", 25)
            _commit(
                next_state,
                f"Move chord boundary after {chord['id']} to {boundary}",
                [{"type": "move_chord_boundary", "left_id": chord["id"], "sample": boundary}],
            )
        elif kind == "move_beat":
            timeline = materialize(next_state)
            bar = current_bar(timeline, next_state["transport"]["playhead"])
            candidates = [beat for beat in timeline["beats"] if beat["bar_id"] == bar["id"] and beat["role"] != "downbeat"]
            beat = min(candidates, key=lambda item: abs(item["sample"] - next_state["transport"]["playhead"]))
            sample = beat["sample"] + action.get("delta", 15)
            _commit(next_state, f"Move {beat['id']} to {sample}", [{"type": "move_beat", "id": beat["id"], "sample": sample}])
        elif kind == "move_downbeat":
            timeline = materialize(next_state)
            bar = current_bar(timeline, next_state["transport"]["playhead"])
            index = _index(timeline["bars"], bar["id"])
            if index == 0:
                raise ValueError("Project start cannot move; seek to a later Bar.")
            sample = bar["start"] + action.get("delta", 20)
            _commit(
                next_state,
                f"Move shared boundary before {bar['id']} to {sample}",
                [{"type": "move_bar_boundary", "right_id": bar["id"], "sample": sample}],
            )
            next_state["transport"]["playing"] = False
        elif kind == "cycle_meter":
            timeline = materialize(next_state)
            bar = current_bar(timeline, next_state["transport"]["playhead"])
            meter = tuple(bar["meter"])
            next_meter = METER_CYCLE[(METER_CYCLE.index(meter) + 1) % len(METER_CYCLE)] if meter in METER_CYCLE else METER_CYCLE[0]
            tx_id = _next_tx_id(next_state)
            beat_ids = [f"beat-u{tx_id[5:]}-{number + 1}" for number in range(next_meter[0])]
            _commit(
                next_state,
                f"Replace {bar['id']} grid with {next_meter[0]}/{next_meter[1]}",
                [{"type": "replace_bar_grid", "bar_id": bar["id"], "meter": list(next_meter), "beat_ids": beat_ids}],
                forced_id=tx_id,
            )
            next_state["transport"]["playing"] = False
        elif kind == "shift_word":
            timeline = materialize(next_state)
            word = min(timeline["words"], key=lambda item: abs(item["start"] - next_state["transport"]["playhead"]))
            delta = action.get("delta", 20)
            _commit(
                next_state,
                f"Shift {word['id']} by {delta}",
                [{"type": "shift_word", "id": word["id"], "delta": delta}],
            )
        elif kind == "split_bar":
            timeline = materialize(next_state)
            bar = current_bar(timeline, next_state["transport"]["playhead"])
            bar_beats = [beat for beat in timeline["beats"] if beat["bar_id"] == bar["id"]]
            internal = [beat for beat in bar_beats if beat["sample"] > bar["start"]]
            split_beat = min(internal, key=lambda item: abs(item["sample"] - (bar["start"] + bar["end"]) / 2))
            tx_id = _next_tx_id(next_state)
            new_bar_id = f"bar-u{tx_id[5:]}"
            _commit(
                next_state,
                f"Split {bar['id']} at {split_beat['sample']}",
                [{"type": "split_bar", "bar_id": bar["id"], "sample": split_beat["sample"], "new_bar_id": new_bar_id}],
                forced_id=tx_id,
            )
            next_state["transport"]["playing"] = False
        elif kind == "merge_next_bar":
            timeline = materialize(next_state)
            bar = current_bar(timeline, next_state["transport"]["playhead"])
            index = _index(timeline["bars"], bar["id"])
            if index >= len(timeline["bars"]) - 1:
                raise ValueError("There is no next Bar to merge.")
            right = timeline["bars"][index + 1]
            _commit(
                next_state,
                f"Merge {bar['id']} with {right['id']}",
                [{"type": "merge_bars", "left_id": bar["id"], "right_id": right["id"]}],
            )
            next_state["transport"]["playing"] = False
        elif kind == "undo":
            active = next_state["history"]["active"]
            parent = next_state["history"]["nodes"][active]["parent"]
            if parent is None:
                raise ValueError("Already at immutable machine output.")
            next_state["history"]["active"] = parent
            next_state["last_event"] = f"Undo: active history node is {parent}. Practice/presentation state was not changed."
        elif kind == "redo":
            active = next_state["history"]["active"]
            children = next_state["history"]["nodes"][active]["children"]
            if not children:
                raise ValueError("No redo branch from this node.")
            choice = next_state["history"]["redo_choice"].get(active, 0) % len(children)
            next_state["history"]["active"] = children[choice]
            next_state["last_event"] = f"Redo branch {choice + 1}/{len(children)}: {children[choice]}."
        elif kind == "cycle_redo_branch":
            active = next_state["history"]["active"]
            children = next_state["history"]["nodes"][active]["children"]
            if len(children) < 2:
                raise ValueError("This node does not have multiple redo branches yet.")
            current = next_state["history"]["redo_choice"].get(active, 0)
            next_state["history"]["redo_choice"][active] = (current + 1) % len(children)
            next_state["last_event"] = f"Selected redo branch {next_state['history']['redo_choice'][active] + 1}/{len(children)}."
        elif kind == "reset_edits":
            next_state["history"]["active"] = ROOT
            next_state["last_event"] = "Reset Edit Layer to machine output. Practice/presentation state was preserved."
        elif kind == "navigate":
            _navigate(next_state, action.get("direction", 1))
        elif kind == "cycle_navigation_unit":
            units = ["bar", "chord"]
            current = next_state["transport"]["navigation_unit"]
            next_state["transport"]["navigation_unit"] = units[(units.index(current) + 1) % len(units)]
            next_state["last_event"] = f"Navigation unit: {next_state['transport']['navigation_unit']}."
        elif kind == "toggle_play":
            next_state["transport"]["playing"] = not next_state["transport"]["playing"]
            next_state["last_event"] = "Playback started with count-in." if next_state["transport"]["playing"] else "Playback paused."
        elif kind == "save_loop":
            timeline = materialize(next_state)
            bar = current_bar(timeline, next_state["transport"]["playhead"])
            index = _index(timeline["bars"], bar["id"])
            end_bar = timeline["bars"][min(index + 1, len(timeline["bars"]) - 1)]
            next_state["practice"]["saved_loop"] = {"start_bar_id": bar["id"], "end_bar_id": end_bar["id"]}
            next_state["last_event"] = f"Saved bar loop {bar['id']} → {end_bar['id']}."
        elif kind == "clear_loop":
            next_state["practice"]["saved_loop"] = None
            next_state["last_event"] = "Saved loop cleared."
        elif kind == "cycle_speed":
            values = [0.5, 0.75, 1.0, 1.25]
            current = next_state["practice"]["speed"]
            next_state["practice"]["speed"] = values[(values.index(current) + 1) % len(values)]
            next_state["last_event"] = f"Speed: {next_state['practice']['speed']}× without pitch shift."
        elif kind == "cycle_count_in":
            next_state["practice"]["count_in_bars"] = (next_state["practice"]["count_in_bars"] + 1) % 3
            next_state["last_event"] = f"Count-in: {next_state['practice']['count_in_bars']} Bar(s)."
        elif kind == "toggle_metronome":
            next_state["practice"]["metronome"] = not next_state["practice"]["metronome"]
            next_state["last_event"] = f"Metronome: {'on' if next_state['practice']['metronome'] else 'off'}."
        elif kind == "transpose":
            next_state["presentation"]["transpose"] = (next_state["presentation"]["transpose"] + 1) % 12
            next_state["last_event"] = f"Transpose view: +{next_state['presentation']['transpose']} semitone(s)."
        elif kind == "cycle_capo":
            next_state["presentation"]["capo"] = (next_state["presentation"]["capo"] + 1) % 5
            next_state["last_event"] = f"Capo suggestion/display: fret {next_state['presentation']['capo']}."
        elif kind == "toggle_beginner":
            next_state["presentation"]["beginner"] = not next_state["presentation"]["beginner"]
            next_state["last_event"] = f"Beginner View: {'on' if next_state['presentation']['beginner'] else 'off'}."
        else:
            raise ValueError(f"Unknown action: {kind}")
    except ValueError as error:
        next_state["last_event"] = f"REJECTED — {error}"

    return next_state


def materialize(state: dict) -> dict:
    timeline = deepcopy(state["machine"])
    timeline["loop_review_bar_ids"] = set()
    for node in _active_path(state)[1:]:
        for operation in node["operations"]:
            _apply_operation(timeline, operation)
    _sort_timeline(timeline)
    return timeline


def validate(timeline: dict) -> list[str]:
    errors = []
    bars = timeline["bars"]
    chords = timeline["chords"]
    if not bars or bars[0]["start"] != 0 or bars[-1]["end"] != timeline["project_end"]:
        errors.append("Bars must cover the Project Range.")
    for left, right in zip(bars, bars[1:]):
        if left["end"] != right["start"]:
            errors.append(f"Bar gap/overlap: {left['id']} → {right['id']}.")
    if not chords or chords[0]["start"] != 0 or chords[-1]["end"] != timeline["project_end"]:
        errors.append("Chord Events must cover the Project Range.")
    for left, right in zip(chords, chords[1:]):
        if left["end"] != right["start"]:
            errors.append(f"Chord gap/overlap: {left['id']} → {right['id']}.")
    for bar in bars:
        bar_beats = sorted((beat for beat in timeline["beats"] if beat["bar_id"] == bar["id"]), key=lambda beat: beat["sample"])
        if not bar_beats or bar_beats[0]["sample"] != bar["start"] or bar_beats[0]["role"] != "downbeat":
            errors.append(f"{bar['id']} must start with its downbeat.")
        if any(not (bar["start"] <= beat["sample"] < bar["end"]) for beat in bar_beats):
            errors.append(f"Beat outside {bar['id']}.")
    return errors


def current_bar(timeline: dict, sample: int) -> dict:
    return _at(timeline["bars"], sample)


def current_chord(timeline: dict, sample: int) -> dict:
    return _at(timeline["chords"], sample)


def resolve_loop(state: dict, timeline: dict) -> dict:
    saved = state["practice"]["saved_loop"]
    if saved is None:
        return {"status": "none"}
    bars = {bar["id"]: bar for bar in timeline["bars"]}
    ids = {saved["start_bar_id"], saved["end_bar_id"]}
    if not ids.issubset(bars) or ids.intersection(timeline["loop_review_bar_ids"]):
        return {"status": "needs_review", **saved}
    start = bars[saved["start_bar_id"]]["start"]
    end = bars[saved["end_bar_id"]]["end"]
    if start >= end:
        return {"status": "needs_review", **saved}
    return {"status": "valid", "start": start, "end": end, **saved}


def presented_chord(value: str, presentation: dict) -> str:
    if value == "N":
        return "N"
    root = next((candidate for candidate in sorted(ROOTS, key=len, reverse=True) if value.startswith(candidate)), "C")
    suffix = value[len(root) :]
    if presentation["beginner"]:
        if suffix.startswith("m") and not suffix.startswith("maj"):
            suffix = "m"
        else:
            suffix = ""
    sounding_index = ROOTS.index(root)
    displayed_index = (sounding_index + presentation["transpose"] - presentation["capo"]) % 12
    return ROOTS[displayed_index] + suffix


def history_summary(state: dict) -> dict:
    active = state["history"]["active"]
    node = state["history"]["nodes"][active]
    children = node["children"]
    choice = state["history"]["redo_choice"].get(active, 0)
    return {
        "active": active,
        "label": node["label"],
        "depth": len(_active_path(state)) - 1,
        "redo_children": children,
        "selected_redo": children[choice % len(children)] if children else None,
    }


def _commit(state: dict, label: str, operations: list[dict], forced_id: str | None = None) -> None:
    trial = materialize(state)
    for operation in operations:
        _apply_operation(trial, operation)
    _sort_timeline(trial)
    errors = validate(trial)
    if errors:
        raise ValueError("; ".join(errors))

    history = state["history"]
    parent = history["active"]
    tx_id = forced_id or _next_tx_id(state)
    history["next_id"] += 1
    history["nodes"][tx_id] = {
        "id": tx_id,
        "parent": parent,
        "label": label,
        "operations": operations,
        "children": [],
    }
    history["nodes"][parent]["children"].append(tx_id)
    history["active"] = tx_id
    history["redo_choice"][parent] = len(history["nodes"][parent]["children"]) - 1
    state["last_event"] = f"Edit Transaction {tx_id}: {label}."


def _next_tx_id(state: dict) -> str:
    return f"edit-{state['history']['next_id']:03d}"


def _active_path(state: dict) -> list[dict]:
    nodes = state["history"]["nodes"]
    node = nodes[state["history"]["active"]]
    path = []
    while node is not None:
        path.append(node)
        node = nodes[node["parent"]] if node["parent"] is not None else None
    return list(reversed(path))


def _apply_operation(timeline: dict, operation: dict) -> None:
    kind = operation["type"]
    if kind == "set_chord":
        chord = _find(timeline["chords"], operation["id"])
        chord["value"] = operation["value"]
        chord["origin"] = "user_asserted"
    elif kind == "move_chord_boundary":
        left_index = _index(timeline["chords"], operation["left_id"])
        left = timeline["chords"][left_index]
        right = timeline["chords"][left_index + 1]
        sample = operation["sample"]
        if not (left["start"] + 20 < sample < right["end"] - 20):
            raise ValueError("Chord boundary would create an empty/too-small event.")
        left["end"] = sample
        right["start"] = sample
    elif kind == "move_beat":
        beat = _find(timeline["beats"], operation["id"])
        if beat["role"] == "downbeat":
            raise ValueError("Downbeat is a Bar boundary; use move_bar_boundary.")
        bar = _find(timeline["bars"], beat["bar_id"])
        siblings = sorted((item for item in timeline["beats"] if item["bar_id"] == bar["id"]), key=lambda item: item["sample"])
        index = _index(siblings, beat["id"])
        lower = siblings[index - 1]["sample"] + 10
        upper = siblings[index + 1]["sample"] - 10 if index + 1 < len(siblings) else bar["end"] - 10
        if not (lower <= operation["sample"] <= upper):
            raise ValueError("Beat must remain ordered inside its Bar.")
        beat["sample"] = operation["sample"]
    elif kind == "move_bar_boundary":
        right_index = _index(timeline["bars"], operation["right_id"])
        if right_index == 0:
            raise ValueError("Project start cannot move.")
        left = timeline["bars"][right_index - 1]
        right = timeline["bars"][right_index]
        sample = operation["sample"]
        left_beats = sorted((beat for beat in timeline["beats"] if beat["bar_id"] == left["id"]), key=lambda beat: beat["sample"])
        right_beats = sorted((beat for beat in timeline["beats"] if beat["bar_id"] == right["id"]), key=lambda beat: beat["sample"])
        right_limit = right_beats[1]["sample"] - 10 if len(right_beats) > 1 else right["end"] - 10
        if not (left_beats[-1]["sample"] + 10 < sample < right_limit):
            raise ValueError("Shared boundary would cross an adjacent Beat.")
        left["end"] = sample
        right["start"] = sample
        right_beats[0]["sample"] = sample
    elif kind == "replace_bar_grid":
        bar = _find(timeline["bars"], operation["bar_id"])
        timeline["beats"] = [beat for beat in timeline["beats"] if beat["bar_id"] != bar["id"]]
        numerator = operation["meter"][0]
        duration = bar["end"] - bar["start"]
        bar["meter"] = operation["meter"]
        for index, beat_id in enumerate(operation["beat_ids"]):
            timeline["beats"].append(
                {
                    "id": beat_id,
                    "bar_id": bar["id"],
                    "sample": bar["start"] + round(duration * index / numerator),
                    "role": "downbeat" if index == 0 else "beat",
                }
            )
    elif kind == "shift_word":
        word = _find(timeline["words"], operation["id"])
        new_start = word["start"] + operation["delta"]
        new_end = word["end"] + operation["delta"]
        if new_start < 0 or new_end > timeline["project_end"]:
            raise ValueError("Word interval must remain inside Project Time.")
        word["start"], word["end"] = new_start, new_end
    elif kind == "split_bar":
        index = _index(timeline["bars"], operation["bar_id"])
        bar = timeline["bars"][index]
        sample = operation["sample"]
        if not (bar["start"] < sample < bar["end"]):
            raise ValueError("Split must be inside the Bar.")
        right = {
            "id": operation["new_bar_id"],
            "start": sample,
            "end": bar["end"],
            "meter": [0, 4],
            "status": "complete",
        }
        bar["end"] = sample
        timeline["bars"].insert(index + 1, right)
        left_beats = []
        right_beats = []
        for beat in timeline["beats"]:
            if beat["bar_id"] == bar["id"]:
                if beat["sample"] < sample:
                    left_beats.append(beat)
                else:
                    beat["bar_id"] = right["id"]
                    right_beats.append(beat)
        if not left_beats or not right_beats:
            raise ValueError("Split requires Beats on both sides.")
        left_beats.sort(key=lambda beat: beat["sample"])
        right_beats.sort(key=lambda beat: beat["sample"])
        for position, beat in enumerate(left_beats):
            beat["role"] = "downbeat" if position == 0 else "beat"
        for position, beat in enumerate(right_beats):
            beat["role"] = "downbeat" if position == 0 else "beat"
        bar["meter"] = [len(left_beats), 4]
        right["meter"] = [len(right_beats), 4]
        timeline["loop_review_bar_ids"].add(bar["id"])
    elif kind == "merge_bars":
        left_index = _index(timeline["bars"], operation["left_id"])
        left = timeline["bars"][left_index]
        right = timeline["bars"][left_index + 1]
        if right["id"] != operation["right_id"]:
            raise ValueError("Bars are no longer adjacent.")
        left["end"] = right["end"]
        timeline["bars"].pop(left_index + 1)
        merged_beats = []
        for beat in timeline["beats"]:
            if beat["bar_id"] == right["id"]:
                beat["bar_id"] = left["id"]
            if beat["bar_id"] == left["id"]:
                merged_beats.append(beat)
        merged_beats.sort(key=lambda beat: beat["sample"])
        for position, beat in enumerate(merged_beats):
            beat["role"] = "downbeat" if position == 0 else "beat"
        left["meter"] = [len(merged_beats), 4]
        timeline["loop_review_bar_ids"].update({left["id"], right["id"]})
    else:
        raise ValueError(f"Unknown edit operation: {kind}")


def _navigate(state: dict, direction: int) -> None:
    timeline = materialize(state)
    unit = state["transport"]["navigation_unit"]
    items = timeline["bars"] if unit == "bar" else timeline["chords"]
    starts = [item["start"] for item in items]
    playhead = state["transport"]["playhead"]
    if direction > 0:
        targets = [sample for sample in starts if sample > playhead]
        target = targets[0] if targets else starts[-1]
    else:
        targets = [sample for sample in starts if sample < playhead]
        target = targets[-1] if targets else starts[0]
    state["transport"]["playhead"] = target
    state["last_event"] = f"Seek to previous/next {unit}: Project Time {target}."


def _sort_timeline(timeline: dict) -> None:
    timeline["bars"].sort(key=lambda item: (item["start"], item["id"]))
    timeline["beats"].sort(key=lambda item: (item["sample"], item["id"]))
    timeline["chords"].sort(key=lambda item: (item["start"], item["id"]))
    timeline["words"].sort(key=lambda item: (item["start"], item["id"]))


def _at(items: list[dict], sample: int) -> dict:
    for item in items:
        if item["start"] <= sample < item["end"]:
            return item
    return items[-1]


def _find(items: list[dict], item_id: str) -> dict:
    return next(item for item in items if item["id"] == item_id)


def _index(items: list[dict], item_id: str) -> int:
    return next(index for index, item in enumerate(items) if item["id"] == item_id)


def _next_value(current: str, values: list[str]) -> str:
    return values[(values.index(current) + 1) % len(values)] if current in values else values[0]

#!/usr/bin/env python3
"""Validate the same versioned structural and semantic corpus as TypeScript."""

from __future__ import annotations

import copy
import json
import math
import re
from itertools import pairwise
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2] / "packages" / "testkit" / "contracts" / "v1"
MAX_SAFE_INTEGER = 9_007_199_254_740_991


class ContractError(ValueError):
    pass


def json_type_matches(value: Any, expected: str) -> bool:
    return {
        "array": isinstance(value, list),
        "boolean": isinstance(value, bool),
        "integer": isinstance(value, int) and not isinstance(value, bool),
        "null": value is None,
        "number": isinstance(value, (int, float)) and not isinstance(value, bool),
        "object": isinstance(value, dict),
        "string": isinstance(value, str),
    }.get(expected, False)


def resolve_ref(root_schema: dict[str, Any], reference: str) -> dict[str, Any]:
    if not reference.startswith("#/"):
        raise ContractError(f"unsupported JSON Schema reference {reference}")
    value: Any = root_schema
    for raw in reference[2:].split("/"):
        key = raw.replace("~1", "/").replace("~0", "~")
        value = value[key]
    if not isinstance(value, dict):
        raise ContractError("JSON Schema reference does not resolve to an object")
    return value


def matches_schema(value: Any, schema: dict[str, Any], root_schema: dict[str, Any], path: str) -> bool:
    try:
        validate_json_schema(value, schema, root_schema, path)
    except ContractError:
        return False
    return True


def validate_json_schema(value: Any, schema: dict[str, Any], root_schema: dict[str, Any], path: str = "$") -> None:
    if "$ref" in schema:
        validate_json_schema(value, resolve_ref(root_schema, schema["$ref"]), root_schema, path)
        return
    if "oneOf" in schema:
        if sum(matches_schema(value, option, root_schema, path) for option in schema["oneOf"]) != 1:
            raise ContractError(f"{path} does not match exactly one schema")
        return
    if "anyOf" in schema:
        if not any(matches_schema(value, option, root_schema, path) for option in schema["anyOf"]):
            raise ContractError(f"{path} does not match any schema")
        return
    if "const" in schema and value != schema["const"]:
        raise ContractError(f"{path} has unknown core semantics")
    if "enum" in schema and value not in schema["enum"]:
        raise ContractError(f"{path} has unknown core semantics")
    expected = schema.get("type")
    if isinstance(expected, str) and not json_type_matches(value, expected):
        raise ContractError(f"{path} has the wrong JSON type")
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if not math.isfinite(value) or abs(value) > MAX_SAFE_INTEGER:
            raise ContractError(f"{path} is non-finite or unsafe")
        if "minimum" in schema and value < schema["minimum"]:
            raise ContractError(f"{path} is below minimum")
        if "exclusiveMinimum" in schema and value <= schema["exclusiveMinimum"]:
            raise ContractError(f"{path} is not above exclusive minimum")
        if "maximum" in schema and value > schema["maximum"]:
            raise ContractError(f"{path} is above maximum")
        if "exclusiveMaximum" in schema and value >= schema["exclusiveMaximum"]:
            raise ContractError(f"{path} is not below exclusive maximum")
    if isinstance(value, str):
        if "minLength" in schema and len(value) < schema["minLength"]:
            raise ContractError(f"{path} is too short")
        if "pattern" in schema and re.search(schema["pattern"], value) is None:
            raise ContractError(f"{path} does not match its pattern")
        if schema.get("format") == "date-time" and re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)", value) is None:
            raise ContractError(f"{path} is not an offset date-time")
    if isinstance(value, list):
        if "minItems" in schema and len(value) < schema["minItems"]:
            raise ContractError(f"{path} has too few items")
        if "maxItems" in schema and len(value) > schema["maxItems"]:
            raise ContractError(f"{path} has too many items")
        prefix_items = schema.get("prefixItems")
        if isinstance(prefix_items, list):
            for index, item_schema in enumerate(prefix_items):
                if index < len(value):
                    validate_json_schema(value[index], item_schema, root_schema, f"{path}[{index}]")
        item_schema = schema.get("items")
        if isinstance(item_schema, dict):
            for index, item in enumerate(value):
                validate_json_schema(item, item_schema, root_schema, f"{path}[{index}]")
    if isinstance(value, dict):
        required = schema.get("required", [])
        missing = set(required) - set(value)
        if missing:
            raise ContractError(f"{path} misses required fields {sorted(missing)}")
        properties = schema.get("properties", {})
        for key, item in value.items():
            if key in properties:
                validate_json_schema(item, properties[key], root_schema, f"{path}.{key}")
                continue
            additional = schema.get("additionalProperties", True)
            if additional is False:
                raise ContractError(f"{path}.{key} is an unknown core field")
            if isinstance(additional, dict):
                validate_json_schema(item, additional, root_schema, f"{path}.{key}")
            property_names = schema.get("propertyNames")
            if isinstance(property_names, dict):
                validate_json_schema(key, property_names, root_schema, f"{path} key")


def unique_ids(items: list[dict[str, Any]], label: str) -> None:
    ids = [item["id"] for item in items]
    if len(ids) != len(set(ids)):
        raise ContractError(f"{label} has duplicate IDs")


def utf16_sort_key(value: str) -> bytes:
    return value.encode("utf-16-be", errors="surrogatepass")


def validate_sorted_unique(values: list[str], label: str) -> None:
    if any(utf16_sort_key(left) >= utf16_sort_key(right) for left, right in zip(values, values[1:])):
        raise ContractError(f"{label} is not sorted and unique")


def validate_cover(track: list[dict[str, Any]], duration: int, label: str) -> None:
    cursor = 0
    if not track:
        raise ContractError(f"{label} is empty")
    for item in track:
        start, end = item["startSample"], item["endSample"]
        if start != cursor or end <= start:
            raise ContractError(f"{label} overlaps, has a gap, or is unstably ordered")
        cursor = end
    if cursor != duration:
        raise ContractError(f"{label} does not cover the Project Range")


def validate_timeline(timeline: dict[str, Any], duration: int) -> None:
    for key in ("bars", "unmeteredRegions", "chordEvents", "sectionRegions", "keyRegions"):
        unique_ids(timeline[key], key)
    validate_cover(timeline["chordEvents"], duration, "chord track")
    validate_cover(timeline["sectionRegions"], duration, "section track")
    validate_cover(timeline["keyRegions"], duration, "key track")
    metered = sorted(timeline["bars"] + timeline["unmeteredRegions"], key=lambda item: (item["startSample"], item["id"]))
    validate_cover(metered, duration, "metered/unmetered track")
    unique_ids([beat for bar in timeline["bars"] for beat in bar["beats"]], "beats in timeline")
    for bar in timeline["bars"]:
        beats = bar["beats"]
        unique_ids(beats, f"beats in {bar['id']}")
        if not beats or beats[0]["role"] != "downbeat" or beats[0]["atSample"] != bar["startSample"]:
            raise ContractError("Bar does not start with its downbeat")
        if any(right["atSample"] <= left["atSample"] for left, right in pairwise(beats)):
            raise ContractError("Beats are unstably ordered")
        if any(beat["role"] != "beat" for beat in beats[1:]):
            raise ContractError("Bar has a non-initial downbeat")
        if any(beat["atSample"] < bar["startSample"] or beat["atSample"] >= bar["endSample"] for beat in beats):
            raise ContractError("Beat lies outside its Bar")
        if bar["status"] == "complete" and len(beats) != bar["meter"]["numerator"]:
            raise ContractError("Complete Bar has the wrong beat count")
        if len(beats) > bar["meter"]["numerator"]:
            raise ContractError("Bar has more beats than its meter numerator")
    for event in timeline["chordEvents"]:
        if event["value"]["kind"] == "chord":
            for component in ("additions", "alterations", "extensions", "omissions"):
                validate_sorted_unique(event["value"][component], f"Chord {component}")


def validate_timing_sequence(occurrences: list[dict[str, Any]], duration: int, label: str) -> None:
    cursor = 0
    for occurrence in occurrences:
        timing = occurrence["timing"]
        if timing["state"] != "matched":
            continue
        if timing["startSample"] < cursor or timing["endSample"] <= timing["startSample"] or timing["endSample"] > duration:
            raise ContractError(f"invalid {label} timing order")
        cursor = timing["endSample"]


def validate_alignment(alignment: dict[str, Any], document: dict[str, Any], duration: int) -> None:
    expected_tokens = [item["id"] for item in document["tokens"]]
    actual_tokens = [item["tokenId"] for item in alignment["occurrences"]]
    if actual_tokens != expected_tokens:
        raise ContractError("Lyrics Token Occurrences are not one-to-one in Document order")
    expected_lines = [item["id"] for item in document["lines"]]
    actual_lines = [item["lineId"] for item in alignment["lineOccurrences"]]
    if actual_lines != expected_lines:
        raise ContractError("Lyrics Line Occurrences are not one-to-one in Document order")
    validate_timing_sequence(alignment["occurrences"], duration, "Lyrics token")
    validate_timing_sequence(alignment["lineOccurrences"], duration, "Lyrics line")


def apply_operations(project: dict[str, Any], layer: dict[str, Any], history_position: int) -> None:
    revision = next(item for item in project["analysisRevisions"] if item["id"] == layer["analysisRevisionId"])
    timeline = copy.deepcopy(revision["timeline"])
    alignments = copy.deepcopy([
        item for item in project["lyricsAlignments"]
        if item["analysisRevisionId"] == layer["analysisRevisionId"]
    ])
    transactions = layer["transactions"]
    by_id = {item["id"]: item for item in transactions}
    selected = transactions[history_position - 1] if history_position else None
    chain: list[dict[str, Any]] = []
    while selected is not None:
        chain.insert(0, selected)
        selected = by_id.get(selected["parentTransactionId"])
    for transaction in chain:
        for operation in transaction["operations"]:
            kind = operation["type"]
            if kind == "replace_chord_value":
                event = next(item for item in timeline["chordEvents"] if item["id"] == operation["eventId"])
                event["value"] = operation["value"]
            elif kind == "move_chord_boundary":
                left = next(item for item in timeline["chordEvents"] if item["id"] == operation["leftEventId"])
                right = next(item for item in timeline["chordEvents"] if item["id"] == operation["rightEventId"])
                if timeline["chordEvents"].index(right) != timeline["chordEvents"].index(left) + 1:
                    raise ContractError("Chord boundary references are not adjacent")
                left["endSample"] = right["startSample"] = operation["atSample"]
            elif kind == "move_beat":
                beat = next(beat for bar in timeline["bars"] for beat in bar["beats"] if beat["id"] == operation["beatId"])
                beat["atSample"] = operation["atSample"]
            elif kind == "move_bar_boundary":
                left = next(item for item in timeline["bars"] if item["id"] == operation["leftBarId"])
                right = next(item for item in timeline["bars"] if item["id"] == operation["rightBarId"])
                if timeline["bars"].index(right) != timeline["bars"].index(left) + 1:
                    raise ContractError("Bar boundary references are not adjacent")
                left["endSample"] = right["startSample"] = right["beats"][0]["atSample"] = operation["atSample"]
            elif kind == "set_bar_meter":
                next(item for item in timeline["bars"] if item["id"] == operation["barId"])["meter"] = operation["meter"]
            elif kind == "replace_section_label":
                next(item for item in timeline["sectionRegions"] if item["id"] == operation["regionId"])["label"] = operation["label"]
            elif kind == "split_bar":
                index = next(index for index, item in enumerate(timeline["bars"]) if item["id"] == operation["barId"])
                bar = timeline["bars"][index]
                original_end = bar["endSample"]
                if any(beat["atSample"] == operation["atSample"] for beat in bar["beats"]):
                    raise ContractError("Split point collides with an existing Beat")
                right_beats = [dict(beat, role="beat") for beat in bar["beats"] if beat["atSample"] > operation["atSample"]]
                bar["beats"] = [beat for beat in bar["beats"] if beat["atSample"] < operation["atSample"]]
                bar["endSample"], bar["status"] = operation["atSample"], operation["leftStatus"]
                timeline["bars"].insert(index + 1, {
                    "beats": [{"atSample": operation["atSample"], "id": operation["newDownbeatId"], "role": "downbeat"}, *right_beats],
                    "endSample": original_end, "id": operation["newBarId"], "meter": operation["rightMeter"],
                    "startSample": operation["atSample"], "status": operation["rightStatus"],
                })
            elif kind == "merge_bars":
                left_index = next(index for index, item in enumerate(timeline["bars"]) if item["id"] == operation["leftBarId"])
                right_index = next(index for index, item in enumerate(timeline["bars"]) if item["id"] == operation["rightBarId"])
                if right_index != left_index + 1:
                    raise ContractError("Merge Bars are not adjacent")
                left, right = timeline["bars"][left_index], timeline["bars"][right_index]
                left["endSample"] = right["endSample"]
                left["beats"] += [dict(beat, role="beat") for beat in right["beats"]]
                left["meter"], left["status"] = operation["meter"], operation["status"]
                timeline["bars"].pop(right_index)
            elif kind == "set_lyrics_timing":
                alignment = next(item for item in alignments if item["id"] == operation["alignmentId"])
                occurrence = next(item for item in alignment["occurrences"] if item["tokenId"] == operation["tokenId"])
                occurrence["timing"] = operation["timing"]
            elif kind == "set_lyrics_line_timing":
                alignment = next(item for item in alignments if item["id"] == operation["alignmentId"])
                occurrence = next(item for item in alignment["lineOccurrences"] if item["lineId"] == operation["lineId"])
                occurrence["timing"] = operation["timing"]
    validate_timeline(timeline, project["durationSamples"])
    documents = {item["id"]: item for item in project["lyricsDocuments"]}
    for alignment in alignments:
        validate_alignment(alignment, documents[alignment["lyricsDocumentId"]], project["durationSamples"])


def validate_domain(envelope: dict[str, Any]) -> None:
    major = int(envelope["schemaVersion"].split(".")[0])
    if major != 1:
        raise ContractError("unknown contract major")
    project = envelope["payload"]
    if int(project["schemaVersion"].split(".")[0]) != 1:
        raise ContractError("unknown Project major")
    duration = project["durationSamples"]
    unique_ids(project["analysisRevisions"], "Analysis Revisions")
    unique_ids(project["editLayers"], "Edit Layers")
    unique_ids(project["lyricsDocuments"], "Lyrics Documents")
    unique_ids(project["lyricsAlignments"], "Lyrics Alignments")
    unique_ids(project["supportClaims"], "Support Claims")
    revisions = {item["id"]: item for item in project["analysisRevisions"]}
    claims = {item["id"] for item in project["supportClaims"]}
    for revision in project["analysisRevisions"]:
        if revision["projectId"] != project["id"] or not set(revision["supportClaimIds"]) <= claims:
            raise ContractError("invalid Analysis Revision reference")
        validate_timeline(revision["timeline"], duration)
    layers = {item["id"]: item for item in project["editLayers"]}
    for layer in project["editLayers"]:
        if layer["analysisRevisionId"] not in revisions:
            raise ContractError("unknown Edit Layer revision")
        unique_ids(layer["transactions"], "Edit Transactions")
        preceding: set[str] = set()
        for transaction in layer["transactions"]:
            parent = transaction["parentTransactionId"]
            if parent is not None and parent not in preceding:
                raise ContractError("transaction parent is not earlier")
            preceding.add(transaction["id"])
        for position in range(len(layer["transactions"]) + 1):
            try:
                apply_operations(project, layer, position)
            except (KeyError, StopIteration) as error:
                raise ContractError("Edit operation has an unstable reference") from error
    active = project["activeView"]
    if active is None:
        if project["analysisRevisions"] or project["editLayers"] or project["lyricsDocuments"] or project["lyricsAlignments"]:
            raise ContractError("unanalyzed Project contains analysis-owned records")
        return
    layer = layers.get(active["editLayerId"])
    if layer is None or active["analysisRevisionId"] not in revisions or layer["analysisRevisionId"] != active["analysisRevisionId"]:
        raise ContractError("invalid Active View reference")
    if active["editHistoryPosition"] > len(layer["transactions"]):
        raise ContractError("invalid committed history position")
    documents = {item["id"]: item for item in project["lyricsDocuments"]}
    alignments = {item["id"]: item for item in project["lyricsAlignments"]}
    for document in documents.values():
        unique_ids(document["lines"], "Lyrics lines")
        unique_ids(document["tokens"], "Lyrics tokens")
        line_ids = {line["id"] for line in document["lines"]}
        line_cursor = 0
        for line in document["lines"]:
            if line["startOffset"] < line_cursor or line["endOffset"] <= line["startOffset"] or line["endOffset"] > len(document["text"]):
                raise ContractError("invalid Lyrics Line Occurrence")
            line_cursor = line["endOffset"]
        cursor = 0
        for token in document["tokens"]:
            if (
                token["lineId"] not in line_ids
                or token["startOffset"] < cursor
                or token["endOffset"] <= token["startOffset"]
                or token["endOffset"] > len(document["text"])
                or document["text"][token["startOffset"]:token["endOffset"]] != token["text"]
            ):
                raise ContractError("invalid Lyrics Token Occurrence")
            cursor = token["endOffset"]
    for alignment in alignments.values():
        document = documents.get(alignment["lyricsDocumentId"])
        if document is None or alignment["analysisRevisionId"] not in revisions:
            raise ContractError("invalid Lyrics Alignment reference")
        validate_alignment(alignment, document, duration)
    document_id = active.get("lyricsDocumentId")
    alignment_id = active.get("lyricsAlignmentId")
    if (document_id is None) != (alignment_id is None):
        raise ContractError("Active View must select Lyrics Document and Alignment together")
    if document_id is not None:
        alignment = alignments.get(alignment_id)
        if document_id not in documents or alignment is None:
            raise ContractError("Active View has an unknown Lyrics reference")
        if alignment["lyricsDocumentId"] != document_id or alignment["analysisRevisionId"] != active["analysisRevisionId"]:
            raise ContractError("Active View Lyrics selection belongs to another Document or Revision")


def validate_envelope(envelope: dict[str, Any], schema: dict[str, Any]) -> None:
    validate_json_schema(envelope, schema, schema)
    validate_domain(envelope)


def mutate(base: Any, case: dict[str, Any]) -> Any:
    result = copy.deepcopy(base)
    target = result
    for segment in case["path"][:-1]:
        target = target[segment]
    key = case["path"][-1]
    target[key] = list(reversed(target[key])) if case.get("operation") == "reverse" else case.get("value")
    return result


def main() -> None:
    schema = json.loads((ROOT / "schema" / "project-envelope.schema.json").read_text(encoding="utf-8"))
    golden = json.loads((ROOT / "valid" / "project-envelope.json").read_text(encoding="utf-8"))
    valid_count = 0
    for path in (ROOT / "valid").glob("*envelope.json"):
        validate_envelope(json.loads(path.read_text(encoding="utf-8")), schema)
        valid_count += 1
    if valid_count == 0:
        raise ContractError("No valid contract fixtures were found")
    cases = json.loads((ROOT / "invalid" / "cases.json").read_text(encoding="utf-8"))
    for case in cases:
        mutated = mutate(golden, case)
        try:
            validate_envelope(mutated, schema)
        except ContractError:
            continue
        raise ContractError(f"Python accepted invalid fixture: {case['name']}")
    print(f"Python contract fixtures: {valid_count} valid, {len(cases)} invalid")


if __name__ == "__main__":
    main()

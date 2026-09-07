"""Offline single-primary-sequence alignment through MFA's Kalpy API."""
import hashlib
import json
import math
import re
import stat
import unicodedata
import wave
from pathlib import Path


def bounded_file(name, limit):
    path = Path(name)
    details = path.lstat()
    if not stat.S_ISREG(details.st_mode) or details.st_size > limit:
        raise ValueError("Invalid staged input")
    with path.open("rb") as source:
        value = source.read(limit + 1)
    if len(value) > limit:
        raise ValueError("Oversized staged input")
    return value


def align():
    request = json.loads(bounded_file("request.json", 256 * 1024))
    recipe = request["recipe"]
    document = request["document"]
    language = document["language"]
    duration = recipe["durationSamples"] / recipe["sampleRate"]
    if language not in ("en", "ru") or not 0 < duration <= 1200 or len(document["tokens"]) > 16000:
        raise ValueError("Unsupported Alignment input")
    audio = Path("audio.wav")
    if not stat.S_ISREG(audio.lstat().st_mode) or audio.stat().st_size > 1200 * 384000 * 2 + 44:
        raise ValueError("Invalid staged audio")
    with audio.open("rb") as source:
        if hashlib.file_digest(source, "sha256").hexdigest() != request["audioHash"]:
            raise ValueError("Staged audio changed")
    with wave.open(str(audio), "rb") as source:
        if (source.getnchannels(), source.getsampwidth(), source.getframerate(), source.getnframes()) != (1, 2, recipe["sampleRate"], recipe["durationSamples"]):
            raise ValueError("Staged audio dimensions changed")

    from kalpy.aligner import KalpyAligner
    from kalpy.data import Segment
    from kalpy.exceptions import AlignerError
    from kalpy.models import AcousticModel
    from kalpy.utterance import Utterance

    utf16 = document["text"].encode("utf-16-le")
    annotations = {line["id"] for line in document["lines"] if re.fullmatch(r"\s*[\[(].*[\])]\s*", utf16[2*line["startOffset"]:2*line["endOffset"]].decode("utf-16-le"))}
    normalized = [(token, unicodedata.normalize("NFKC", token["text"]).lower().replace("’", "'")) for token in document["tokens"]]
    wanted = {text for token, text in normalized if token["lineId"] not in annotations}
    found = set()
    dictionary = Path("dictionary.dict")
    if not stat.S_ISREG(dictionary.lstat().st_mode) or dictionary.stat().st_size > 128 * 1024 * 1024:
        raise ValueError("Invalid staged dictionary")
    with dictionary.open(encoding="utf8") as source, Path("temporary/selected.dict").open("w", encoding="utf8") as target:
        for line in iter(lambda: source.readline(16385), ""):
            if len(line) > 16384:
                raise ValueError("Oversized dictionary record")
            parts = line.split()
            if parts and parts[0].lower() in wanted:
                found.add(parts[0].lower())
                target.write(line)
    result = {"recipeHash": request["recipeHash"], "likelihood": 0, "words": []}
    alignable = [(token, text) for token, text in normalized if token["lineId"] not in annotations and text in found]
    positions = {token["id"]: index for index, (token, _) in enumerate(normalized)}
    windows = []
    cursor, previous_end = 0, 0
    for anchor in sorted(recipe["anchors"], key=lambda item: positions[item["firstTokenId"]]):
        first, last = positions[anchor["firstTokenId"]], positions[anchor["lastTokenId"]]
        if first < cursor or last < first or anchor["startSample"] < previous_end or anchor["endSample"] <= anchor["startSample"]:
            raise ValueError("Conflicting anchors")
        if cursor < first:
            windows.append((cursor, first, previous_end, anchor["startSample"]))
        windows.append((first, last + 1, anchor["startSample"], anchor["endSample"]))
        cursor, previous_end = last + 1, anchor["endSample"]
    if cursor < len(normalized):
        windows.append((cursor, len(normalized), previous_end, recipe["durationSamples"]))
    by_id = {}
    if alignable:
        model = AcousticModel(Path("acoustic") / ("english_mfa" if language == "en" else "russian_mfa"))
        lexicon = model.lexicon_compiler
        lexicon.load_pronunciations(Path("temporary/selected.dict"))
        engine = KalpyAligner(model, lexicon, beam=10, retry_beam=40)
        for first, last, start, end in windows:
            selected = [(token, text) for token, text in normalized[first:last] if token["lineId"] not in annotations and text in found]
            if not selected or end - start < recipe["sampleRate"] * .025:
                continue
            try:
                aligned = engine.align_utterance(Utterance(Segment(audio, start / recipe["sampleRate"], end / recipe["sampleRate"]), " ".join(text for _, text in selected)))
                if not math.isfinite(aligned.likelihood):
                    raise ValueError("Invalid Alignment score")
                result["likelihood"] += aligned.likelihood
                timings = [word for word in aligned.word_intervals if word.label != "<eps>"]
                if len(timings) == len(selected) and all(word.label == token[1] for word, token in zip(timings, selected)):
                    for token, timing in zip(selected, timings):
                        by_id[token[0]["id"]] = (timing, start, end)
            except AlignerError:
                # A graph with no viable acoustic path is an explicit musical abstention.
                continue
    for token, text in normalized:
        accepted = by_id.get(token["id"])
        reason = "annotation" if token["lineId"] in annotations else "oov" if text not in found else "alignment_mismatch"
        if accepted is not None:
            word, window_start, window_end = accepted
            start = max(window_start, round(word.begin * recipe["sampleRate"]))
            end = min(window_end, round(word.end * recipe["sampleRate"]))
            if start < end:
                result["words"].append({"tokenId": token["id"], "startSample": start, "endSample": end})
                continue
        result["words"].append({"tokenId": token["id"], "reason": reason})
    return result

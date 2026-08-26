"""Deterministic CPU-first musical analysis over canonical PCM WAV."""

from __future__ import annotations

import wave
from dataclasses import dataclass
from pathlib import Path
import re
from typing import Final, Literal

import numpy as np
from librosa import beat, feature, frames_to_samples, onset

from .analysis_profiles import PROFILE_SETTINGS

CANONICAL_SAMPLE_RATE: Final = 48_000
SUPPORTED_CAPABILITIES: Final = frozenset({"rhythm", "meter", "key", "chords", "sections"})
SHA256_PATTERN: Final = re.compile(r"^sha256:[a-f0-9]{64}$")
PITCH_CLASSES: Final = ("C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B")
MAJOR_KEY_PROFILE: Final = np.array(
    [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88],
    dtype=np.float64,
)
MINOR_KEY_PROFILE: Final = np.array(
    [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17],
    dtype=np.float64,
)

Capability = Literal["rhythm", "meter", "key", "chords", "sections"]
Profile = Literal["eco", "balanced", "fast"]
StageState = Literal["completed", "completed_with_abstentions"]
SettingValue = bool | int | float | str


@dataclass(frozen=True)
class VersionedComponent:
    id: str
    version: str
    hash: str

    def __post_init__(self) -> None:
        if not self.id or not self.version or SHA256_PATTERN.fullmatch(self.hash) is None:
            raise ValueError("analysis component provenance is invalid")

    def to_document(self) -> dict[str, str]:
        return {"hash": self.hash, "id": self.id, "version": self.version}


@dataclass(frozen=True)
class AnalysisProfile(VersionedComponent):
    name: Profile

    def __post_init__(self) -> None:
        super().__post_init__()
        if self.name not in PROFILE_SETTINGS:
            raise ValueError("analysis profile is unsupported")

    def to_document(self) -> dict[str, str]:
        return {**super().to_document(), "name": self.name}


@dataclass(frozen=True)
class AnalysisConfig:
    capabilities: tuple[Capability, ...]
    components: tuple[VersionedComponent, ...]
    numerical_backend: VersionedComponent
    profile: AnalysisProfile
    seeds: tuple[tuple[str, int], ...]
    settings: tuple[tuple[str, SettingValue], ...]

    def __post_init__(self) -> None:
        if not self.capabilities or len(set(self.capabilities)) != len(self.capabilities):
            raise ValueError("analysis capabilities must be non-empty and unique")
        if not set(self.capabilities) <= SUPPORTED_CAPABILITIES:
            raise ValueError("analysis capability is unsupported")
        if not self.components or len({component.id for component in self.components}) != len(
            self.components
        ):
            raise ValueError("analysis components must be non-empty with unique IDs")
        if not any(
            component.id == "open-chords-cpu-dsp" and component.version == "1.0.0"
            for component in self.components
        ):
            raise ValueError("analysis Recipe does not identify this CPU DSP implementation")
        if self.numerical_backend.id != "numpy" or self.numerical_backend.version != np.__version__:
            raise ValueError("analysis numerical backend does not match the runtime")
        if self.profile.id != self.profile.name or self.profile.version != "1.0.0":
            raise ValueError("analysis profile identity is unsupported")
        if not self.seeds or len({name for name, _value in self.seeds}) != len(self.seeds):
            raise ValueError("analysis seeds must be non-empty with unique names")
        if self.seeds != (("decoder", 0),):
            raise ValueError("analysis Recipe seeds do not match the deterministic decoder")
        if len({name for name, _value in self.settings}) != len(self.settings):
            raise ValueError("analysis settings must have unique names")
        if dict(self.settings) != PROFILE_SETTINGS[self.profile.name]:
            raise ValueError("analysis settings do not match the versioned resource profile")

    @property
    def hop_length(self) -> int:
        return int(dict(self.settings)["hopLength"])

    @property
    def n_fft(self) -> int:
        return int(dict(self.settings)["nFft"])

    @property
    def analysis_window_samples(self) -> int:
        return int(dict(self.settings)["analysisWindowSamples"])

    def to_recipe_document(self) -> dict[str, object]:
        requested = set(self.capabilities)
        capability_stages = []
        if requested & {"rhythm", "meter"}:
            capability_stages.append("rhythm")
        if requested & {"key", "chords"}:
            capability_stages.append("harmony")
        if "sections" in requested:
            capability_stages.append("sections")
        return {
            "capabilities": list(self.capabilities),
            "components": [component.to_document() for component in self.components],
            "numericalBackend": self.numerical_backend.to_document(),
            "pipeline": [
                "preflight",
                "canonical_decode",
                "shared_features",
                *capability_stages,
                "assemble",
                "main_validation",
                "publish",
            ],
            "profile": self.profile.to_document(),
            "seeds": dict(self.seeds),
            "settings": dict(self.settings),
        }

    @classmethod
    def from_recipe_document(cls, document: object) -> AnalysisConfig:
        if not isinstance(document, dict) or set(document) != {
            "capabilities",
            "components",
            "numericalBackend",
            "pipeline",
            "profile",
            "seeds",
            "settings",
        }:
            raise ValueError("analysis Recipe has an invalid shape")
        capabilities = document["capabilities"]
        components = document["components"]
        profile = document["profile"]
        seeds = document["seeds"]
        settings = document["settings"]
        if not isinstance(capabilities, list) or not all(
            isinstance(capability, str) for capability in capabilities
        ):
            raise ValueError("analysis Recipe capabilities are invalid")
        if not isinstance(components, list):
            raise ValueError("analysis Recipe components are invalid")
        if not isinstance(profile, dict) or set(profile) != {"hash", "id", "name", "version"}:
            raise ValueError("analysis Recipe profile is invalid")
        if not isinstance(seeds, dict) or not all(
            isinstance(name, str) and name and type(value) is int for name, value in seeds.items()
        ):
            raise ValueError("analysis Recipe seeds are invalid")
        if not isinstance(settings, dict) or not all(
            isinstance(name, str)
            and name
            and type(value) in {bool, int, float, str}
            for name, value in settings.items()
        ):
            raise ValueError("analysis Recipe settings are invalid")
        config = cls(
            capabilities=tuple(capabilities),
            components=tuple(_parse_component(component) for component in components),
            numerical_backend=_parse_component(document["numericalBackend"]),
            profile=AnalysisProfile(
                hash=_required_string(profile, "hash"),
                id=_required_string(profile, "id"),
                name=_required_string(profile, "name"),
                version=_required_string(profile, "version"),
            ),
            seeds=tuple(sorted(seeds.items())),
            settings=tuple(sorted(settings.items())),
        )
        if document["pipeline"] != config.to_recipe_document()["pipeline"]:
            raise ValueError("analysis Recipe pipeline does not match its capabilities")
        return config


@dataclass(frozen=True)
class AnalysisResult:
    duration_samples: int
    sample_rate: int
    stage_outcomes: tuple[tuple[str, StageState], ...]
    support_claim_ids: tuple[str, ...]
    timeline: dict[str, list[dict[str, object]]]
    warnings: tuple[str, ...]
    recipe: dict[str, object]

    def to_document(self) -> dict[str, object]:
        return {
            "durationSamples": self.duration_samples,
            "sampleRate": self.sample_rate,
            "stageOutcomes": [
                {"stage": stage, "state": state} for stage, state in self.stage_outcomes
            ],
            "supportClaimIds": list(self.support_claim_ids),
            "timeline": self.timeline,
            "warnings": list(self.warnings),
            "recipe": self.recipe,
        }


def _parse_component(document: object) -> VersionedComponent:
    if not isinstance(document, dict) or set(document) != {"hash", "id", "version"}:
        raise ValueError("analysis Recipe component is invalid")
    return VersionedComponent(
        hash=_required_string(document, "hash"),
        id=_required_string(document, "id"),
        version=_required_string(document, "version"),
    )


def _required_string(document: dict[object, object], key: str) -> str:
    value = document.get(key)
    if not isinstance(value, str) or not value:
        raise ValueError(f"analysis Recipe {key} is invalid")
    return value


def analyze_canonical(path: Path, config: AnalysisConfig) -> AnalysisResult:
    """Analyze one exact canonical WAV without decoding or resampling it again."""

    samples, sample_rate = _read_canonical_wav(path)
    duration_samples = int(samples.size)
    feature_samples = np.pad(samples, (0, max(0, config.n_fft - duration_samples)))
    onset_envelope = onset.onset_strength(
        y=feature_samples,
        sr=sample_rate,
        n_fft=config.n_fft,
        hop_length=config.hop_length,
        center=False,
    )
    chroma = feature.chroma_stft(
        y=feature_samples,
        sr=sample_rate,
        n_fft=config.n_fft,
        hop_length=config.hop_length,
        center=False,
        tuning=0.0,
    )
    frame_rms = feature.rms(
        y=feature_samples,
        frame_length=config.n_fft,
        hop_length=config.hop_length,
        center=False,
    )[0]
    rms = float(np.sqrt(np.mean(np.square(samples), dtype=np.float64)))
    if rms <= np.finfo(np.float32).eps and not np.any(onset_envelope) and not np.any(chroma):
        return _silent_result(duration_samples, sample_rate, config)

    requested = set(config.capabilities)
    if requested & {"rhythm", "meter"}:
        bars, unmetered_regions = _decode_rhythm(
            onset_envelope, sample_rate, duration_samples, config.hop_length
        )
    else:
        bars, unmetered_regions = [], [
            _unmetered(
                0,
                duration_samples,
                0,
                reason_code="meter_capability_not_requested",
            )
        ]
    windows = _analysis_windows(
        chroma.shape[1], duration_samples, config.hop_length, config.analysis_window_samples
    )
    chord_events = (
        _decode_chords(chroma, frame_rms, windows)
        if "chords" in requested
        else [_unrequested_interval("chord", duration_samples, {"kind": "no_chord"})]
    )
    key_regions = (
        _decode_key_regions(chroma, frame_rms, windows)
        if "key" in requested
        else [_unrequested_interval("key", duration_samples, {"kind": "unknown"})]
    )
    section_regions = (
        _decode_sections(chroma, frame_rms, duration_samples, windows)
        if "sections" in requested
        else [_unrequested_section(duration_samples)]
    )
    rhythm_abstained = bool(unmetered_regions) or not bars
    requested_harmony = []
    if "chords" in requested:
        requested_harmony.extend(chord_events)
    if "key" in requested:
        requested_harmony.extend(key_regions)
    harmony_abstained = any(
        item["assertion"]["state"] == "abstained" for item in requested_harmony
    )
    section_abstained = any(
        item["assertion"]["state"] == "abstained" for item in section_regions
    )
    outcomes: list[tuple[str, StageState]] = [("shared_features", "completed")]
    if requested & {"rhythm", "meter"}:
        outcomes.append(
            ("rhythm", "completed_with_abstentions" if rhythm_abstained else "completed")
        )
    if requested & {"key", "chords"}:
        outcomes.append(
            ("harmony", "completed_with_abstentions" if harmony_abstained else "completed")
        )
    if "sections" in requested:
        outcomes.append(
            ("sections", "completed_with_abstentions" if section_abstained else "completed")
        )
    outcomes.append(("assemble", "completed"))
    return AnalysisResult(
        duration_samples=duration_samples,
        sample_rate=sample_rate,
        stage_outcomes=tuple(outcomes),
        support_claim_ids=(),
        timeline={
            "bars": bars,
            "chordEvents": chord_events,
            "keyRegions": key_regions,
            "sectionRegions": section_regions,
            "unmeteredRegions": unmetered_regions,
        },
        warnings=("CPU baseline output is uncalibrated and carries no Support Claim",),
        recipe=config.to_recipe_document(),
    )


def _silent_result(
    duration_samples: int, sample_rate: int, config: AnalysisConfig
) -> AnalysisResult:
    abstained = {
        "evidence": [{"name": "frame_rms", "scale": "linear", "value": 0.0}],
        "reasonCodes": ["insufficient_energy"],
        "state": "abstained",
    }
    requested = set(config.capabilities)
    timeline: dict[str, list[dict[str, object]]] = {
        "bars": [],
        "chordEvents": [
            {
                "assertion": abstained,
                "endSample": duration_samples,
                "id": "chord_0000",
                "startSample": 0,
                "value": {"kind": "no_chord"},
            }
        ]
        if "chords" in requested
        else [_unrequested_interval("chord", duration_samples, {"kind": "no_chord"})],
        "keyRegions": [
            {
                "assertion": abstained,
                "endSample": duration_samples,
                "id": "key_0000",
                "startSample": 0,
                "value": {"kind": "unknown"},
            }
        ]
        if "key" in requested
        else [_unrequested_interval("key", duration_samples, {"kind": "unknown"})],
        "sectionRegions": [
            {
                "assertion": abstained,
                "endSample": duration_samples,
                "id": "section_0000",
                "label": "unknown",
                "startSample": 0,
            }
        ]
        if "sections" in requested
        else [_unrequested_section(duration_samples)],
        "unmeteredRegions": [
            {
                "endSample": duration_samples,
                "id": "unmetered_0000",
                "reasonCode": "meter_insufficient_evidence"
                if requested & {"rhythm", "meter"}
                else "meter_capability_not_requested",
                "startSample": 0,
            }
        ],
    }
    return AnalysisResult(
        duration_samples=duration_samples,
        sample_rate=sample_rate,
        stage_outcomes=_stage_outcomes(config.capabilities, abstained=True),
        support_claim_ids=(),
        timeline=timeline,
        warnings=("All requested musical capabilities abstained because energy was insufficient",),
        recipe=config.to_recipe_document(),
    )


def _decode_rhythm(
    onset_envelope: np.ndarray,
    sample_rate: int,
    duration_samples: int,
    hop_length: int,
) -> tuple[list[dict[str, object]], list[dict[str, object]]]:
    _tempo, beat_frames = beat.beat_track(
        onset_envelope=onset_envelope,
        sr=sample_rate,
        hop_length=hop_length,
        sparse=True,
    )
    beat_samples = [
        int(sample)
        for sample in frames_to_samples(beat_frames, hop_length=hop_length)
        if 0 <= int(sample) < duration_samples
    ]
    if len(beat_samples) < 5:
        return [], [_unmetered(0, duration_samples, 0)]
    intervals = np.diff(np.asarray(beat_samples, dtype=np.float64))
    median_interval = float(np.median(intervals))
    if median_interval <= 0 or float(np.std(intervals) / median_interval) > 0.15:
        return [], [_unmetered(0, duration_samples, 0)]

    # Stable beat spacing establishes tempo, not meter or downbeat phase. Until a
    # dedicated meter decoder provides both, publishing Bars would fabricate 4/4.
    return [], [_unmetered(0, duration_samples, 0)]


def _unmetered(
    start_sample: int,
    end_sample: int,
    index: int,
    *,
    reason_code: str = "meter_insufficient_evidence",
) -> dict[str, object]:
    return {
        "endSample": end_sample,
        "id": f"unmetered_{index:04d}",
        "reasonCode": reason_code,
        "startSample": start_sample,
    }


def _unrequested_interval(
    prefix: str, duration_samples: int, value: dict[str, object]
) -> dict[str, object]:
    return {
        "assertion": {
            "evidence": [],
            "reasonCodes": ["capability_not_requested"],
            "state": "abstained",
        },
        "endSample": duration_samples,
        "id": f"{prefix}_0000",
        "startSample": 0,
        "value": value,
    }


def _unrequested_section(duration_samples: int) -> dict[str, object]:
    return {
        "assertion": {
            "evidence": [],
            "reasonCodes": ["capability_not_requested"],
            "state": "abstained",
        },
        "endSample": duration_samples,
        "id": "section_0000",
        "label": "unknown",
        "startSample": 0,
    }


def _decode_key_value(vector: np.ndarray) -> tuple[dict[str, str], dict[str, object]]:
    candidates: list[tuple[float, int, str]] = []
    for tonic in range(12):
        candidates.append((_cosine(vector, np.roll(MAJOR_KEY_PROFILE, tonic)), tonic, "major"))
        candidates.append((_cosine(vector, np.roll(MINOR_KEY_PROFILE, tonic)), tonic, "minor"))
    candidates.sort(key=lambda candidate: (-candidate[0], candidate[2], candidate[1]))
    score, tonic, mode = candidates[0]
    margin = score - candidates[1][0]
    return (
        {"kind": "key", "mode": mode, "tonic": PITCH_CLASSES[tonic]},
        _low_confidence(
            "key_profile_margin", "cosine_margin", margin, "uncalibrated_key_profile"
        ),
    )


def _decode_chord_value(vector: np.ndarray) -> tuple[dict[str, object], dict[str, object]]:
    intervals_by_quality = {
        "major": (0, 4, 7),
        "minor": (0, 3, 7),
        "diminished": (0, 3, 6),
        "augmented": (0, 4, 8),
        "sus2": (0, 2, 7),
        "sus4": (0, 5, 7),
        "major7": (0, 4, 7, 11),
        "minor7": (0, 3, 7, 10),
        "diminished7": (0, 3, 6, 9),
        "half_diminished": (0, 3, 6, 10),
    }
    candidates: list[tuple[float, int, str]] = []
    for tonic in range(12):
        for quality, intervals in intervals_by_quality.items():
            template = np.zeros(12, dtype=np.float64)
            template[[(tonic + interval) % 12 for interval in intervals]] = 1.0
            candidates.append((_cosine(vector, template), tonic, quality))
    candidates.sort(key=lambda candidate: (-candidate[0], candidate[2], candidate[1]))
    score, tonic, quality = candidates[0]
    margin = score - candidates[1][0]
    return (
        {
            "additions": [],
            "alterations": [],
            "extensions": [],
            "kind": "chord",
            "omissions": [],
            "quality": quality,
            "root": PITCH_CLASSES[tonic],
        },
        _low_confidence(
            "chord_template_margin", "cosine_margin", margin, "uncalibrated_chord_template"
        ),
    )


def _decode_chords(
    chroma: np.ndarray,
    frame_rms: np.ndarray,
    windows: list[tuple[int, int, np.ndarray]],
) -> list[dict[str, object]]:
    events: list[dict[str, object]] = []
    for start_sample, end_sample, frame_indices in windows:
        rms = _window_energy(frame_rms, frame_indices)
        if rms <= 0.005:
            value: dict[str, object] = {"kind": "no_chord"}
            assertion = _low_confidence(
                "frame_rms", "linear", rms, "uncalibrated_no_chord_threshold"
            )
        else:
            value, assertion = _decode_chord_value(
                np.mean(chroma[:, frame_indices], axis=1, dtype=np.float64)
            )
        _append_or_extend(events, "chord", start_sample, end_sample, value, assertion)
    return events


def _decode_key_regions(
    chroma: np.ndarray,
    frame_rms: np.ndarray,
    windows: list[tuple[int, int, np.ndarray]],
) -> list[dict[str, object]]:
    regions: list[dict[str, object]] = []
    for start_sample, end_sample, frame_indices in windows:
        rms = _window_energy(frame_rms, frame_indices)
        if rms <= 0.005:
            value: dict[str, object] = {"kind": "unknown"}
            assertion = _abstained(
                "frame_rms", "linear", rms, "key_insufficient_energy"
            )
        else:
            value, assertion = _decode_key_value(
                np.mean(chroma[:, frame_indices], axis=1, dtype=np.float64)
            )
        _append_or_extend(regions, "key", start_sample, end_sample, value, assertion)
    return regions


def _decode_sections(
    chroma: np.ndarray,
    frame_rms: np.ndarray,
    duration_samples: int,
    windows: list[tuple[int, int, np.ndarray]],
) -> list[dict[str, object]]:
    window_vectors = np.stack(
        [np.mean(chroma[:, frame_indices], axis=1, dtype=np.float64) for _, _, frame_indices in windows],
        axis=1,
    )
    affinity = _mean_cosine_affinity(window_vectors)
    boundaries = [0]
    previous_vector: np.ndarray | None = None
    previous_silent: bool | None = None
    for start_sample, _end_sample, frame_indices in windows:
        vector = np.mean(chroma[:, frame_indices], axis=1, dtype=np.float64)
        rms = _window_energy(frame_rms, frame_indices)
        silent = rms <= 0.005
        if previous_vector is not None and (
            silent != previous_silent or (not silent and 1.0 - _cosine(previous_vector, vector) >= 0.2)
        ):
            boundaries.append(start_sample)
        previous_vector = vector
        previous_silent = silent
    boundaries.append(duration_samples)
    boundaries = sorted(set(boundaries))
    sections: list[dict[str, object]] = []
    for start_sample, end_sample in zip(boundaries, boundaries[1:]):
        if end_sample <= start_sample:
            continue
        energies = [
            _window_energy(frame_rms, indices)
            for window_start, _window_end, indices in windows
            if start_sample <= window_start < end_sample
        ]
        silent = not energies or max(energies) <= 0.005
        sections.append(
            {
                "assertion": _abstained(
                    "frame_rms", "linear", max(energies, default=0.0), "section_insufficient_energy"
                )
                if silent
                else _low_confidence(
                    "recurrence_mean_affinity",
                    "cosine_affinity",
                    affinity,
                    "uncalibrated_generic_boundary",
                ),
                "endSample": end_sample,
                "id": f"section_{len(sections):04d}",
                "label": "unknown" if silent else "neutral",
                "startSample": start_sample,
            }
        )
    return sections


def _mean_cosine_affinity(window_vectors: np.ndarray) -> float:
    norms = np.linalg.norm(window_vectors, axis=0)
    nonzero = norms > 0
    if not np.any(nonzero):
        return 0.0
    normalized = window_vectors[:, nonzero] / norms[nonzero]
    vector_sum = np.sum(normalized, axis=1, dtype=np.float64)
    count = normalized.shape[1]
    return max(0.0, min(1.0, float(np.dot(vector_sum, vector_sum) / (count * count))))


def _analysis_windows(
    frame_count: int,
    duration_samples: int,
    hop_length: int,
    window_samples: int,
) -> list[tuple[int, int, np.ndarray]]:
    boundaries = list(range(0, duration_samples, window_samples)) + [duration_samples]
    frame_samples = np.arange(frame_count, dtype=np.int64) * hop_length
    windows: list[tuple[int, int, np.ndarray]] = []
    for start_sample, end_sample in zip(boundaries, boundaries[1:]):
        indices = np.flatnonzero((frame_samples >= start_sample) & (frame_samples < end_sample))
        if indices.size == 0:
            indices = np.array([min(frame_count - 1, start_sample // hop_length)], dtype=np.int64)
        windows.append((start_sample, end_sample, indices))
    return windows


def _window_energy(values: np.ndarray, indices: np.ndarray) -> float:
    value = float(np.median(values[indices]))
    return value if np.isfinite(value) else 0.0


def _append_or_extend(
    track: list[dict[str, object]],
    prefix: str,
    start_sample: int,
    end_sample: int,
    value: dict[str, object],
    assertion: dict[str, object],
) -> None:
    if track and track[-1]["value"] == value and track[-1]["assertion"] == assertion:
        track[-1]["endSample"] = end_sample
        return
    track.append(
        {
            "assertion": assertion,
            "endSample": end_sample,
            "id": f"{prefix}_{len(track):04d}",
            "startSample": start_sample,
            "value": value,
        }
    )


def _low_confidence(name: str, scale: str, value: float, reason: str) -> dict[str, object]:
    return {
        "evidence": [{"name": name, "scale": scale, "value": _evidence_value(value)}],
        "reasonCodes": [reason],
        "state": "low_confidence",
    }


def _abstained(name: str, scale: str, value: float, reason: str) -> dict[str, object]:
    return {
        "evidence": [{"name": name, "scale": scale, "value": _evidence_value(value)}],
        "reasonCodes": [reason],
        "state": "abstained",
    }


def _cosine(left: np.ndarray, right: np.ndarray) -> float:
    denominator = float(np.linalg.norm(left) * np.linalg.norm(right))
    if denominator == 0.0 or not np.isfinite(denominator):
        return 0.0
    value = float(np.dot(left, right) / denominator)
    return value if np.isfinite(value) else 0.0


def _evidence_value(value: float) -> float:
    finite = float(value)
    return round(finite, 8) if np.isfinite(finite) else 0.0


def _read_canonical_wav(path: Path) -> tuple[np.ndarray, int]:
    with wave.open(str(path), "rb") as canonical:
        if (
            canonical.getnchannels() != 1
            or canonical.getsampwidth() != 2
            or canonical.getframerate() != CANONICAL_SAMPLE_RATE
            or canonical.getcomptype() != "NONE"
            or canonical.getnframes() <= 0
        ):
            raise ValueError("analysis input must be non-empty canonical mono PCM16 at 48 kHz")
        frame_count = canonical.getnframes()
        content = canonical.readframes(frame_count)
    if len(content) != frame_count * 2:
        raise ValueError("canonical WAV ended before its declared sample count")
    return np.frombuffer(content, dtype="<i2").astype(np.float32) / 32768.0, CANONICAL_SAMPLE_RATE


def _stage_outcomes(
    capabilities: tuple[Capability, ...], *, abstained: bool
) -> tuple[tuple[str, StageState], ...]:
    requested = set(capabilities)
    state: StageState = "completed_with_abstentions" if abstained else "completed"
    outcomes: list[tuple[str, StageState]] = [("shared_features", "completed")]
    if requested & {"rhythm", "meter"}:
        outcomes.append(("rhythm", state))
    if requested & {"key", "chords"}:
        outcomes.append(("harmony", state))
    if "sections" in requested:
        outcomes.append(("sections", state))
    outcomes.append(("assemble", "completed"))
    return tuple(outcomes)

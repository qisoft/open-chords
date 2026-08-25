from __future__ import annotations

import tempfile
import unittest
import wave
import math
from pathlib import Path

from sidecar.open_chords_analysis.cpu_analysis import (
    PROFILE_SETTINGS,
    AnalysisConfig,
    AnalysisProfile,
    VersionedComponent,
    analyze_canonical,
)


class CpuAnalysisTests(unittest.TestCase):
    def test_silence_produces_complete_deterministic_abstentions(self) -> None:
        with tempfile.TemporaryDirectory(prefix="open-chords-cpu-analysis-") as temporary:
            canonical = Path(temporary) / "canonical.wav"
            self._write_mono_fixture(canonical, [0] * 48_000)
            config = self._config(("rhythm", "meter", "key", "chords", "sections"))

            first = analyze_canonical(canonical, config)
            second = analyze_canonical(canonical, config)

            self.assertEqual(first, second)
            self.assertEqual(first.sample_rate, 48_000)
            self.assertEqual(first.duration_samples, 48_000)
            self.assertEqual(first.support_claim_ids, ())
            self.assertEqual(
                first.stage_outcomes,
                (
                    ("shared_features", "completed"),
                    ("rhythm", "completed_with_abstentions"),
                    ("harmony", "completed_with_abstentions"),
                    ("sections", "completed_with_abstentions"),
                    ("assemble", "completed"),
                ),
            )
            self.assertEqual(first.timeline["bars"], [])
            self.assertEqual(
                first.timeline["unmeteredRegions"],
                [
                    {
                        "endSample": 48_000,
                        "id": "unmetered_0000",
                        "reasonCode": "meter_insufficient_evidence",
                        "startSample": 0,
                    }
                ],
            )
            self.assertEqual(first.timeline["chordEvents"][0]["value"], {"kind": "no_chord"})
            self.assertEqual(
                first.timeline["chordEvents"][0]["assertion"],
                {
                    "evidence": [{"name": "frame_rms", "scale": "linear", "value": 0.0}],
                    "reasonCodes": ["insufficient_energy"],
                    "state": "abstained",
                },
            )
            self.assertEqual(first.timeline["keyRegions"][0]["value"], {"kind": "unknown"})
            self.assertEqual(first.timeline["sectionRegions"][0]["label"], "unknown")
            for track in ("chordEvents", "keyRegions", "sectionRegions"):
                self.assertEqual(
                    [(item["startSample"], item["endSample"]) for item in first.timeline[track]],
                    [(0, 48_000)],
                )

    def test_weight_free_fixture_produces_low_confidence_complete_tracks(self) -> None:
        with tempfile.TemporaryDirectory(prefix="open-chords-cpu-analysis-tonal-") as temporary:
            canonical = Path(temporary) / "canonical.wav"
            samples = self._c_major_click_fixture(duration_samples=8 * 48_000)
            self._write_mono_fixture(canonical, samples)
            config = self._config(("rhythm", "meter", "key", "chords", "sections"))

            first = analyze_canonical(canonical, config)
            second = analyze_canonical(canonical, config)

            self.assertEqual(first, second)
            self.assertEqual(first.support_claim_ids, ())
            self.assertTrue(first.timeline["bars"])
            self.assertEqual(first.timeline["keyRegions"][0]["value"], {
                "kind": "key",
                "mode": "major",
                "tonic": "C",
            })
            self.assertEqual(first.timeline["keyRegions"][0]["assertion"]["state"], "low_confidence")
            self.assertEqual(first.timeline["chordEvents"][0]["value"], {
                "additions": [],
                "alterations": [],
                "extensions": [],
                "kind": "chord",
                "omissions": [],
                "quality": "major",
                "root": "C",
            })
            self.assertEqual(first.timeline["chordEvents"][0]["assertion"]["state"], "low_confidence")
            section = first.timeline["sectionRegions"][0]
            self.assertEqual(section["label"], "neutral")
            self.assertEqual(section["assertion"]["state"], "low_confidence")
            self.assertEqual(
                section["assertion"]["evidence"][0]["name"], "recurrence_mean_affinity"
            )
            self.assertGreaterEqual(section["assertion"]["evidence"][0]["value"], 0.0)
            self.assertLessEqual(section["assertion"]["evidence"][0]["value"], 1.0)
            self._assert_track_cover(first.timeline["chordEvents"], 8 * 48_000)
            self._assert_track_cover(first.timeline["keyRegions"], 8 * 48_000)
            self._assert_track_cover(first.timeline["sectionRegions"], 8 * 48_000)
            self._assert_track_cover(
                sorted(
                    first.timeline["bars"] + first.timeline["unmeteredRegions"],
                    key=lambda item: item["startSample"],
                ),
                8 * 48_000,
            )

    def test_chord_and_section_decoders_preserve_silence_and_harmonic_changes(self) -> None:
        with tempfile.TemporaryDirectory(prefix="open-chords-cpu-analysis-sections-") as temporary:
            canonical = Path(temporary) / "canonical.wav"
            samples = (
                self._tonal_samples(4 * 48_000, ((261.625565, 0.25), (329.627557, 0.10), (391.995436, 0.10)))
                + [0] * (2 * 48_000)
                + self._tonal_samples(4 * 48_000, ((220.0, 0.25), (261.625565, 0.10), (329.627557, 0.10)))
            )
            self._write_mono_fixture(canonical, samples)

            result = analyze_canonical(
                canonical,
                self._config(("key", "chords", "sections")),
            )

            values = [event["value"] for event in result.timeline["chordEvents"]]
            self.assertEqual(values[0]["root"], "C")
            self.assertEqual(values[0]["quality"], "major")
            self.assertIn({"kind": "no_chord"}, values)
            self.assertEqual(values[-1]["root"], "A")
            self.assertEqual(values[-1]["quality"], "minor")
            self.assertGreaterEqual(len(result.timeline["sectionRegions"]), 2)
            self.assertIn(
                ("unknown", "abstained"),
                [
                    (section["label"], section["assertion"]["state"])
                    for section in result.timeline["sectionRegions"]
                ],
            )
            self._assert_track_cover(result.timeline["chordEvents"], 10 * 48_000)
            self._assert_track_cover(result.timeline["keyRegions"], 10 * 48_000)
            self._assert_track_cover(result.timeline["sectionRegions"], 10 * 48_000)
            self.assertEqual(result.support_claim_ids, ())
            self.assertEqual(
                [stage for stage, _state in result.stage_outcomes],
                ["shared_features", "harmony", "sections", "assemble"],
            )

    def test_every_profile_is_recipe_bound_and_deterministic(self) -> None:
        with tempfile.TemporaryDirectory(prefix="open-chords-cpu-analysis-profiles-") as temporary:
            canonical = Path(temporary) / "canonical.wav"
            self._write_mono_fixture(canonical, self._c_major_click_fixture(4 * 48_000))

            for profile in ("eco", "balanced", "fast"):
                with self.subTest(profile=profile):
                    config = self._config(("chords",), profile=profile)
                    first = analyze_canonical(canonical, config)
                    second = analyze_canonical(canonical, config)

                    self.assertEqual(first, second)
                    self.assertEqual(first.recipe, config.to_recipe_document())
                    self.assertEqual(first.recipe["profile"]["name"], profile)
                    self.assertEqual(first.recipe["settings"], PROFILE_SETTINGS[profile])
                    self.assertIn(("harmony", "completed"), first.stage_outcomes)
                    self.assertEqual(
                        first.timeline["keyRegions"][0]["assertion"]["reasonCodes"],
                        ["capability_not_requested"],
                    )
                    self.assertEqual(
                        first.timeline["sectionRegions"][0]["assertion"]["reasonCodes"],
                        ["capability_not_requested"],
                    )

    def test_rejects_recipe_runtime_and_canonical_input_mismatches(self) -> None:
        config = self._config(("chords",))
        recipe = config.to_recipe_document()
        recipe["settings"] = {**recipe["settings"], "hopLength": 7}
        with self.assertRaisesRegex(ValueError, "resource profile"):
            AnalysisConfig.from_recipe_document(recipe)

        with tempfile.TemporaryDirectory(prefix="open-chords-cpu-analysis-invalid-") as temporary:
            stereo = Path(temporary) / "stereo.wav"
            with wave.open(str(stereo), "wb") as fixture:
                fixture.setnchannels(2)
                fixture.setsampwidth(2)
                fixture.setframerate(48_000)
                fixture.writeframes(b"\0\0\0\0")
            with self.assertRaisesRegex(ValueError, "canonical mono PCM16"):
                analyze_canonical(stereo, config)

    @staticmethod
    def _config(
        capabilities: tuple[str, ...], *, profile: str = "balanced"
    ) -> AnalysisConfig:
        return AnalysisConfig(
            capabilities=capabilities,
            components=(
                VersionedComponent(
                    id="open-chords-cpu-dsp",
                    version="1.0.0",
                    hash=f"sha256:{'1' * 64}",
                ),
            ),
            numerical_backend=VersionedComponent(
                id="numpy",
                version="2.5.2",
                hash=f"sha256:{'2' * 64}",
            ),
            profile=AnalysisProfile(
                id=profile,
                name=profile,
                version="1.0.0",
                hash=f"sha256:{'3' * 64}",
            ),
            seeds=(("decoder", 0),),
            settings=tuple(PROFILE_SETTINGS[profile].items()),
        )

    @staticmethod
    def _assert_track_cover(track: list[dict[str, object]], duration_samples: int) -> None:
        cursor = 0
        for item in track:
            assert item["startSample"] == cursor
            cursor = int(item["endSample"])
        assert cursor == duration_samples

    @staticmethod
    def _c_major_click_fixture(duration_samples: int) -> list[int]:
        sample_rate = 48_000
        frequencies = ((261.625565, 0.25), (329.627557, 0.10), (391.995436, 0.10))
        samples: list[int] = []
        for index in range(duration_samples):
            tonal = sum(
                amplitude * math.sin(2 * math.pi * frequency * index / sample_rate)
                for frequency, amplitude in frequencies
            )
            within_beat = index % (sample_rate // 2)
            click = 1.0 - within_beat / 240 if within_beat < 240 else 0.0
            value = max(-1.0, min(1.0, tonal + click * 0.65))
            samples.append(round(value * 30_000))
        return samples

    @staticmethod
    def _tonal_samples(
        duration_samples: int, frequencies: tuple[tuple[float, float], ...]
    ) -> list[int]:
        sample_rate = 48_000
        return [
            round(
                max(
                    -1.0,
                    min(
                        1.0,
                        sum(
                            amplitude
                            * math.sin(2 * math.pi * frequency * index / sample_rate)
                            for frequency, amplitude in frequencies
                        ),
                    ),
                )
                * 30_000
            )
            for index in range(duration_samples)
        ]

    @staticmethod
    def _write_mono_fixture(path: Path, samples: list[int]) -> None:
        with wave.open(str(path), "wb") as fixture:
            fixture.setnchannels(1)
            fixture.setsampwidth(2)
            fixture.setframerate(48_000)
            fixture.writeframes(
                b"".join(sample.to_bytes(2, "little", signed=True) for sample in samples)
            )


if __name__ == "__main__":
    unittest.main()

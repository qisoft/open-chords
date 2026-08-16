# Open Chords v1: CPU-first analysis stack

> Decision research for “Validate the CPU-first analysis and lyrics stack”. Sources were checked on 2026-08-12. This is an engineering and license-inventory recommendation, not legal advice and not a quality claim.

## Decision

There is no current, maintained, redistributable component that credibly satisfies the whole v1 analysis contract. Use a deliberately split stack and treat every learned system as an optional benchmark candidate until measured on the Open Chords corpus.

The release-candidate baseline should be:

1. a pinned, project-built **FFmpeg** executable for decode/resample to canonical PCM WAV;
2. **librosa 0.11.x** plus small Open Chords DSP/decoding code for reproducible beat/tempo, chroma, key-profile, section-boundary, and chord-template baselines;
3. **Essentia** as an AGPL-compatible, no-weight comparison backend for beat/tempo, key, and major/minor chord baselines, not as evidence that rich chords or meter are solved;
4. **Montreal Forced Aligner (MFA) 3.4.x** with separately pinned EN/RU acoustic models and dictionaries for reference-lyrics alignment, behind a failure-preserving adapter;
5. benchmark-only lanes for **BeatNet**, **Chordino**, and **All-In-One**. None belongs in the default release path until its licensing/provenance, packaging, CPU runtime, and corpus results pass the release gate.

This supersedes the older research suggestion to make Demucs/Spleeter, Whisper/WhisperX, BTC, or Qwen forced alignment part of the first stack. Source separation, STT, and LLMs are explicitly outside v1; BTC checkpoints still lack a release-grade weight/model card; and All-In-One is architecturally based on demixed stems.

## Required boundaries

- Decode exactly once. Record input hash, FFmpeg version/configuration, command, channel layout, output sample rate, sample count, and any trim/offset. All downstream times derive from integer sample indices in this canonical file.
- Keep raw outputs from every analyzer. Meter, beat, chord, section, and word edits are overlays; a user edit never rewrites machine evidence.
- A library saying `cpu` only proves an execution path exists. It does not establish acceptable real-time factor, RAM, thermals, determinism, or quality.
- “Redistributable” is evaluated per layer: code, weights/model archives, training material/provenance, and benchmark/evaluation material. One permissive layer does not clear another.

## Candidate matrix

| Capability | Default baseline | Benchmark candidates | What remains unsupported before measurement |
|---|---|---|---|
| Decode/timebase | Pinned FFmpeg CLI -> PCM WAV; preserve sample-index origin | A second pinned FFmpeg build as a cross-platform conformance check | Identical decoder behavior cannot be assumed across arbitrary system FFmpeg builds. |
| Beat/tempo | `librosa.beat.beat_track`; Essentia `RhythmExtractor2013` comparison | BeatNet offline/online CPU | Variable-tempo accuracy, confidence calibration, and stable behavior on 2/4, 3/4, 4/4, 6/8 need corpus evidence. |
| Downbeat/meter | Conservative accent/periodicity baseline that can abstain; manual correction is normative | BeatNet; All-In-One only as an out-of-scope architectural comparison | No selected clean default currently proves all four official automatic meters or meter changes. |
| Key | Chroma/HPCP plus fixed, versioned 24-key profile correlation; Essentia `KeyExtractor` comparison | none required initially | Modes beyond major/minor and local/modulating key are not promised. Confidence needs calibration. |
| Sections | librosa recurrence/self-similarity plus novelty boundary baseline; labels initially generic (`section`) | All-In-One functional labels | Reliable semantic labels such as verse/chorus are not established, especially without source separation. |
| Chords | Beat-aware chroma/template decoder with `N`, rich candidate templates, temporal smoothing, and explicit abstention | Chordino; Essentia major/minor floor; any learned recognizer only after a model manifest | Rich-vocabulary recognition, inversions/slash bass, and calibrated confidence are not established. The UI vocabulary is a representation requirement, not proof the analyzer can infer every symbol. |
| EN/RU lyric alignment | MFA with supplied reference text, pinned language model/dictionary, chunk/line anchors, OOV reporting | MFA parameter/model variants; mix vs light harmonic filtering | The official MFA models are trained on speech, not singing. Melisma, backing vocals, repeated lines, accompaniment, OOVs, and code-switching require measurement and manual fallback. |

## Component and license inventory

### FFmpeg: canonical decode

FFmpeg is the credible cross-platform decoder/resampler. Its official repository describes `libavcodec`, `libavformat`, and `libswresample`, and says the codebase is mainly LGPL with optional GPL components ([FFmpeg README](https://github.com/FFmpeg/FFmpeg#readme)). Consequently, “FFmpeg” is not one license outcome: the exact `configure` flags and linked codec libraries determine the binary obligations.

- **Code:** LGPL-2.1-or-later by default, with GPL paths/components possible; ship source/notices and relinking-compliant artifacts as required by the chosen build.
- **Weights:** none.
- **Training data:** none.
- **Evaluation data:** none bundled by FFmpeg.
- **CPU/platform:** mature native builds exist for the desktop targets; actual per-format decode conformance must be tested on the exact packaged binaries.
- **Release condition:** build and hash one binary per target; store `ffmpeg -version` including configuration; do not silently fall back to a system binary. A canonical command must select one audio stream, fixed channel policy, fixed rate/sample format, no implicit trimming, and WAV output.

The earlier research observation about decoder-dependent MP3 offsets remains relevant: the All-In-One maintainer reports observed 20–40 ms differences and recommends conversion to WAV before timed analysis ([All-In-One README, MP3 section](https://github.com/mir-aidj/all-in-one#concerning-mp3-files)). That is a warning to test, not a universal bound.

### librosa: maintained, weight-free DSP substrate

librosa 0.11.0 is the current stable release line found in the official releases and its repository remains active ([releases](https://github.com/librosa/librosa/releases), [repository](https://github.com/librosa/librosa)). Current docs expose CPU beat tracking, chroma and general MIR primitives; Context7 also confirmed that the default loader may mix to mono/resample, which is why Open Chords must pass its already-decoded waveform and sample rate rather than let librosa establish a second timebase.

- **Code:** ISC.
- **Weights:** none for the proposed functions.
- **Training data:** none for the proposed functions; published key profiles or other constants need their own citation/provenance in code.
- **Evaluation data:** none bundled for the release benchmark.
- **CPU/platform:** NumPy/SciPy/Numba CPU stack; benchmark packaging and cold-start on macOS arm64/x64, Windows x64, and Linux x64.
- **Support:** credible for features and baselines, not an off-the-shelf downbeat/meter, semantic-section, key, or rich-chord product. Its historical chord module was removed; Open Chords owns template semantics, decoding, confidence, and tests.

### Essentia: useful AGPL reference backend

Essentia is a maintained cross-platform C++ MIR library and explicitly supports Linux, macOS, Windows, iOS, and Android. It is AGPL-3.0 and offers commercial licensing ([official README](https://github.com/MTG/essentia#readme)). That license is compatible with Open Chords' chosen AGPL-3.0 direction in principle, but binary distribution and notices still require a concrete packaging review.

- **Code:** AGPL-3.0 (or a separately purchased commercial license).
- **Weights:** none for `RhythmExtractor2013`, HPCP/chord-template, and profile-key algorithms proposed here.
- **Training data:** none for those classical algorithms; their method constants remain documented implementation choices.
- **Evaluation data:** none automatically granted by the code license.
- **CPU/platform:** native CPU; official docs describe it as computationally optimized and cross-platform. Measure the packaged build.
- **Support:** `RhythmExtractor2013` returns beat locations and BPM and requires 44.1 kHz input ([official source](https://github.com/MTG/essentia/blob/master/src/algorithms/rhythm/rhythmextractor2013.cpp)); `ChordsDetection`/`ChordsDetectionBeats` are major/minor references, not the required rich vocabulary. Essentia does not by itself close automatic downbeat/meter or semantic sections.

Recommendation: benchmark Essentia against the lighter librosa/Open Chords baseline. Pick by reproducible quality/runtime/packaging results, not by API breadth.

### Montreal Forced Aligner: EN/RU reference-text candidate

MFA defines forced alignment as taking an orthographic transcription and producing a time-aligned version via a pronunciation dictionary ([user guide](https://montreal-forced-aligner.readthedocs.io/en/latest/user_guide/)). Its current installation explicitly supports CPU Kaldi packages through conda-forge, and Docker is documented ([installation](https://montreal-forced-aligner.readthedocs.io/en/latest/installation.html)). Context7 confirmed the `mfa align CORPUS DICTIONARY ACOUSTIC_MODEL OUTPUT` workflow and separate model downloads.

- **Code:** MFA 3.4.1 is MIT on its official PyPI metadata ([PyPI](https://pypi.org/project/Montreal-Forced-Aligner/)); the runtime also contains separately licensed Kaldi/OpenFst/Pynini/Conda dependencies that must be inventoried in the sidecar image/package.
- **Weights/model archives:** English MFA v3.1.0 and Russian MFA v3.1.0 acoustic models are CC BY 4.0. Their official cards identify GMM-HMM/MFCC architecture, version compatibility, training corpora, dictionary pairing, and intended transcript-alignment use ([English acoustic-model card](https://mfa-models.readthedocs.io/en/latest/acoustic/English/English%20MFA%20acoustic%20model%20v3_1_0.html), [Russian acoustic-model card](https://mfa-models.readthedocs.io/en/latest/acoustic/Russian/Russian%20MFA%20acoustic%20model%20v3_1_0.html)). The paired English and Russian v3.1.0 dictionaries are also separately published under CC BY 4.0 ([English dictionary card](https://mfa-models.readthedocs.io/en/latest/dictionary/English/English%20MFA%20dictionary%20v3_1_0.html), [Russian dictionary card](https://mfa-models.readthedocs.io/en/latest/dictionary/Russian/Russian%20MFA%20dictionary%20v3_1_0.html)); pin, hash, attribute, and manifest them independently.
- **Training data:** model cards enumerate corpora (for example Common Voice, LibriSpeech, and language-specific corpora). Their licenses are provenance facts, not licenses transferred to downstream users. Preserve the full cards in the manifest and do not treat CC BY on the resulting archive as permission to redistribute source corpora.
- **Evaluation data:** no singing gold set is supplied by MFA. The cards state the models were trained on read speech in low-noise conditions and warn that divergent data may have alignment issues.
- **CPU/platform:** CPU Kaldi is an official installation path. Conda-heavy packaging and writable temp/database behavior make MFA better as an isolated sidecar tool than an in-process library. Test native installers; do not assume the official Docker workflow is suitable for Electron desktop distribution.
- **Product behavior:** validate transcript and OOVs before running; align bounded lines/chunks where anchors exist; retain failed/unmatched tokens; never alter reference words; fall back to line timing or manual anchors instead of invented word precision.

MFA is a credible benchmark candidate for both official languages, not a confirmed singing aligner. “Officially tested EN/RU” must mean Open Chords' own sung corpus passes its future measured gate.

## Benchmark-only candidates and exclusions

### BeatNet

BeatNet exposes joint beat/downbeat/tempo/meter modes and defaults to CPU. Its repository now includes a training pipeline and three pretrained model files, but also documents compatibility workarounds for its madmom dependency on modern Python/NumPy ([official repository](https://github.com/mjhydri/BeatNet)).

- The repository is marked CC BY 4.0, but it does not provide a sufficiently granular release manifest separating program code, each checkpoint, and the rights/provenance of GTZAN, Ballroom, and Rock training artifacts.
- Offline inference uses madmom code; madmom code is BSD while its included model/data files are CC BY-NC-SA 4.0 ([madmom license section](https://github.com/CPJKU/madmom#license)). A release must prove it does not transitively ship/use NC model assets.
- Therefore BeatNet is a measured candidate, not the default redistributable stack.

### All-In-One

All-In-One's MIT code predicts tempo, beats, downbeats, and functional sections and can select CPU. Its official pipeline embeds four source-separated stems and its install/runtime includes Demucs and madmom; models are trained on Harmonix Set ([official repository](https://github.com/mir-aidj/all-in-one)). The published speed example uses an RTX 4090 and a 14-core CPU, so it is not evidence of acceptable CPU-only desktop runtime.

It conflicts with the v1 “no source separation” boundary and carries unresolved model/training/dependency redistribution details. Use it only to establish an upper comparison for structure features; do not contort v1 around it.

### Chordino / NNLS Chroma

Chordino remains a valuable transparent chord baseline; the official Vamp catalog calls it a simple, non-state-of-the-art transcription using user-supplied chord profiles ([Vamp plugin catalog](https://vamp-plugins.org/download.html?platform=other)). The current Vamp Plugin Pack is redistributable under AGPL-3.0 as a whole ([pack page](https://vamp-plugins.org/pack.html)), while Sonic Annotator is GPL-2.0 ([official repository](https://github.com/sonic-visualiser/sonic-annotator)).

The exact standalone Chordino source/binary license and packaging path were not clearly established from the current primary pages reviewed here. Benchmark it in an isolated harness, but do not ship it until the precise source revision, license text, Vamp host, and notices are recorded. MIREX 2025 still reports Chordino as a baseline, which supports relevance but not product quality or licensing ([results](https://music-ir.org/mirex/wiki/2025%3AAudio_Chord_Estimation_Results)).

### BTC and other learned chord recognizers

Do not ship the BTC checkpoint described in the earlier research. MIT code is not a checkpoint license/model card, and its copyright-restricted training audio is not distributed. Any learned replacement must provide: immutable weights; an explicit redistribution license; architecture/config; complete training-data statement; preprocessing; label vocabulary; and runnable CPU export. Until then, the weight-free decoder plus Chordino/Essentia comparisons define the benchmark floor.

## License matrix for the release manifest

| Artifact | Code license | Weight/model license | Training provenance | Evaluation-data status | Release disposition |
|---|---|---|---|---|---|
| Pinned FFmpeg build | LGPL/GPL outcome depends on configuration | n/a | n/a | Open Chords corpus only | ship after build-level review |
| librosa 0.11.x baseline | ISC | n/a | n/a | Open Chords corpus only | ship |
| Open Chords DSP/decoders | AGPL-3.0 | n/a | cite algorithm/profile origins | Open Chords corpus only | ship |
| Essentia classical backend | AGPL-3.0 | n/a | n/a for selected algorithms | Open Chords corpus only | candidate to ship after packaging benchmark |
| MFA 3.4.x | MIT plus runtime dependency licenses | EN/RU models and dictionaries separately pinned; model cards currently CC BY 4.0 for acoustic models | preserve every model card/corpus list | no singing gold supplied | candidate to ship after desktop packaging and singing benchmark |
| BeatNet | repository CC BY 4.0; madmom code BSD | bundled checkpoint grant/provenance insufficiently granular | GTZAN/Ballroom/Rock named; rights audit needed | do not redistribute third-party corpora by default | benchmark only |
| All-In-One | MIT code plus dependencies | checkpoint licensing/provenance needs manifest | Harmonix Set; demixing dependencies | corpus rights separate | benchmark only; v1 architecture mismatch |
| Chordino + host | exact standalone revision/license must be pinned; common hosts/packs are GPL/AGPL | n/a | template/method, no learned checkpoint | MIREX/private results do not grant data | benchmark only until packaging review |
| BTC checkpoint | MIT code only | not established | copyrighted datasets named, audio absent | dataset licenses separate | exclude from release |

## Benchmark plan

Use the already-decided reproducible 30–50-track corpus of licensed/allowed audio. Do not redistribute audio or annotations unless their grants explicitly permit it. Store a rights ledger per track and publish aggregate plus per-track-derived metrics only where allowed.

### Required slices

- language: instrumental/no lyrics, English, Russian, mixed/code-switched;
- meter: 2/4, 3/4, 4/4, 6/8, meter changes, ambiguous/unknown;
- tempo: slow/fast, steady, expressive drift, abrupt changes;
- harmony: major/minor, sevenths, sus/add/9, diminished/augmented, slash/inversions, `N`, non-A440/ambiguous;
- texture: sparse/dense, vocal-forward, percussion-light, live, noisy/compressed;
- sections/alignment: repeated chorus, pickup, instrumental breaks, melisma, backing/overlapping vocals.

### Comparisons

1. **Decode:** packaged FFmpeg binaries on every target -> sample count/hash/offset fixtures; intentional format variants of the same authorized master.
2. **Rhythm:** librosa/Open Chords vs Essentia vs BeatNet; beat/downbeat F-measure with declared tolerance, tempo octave errors, meter accuracy/change-boundary error, abstention, runtime/RAM.
3. **Key:** fixed profile baseline vs Essentia; exact and relative/parallel error taxonomy, confidence calibration, runtime.
4. **Sections:** generic recurrence/novelty boundaries vs All-In-One comparison; boundary precision/recall/F at multiple tolerances and label metrics only when compatible gold labels exist.
5. **Chords:** Open Chords templates vs Chordino vs Essentia floor; MIREX-style WCSR at root, maj/min, sevenths, and inversion projections plus over/under-segmentation. MIREX defines WCSR as duration-weighted correct overlap and explicitly evaluates several vocabulary mappings ([2025 task](https://music-ir.org/mirex/wiki/2025%3AAudio_Chord_Estimation)). Report rich-class coverage and `unknown`, never only a simplified score.
6. **Lyrics:** MFA EN/RU model/dictionary variants on full mix; optionally compare a deterministic light harmonic filter that is not learned source separation. Measure word coverage, median/p90 absolute start/end error, line error, OOV/unmatched rate, catastrophic monotonicity failures, runtime/RAM. Never score by whether the aligner changed the reference text; it must not.

Pin OS/architecture, CPU model/thread count, tool/package/model hashes, seeds, decoder command, input hash, warm/cold state, and raw outputs. Thresholds remain deliberately unset until this baseline exists. A deterministic repeated result and visible low-confidence output are release requirements; no candidate is accepted merely for winning an average metric.

## Unsupported requirements to carry into the specification

- Automatic rich chord vocabulary and slash/inversion recognition are **product target + benchmark gate**, not a guaranteed v1 analyzer capability. Manual entry must support the full vocabulary regardless.
- Reliable automatic meter across 2/4, 3/4, 4/4, 6/8 and arbitrary meter changes is not established by the selected no-weight baseline. Manual meter is authoritative; auto output may abstain.
- Semantic section names are not established without a learned model. Generic boundaries are an acceptable baseline; labels can be user-edited.
- MFA EN/RU model availability does not establish sung-word accuracy. When word alignment is unreliable, preserve line anchors/unmatched words and require manual correction.
- Confidence values from different libraries are not comparable. Calibrate per task on held-out tracks, version the calibration, and expose `unknown` when no calibrated claim is possible.
- No reviewed component currently justifies bundling a learned rich-chord model. The extension seam and model manifest should permit adding one after a separate license and benchmark decision.

## Framework facts obtained through Context7

Context7 tools were available in this task. `resolve-library-id` followed by `query-docs` was used for FFmpeg (`/websites/ffmpeg_ffmpeg-all`), librosa (`/librosa/librosa`), and MFA (`/websites/montreal-forced-aligner_readthedocs_io_en_user_guide`). The returned official documentation confirmed PCM handling, current librosa beat/chroma APIs and loader behavior, and MFA's separate corpus/dictionary/acoustic-model alignment workflow. Primary project pages linked above are the durable citations.

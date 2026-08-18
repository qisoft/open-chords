# OpenChordify: algorithms and open-source stack

> Research input for a future `wayfinder:research` ticket. Sources were verified on 2026-08-12. This is technical research, not legal advice.

## Summary

A Chordify-like product is technically feasible as a pipeline of independent MIR (Music Information Retrieval) tasks, not as one LLM:

```text
licensed/local audio -> canonical WAV/timebase
  |-> optional source separation -> accompaniment -> beats/downbeats + chords/key/sections
  `-> vocals -> singing ASR -> reference-lyrics reconciliation -> forced word alignment
                                      |
                       chord intervals + word intervals
                                      |
                         deterministic placement -> ChordPro
```

STT can provide **draft text and time anchors**, but ordinary speech ASR must not be the sole source of precise singing timings. A more robust path separates vocals, obtains an ASR draft, deterministically reconciles it with user-provided reference lyrics, then force-aligns those words to the vocals. Forced alignment takes a known orthographic transcript and produces its time alignment ([MFA guide](https://montreal-forced-aligner.readthedocs.io/en/v3.4.1/user_guide/index.html#what-is-forced-alignment)).

For a first working release: optional Demucs/Spleeter preprocessing; `librosa` plus Chordino or a custom chroma/template baseline for beat-synchronous chords; Whisper/WhisperX or Qwen3-ASR for word candidates; dynamic programming for reference reconciliation; and ChordPro export. Benchmark BTC and All-In-One separately before inclusion.

## 1. Shared data model and timebase

Every analyzer should emit events on one timebase rather than rendered text:

```json
{
  "audio": {"sample_rate": 44100, "duration_s": 213.42, "time_origin_s": 0},
  "beats": [{"at_s": 0.431, "bar_beat": 1, "confidence": 0.91}],
  "chords": [{"start_s": 12.12, "end_s": 14.084, "symbol": "G:maj", "confidence": 0.78}],
  "words": [{"start_s": 12.305, "end_s": 12.721, "text": "hello", "source": "forced", "confidence": 0.84}],
  "sections": [{"start_s": 11.98, "end_s": 36.1, "label": "verse"}]
}
```

Decode the source to canonical PCM WAV, then keep decoder and time origin fixed. All-In-One's author observed roughly 20–40 ms offsets among MP3 decoders and recommends WAV for precision tasks, while common beat evaluation uses a 70 ms tolerance ([All-In-One README](https://github.com/mir-aidj/all-in-one#concerning-mp3-files)). Preserve a sample-accurate origin and derive seconds as `sample_index / sample_rate`.

Store internal chord symbols in a formal Harte/mir_eval representation separately from user-facing rendering (`G:maj(6)/5`, root, quality, extensions, bass). `mir_eval` documents parsing and several comparison vocabularies rather than one universally correct comparison ([mir_eval chord API](https://mir-eval.readthedocs.io/latest/api/chord.html)).

## 2. Chords and timing

### 2.1. Classical DSP baseline

Testable pipeline:

1. harmonic/percussive separation or accompaniment stem;
2. STFT/CQT -> chroma/HPCP across 12 octave-independent pitch classes;
3. chroma smoothing;
4. segmentation into beat intervals;
5. matching aggregated chroma against chord templates;
6. temporal decoding with transition penalties, HMM/Viterbi, or median filtering;
7. merging identical adjacent intervals and emitting confidence/abstention.

Essentia's `ChordsDetection` and `ChordsDetectionBeats` are useful algorithmic references ([Essentia.js API](https://mtg.github.io/essentia.js/docs/api/Essentia.html#ChordsDetection), [beat-synchronous variant](https://mtg.github.io/essentia.js/docs/api/Essentia.html#ChordsDetectionBeats)), but Essentia is AGPL-3.0/commercially licensed ([license](https://github.com/MTG/essentia#license)). A permissive product should implement a small NumPy/librosa baseline or isolate Essentia only after a legal decision.

Chordino/NNLS Chroma is a mature Vamp chord-extraction plugin ([official page](https://www.vamp-plugins.org/nnls-chroma/)). Verify the exact source/binary and dependency licenses before distribution; “open source” does not imply a permissive license.

The DSP baseline is CPU-friendly, explainable, and weight-free, but has limited vocabulary and sensitivity to tuning, bass, melody, and false changes. A sensible MVP vocabulary is `N + 12 major + 12 minor`; add suspended, seventh, and inversion forms only after measurement. MIREX evaluates multiple vocabulary projections and WCSR measures correctly overlapping duration ([MIREX](https://music-ir.org/mirex/wiki/2025%3AAudio_Chord_Estimation#Evaluation)).

### 2.2. Neural recognizer

BTC consumes CQT, uses bidirectional self-attention, and emits chord `.lab` intervals. Its MIT code supports major/minor and large-vocabulary modes ([README](https://github.com/jayg996/BTC-ISMIR19#using-btc--recognizing-chords-from-files-in-an-audio-directory), [paper](https://archives.ismir.net/ismir2019/paper/000075.pdf)). The old repository does not distribute copyrighted training audio or separately license ready checkpoints, so reproducible weights and training-data provenance are release blockers ([Data section](https://github.com/jayg996/BTC-ISMIR19#data)).

Relate neural output to the beat grid through beat-aware transition penalties or thresholded snapping. Never snap every boundary: anticipations and mid-beat changes are musically valid.

### 2.3. Source separation

Demucs v4 separates drums, bass, vocals, and other. HT Demucs combines waveform and spectrogram domains and reports 9.0 dB SDR on MUSDB HQ, but Meta's repository is unmaintained ([README](https://github.com/facebookresearch/demucs#demucs-music-source-separation)). Code is MIT; weight/training provenance remains separate.

Spleeter provides 2-, 4-, and 5-stem models and MIT code, but its latest official release dates to 2021 and its authors explicitly require users to obtain rights-holder permission for copyrighted material ([README](https://github.com/deezer/spleeter#license), [disclaimer](https://github.com/deezer/spleeter#disclaimer)).

Separation may remove chord tones through artifacts. Benchmark `mix` versus `no-vocals`, and possibly an ensemble. `other + bass` may suit chords, drums/full mix beats, and vocals lyrics. Do not pay the compute cost until WCSR or word-boundary gains are measured.

## 3. Beat, downbeat, tempo, key, and structure

| Task | Lightweight baseline | Candidate | License/risk |
|---|---|---|---|
| beat/tempo | `librosa.beat.beat_track` | All-In-One or BeatNet | librosa ISC; verify BeatNet weights |
| downbeat/meter | accent/bass heuristics | All-In-One joint beats/downbeats | MIT code, Demucs and pretrained weights |
| key | HPCP/chroma profile correlations | Essentia `KeyExtractor` | AGPL/commercial versus easier-to-license custom implementation |
| sections | self-similarity/recurrence and novelty clustering | All-In-One labels | verify MSAF/library/data licenses; labels are style-dependent |

All-In-One emits BPM, beats, downbeats, boundaries, and functional labels with 100 fps activations ([README](https://github.com/mir-aidj/all-in-one#all-in-one-music-structure-analyzer)). It is a cohesive post-MVP candidate, but its ten classes are not universal truth and inference uses demixed stems. Compare it against a simple baseline on a license-clean corpus.

Madmom offers strong reference implementations, but bundled models/data use CC BY-NC-SA 4.0 despite BSD code, so ready models cannot silently enter a commercially usable product ([license](https://github.com/CPJKU/madmom#license)).

## 4. Lyrics, STT, and forced alignment

Whisper is multilingual general-purpose **speech** ASR with MIT code/weights ([README](https://github.com/openai/whisper#python-usage)). It can provide language, draft tokens, and coarse anchors, but its speech documentation does not establish singing quality.

WhisperX adds VAD, batching, and language-specific phoneme alignment for word timestamps under BSD-2-Clause ([README](https://github.com/m-bain/whisperX)). Out-of-vocabulary characters may lack timing, every language needs an alignment model, and overlap is handled poorly. Record each downloaded model's license separately.

Qwen3-ASR is a newer Apache-2.0 singing-aware candidate. `Qwen3-ForcedAligner-0.6B` returns word/character boundaries for 11 languages but limits one input to five minutes ([repository](https://github.com/QwenLM/Qwen3-ASR), [report](https://arxiv.org/abs/2601.21337)). Claimed song support does not prove melisma accuracy; compare it against WhisperX on sung-word annotations. NVIDIA NeMo Forced Aligner is another Apache-2.0 backend, officially tested only on English ([NFA](https://docs.nvidia.com/nemo/speech/nightly/tools/nemo_forced_aligner.html)). Do not base new work on deprecated `torchaudio.functional.forced_align` ([TorchAudio](https://pytorch.org/audio/stable/generated/torchaudio.functional.forced_align.html)).

Recommended reference-lyrics pipeline:

1. Create `vocals.wav`, retaining full mix as fallback.
2. Produce ASR tokens with coarse timestamps and confidence.
3. Normalize ASR and reference strings without losing originals.
4. Compute monotonic weighted Levenshtein/Needleman–Wunsch alignment with no temporal reordering.
5. Transfer anchors for matched islands and bound unknown regions by neighbors.
6. Force-align reference lyrics within sections/lines.
7. Validate monotonicity, bounds, coverage, and duration; expose low-confidence words/lines for manual correction.

Speech acoustic models still need benchmarks for melisma, backing vocals, and sustained vowels. Preserve line timing when word timing is unreliable rather than inventing precision.

### 4.1. Restricted LLM role

An LLM must not generate “correct lyrics,” assign timestamps, or reorder words. It may only propose matching indices between two existing token arrays, normalization alternatives, and reason codes:

```json
{
  "links": [{"reference_ids": [41, 42], "asr_ids": [39], "kind": "normalized_match"}],
  "unmatched_reference_ids": [43],
  "unmatched_asr_ids": [],
  "notes": [{"reference_id": 43, "reason": "no_audio_evidence"}]
}
```

Ordinary code validates IDs, one-time use, monotonicity, enums, and the prohibition on new text/time. JSON Schema validates structure, not semantic correctness ([JSON Schema](https://json-schema.org/draft/2020-12/json-schema-core)). Dynamic-programming alignment remains authoritative; accept an LLM suggestion only if it improves a predefined cost without breaking anchors. MVP needs no LLM.

## 5. Placing chords over words

For a chord start `t_c` and word intervals `[s_i, e_i)`:

1. If `t_c` lies within a word, anchor before that word without splitting spelling.
2. Otherwise use the first word with `s_i >= t_c` within `max_lead_s`.
3. If a change occurs in a pause without a nearby word, create a beat/chord-only slot.
4. Preserve multiple changes before one word in a separate chord line/grid.
5. Tie-break by the chord containing word start, then nearest preceding change; never sort by text.

ChordPro is the recommended public semantic export: chord tokens appear directly in lyric lines ([site](https://chordpro.org/), [cheat sheet](https://www.chordpro.org/chordpro/chordpro_cheat_sheet/)). Whitespace-based visual columns must not become source of truth because proportional fonts, transposition, and localization break them. Timed JSON remains richer; WebVTT may be an additional timed-text adapter ([WebVTT](https://www.w3.org/TR/webvtt1/)).

## 6. Recommended stack

| Component | MVP | Later alternative | Reason |
|---|---|---|---|
| decode/timebase | FFmpeg -> fixed WAV | native decoders with parity tests | remove decoder offsets before fusion |
| separation | off by default; A/B Spleeter | Demucs | measure benefit before heavier unmaintained upstream |
| beats | librosa DP | All-In-One | permissive explainable baseline first |
| chords | chroma + beat aggregation + templates + Viterbi | BTC ensemble | explainability and licensing first |
| key | chroma profile | learned classifier | key is a prior, not a forced root rewrite |
| sections | repetition/novelty or omit | All-In-One | nonblocking for core value |
| ASR | Qwen3 versus WhisperX on vocals | singing-specific fine-tune | measure weights and boundary quality |
| reference alignment | DP + forced alignment | constrained LLM assist | deterministic and no new copyrighted text |
| representation | timed JSON + ChordPro | WebVTT/JAMS/MusicXML adapters | timing fidelity plus musician interoperability |

## 7. Benchmarks and readiness

Use a versioned, rights-clean evaluation set with expert chord intervals and word timings. Report:

- chord root/majmin/triads/sevenths WCSR, segmentation, and change-boundary median/p90;
- beat/downbeat precision, recall, and F-measure under declared tolerance;
- ASR WER/CER, word-boundary mean/median/p90, reference-word timing coverage, and line-start error;
- chord-to-word/space assignment, preserved chord-only slots, and deterministic golden ChordPro;
- slices for language, vocal type, rap, melisma, choir/overlap, instrumental intros, rubato/live, tuning, key changes, and dense harmony;
- CPU/GPU real-time factor, peak memory, cold download, energy, and cost.

Include p90 boundary error, abstention rate, and failure taxonomy, not only averages. Every stage must return `unknown/low_confidence` rather than false precision.

JamendoLyrics MultiLang provides 79 Creative Commons songs in four languages with word boundaries ([dataset card](https://huggingface.co/datasets/jamendolyrics/jamendolyrics/blob/main/README.md)). DALI has line/word/note annotations but is CC BY-NC-SA 4.0, suitable for noncommercial research comparison rather than unrestricted product assets ([repository](https://github.com/gabolsgabs/DALI), [record](https://zenodo.org/records/3576083)).

## 8. Licensing and operational risks

1. Track application code, dependency code, model weights, and training/evaluation data licenses separately.
2. Essentia is AGPL-3.0 or commercial; decide before linking/deployment.
3. Madmom code is BSD but bundled models/data are noncommercial.
4. BTC code is MIT while training audio is not distributed; checkpoints need provenance.
5. User access to audio or a lyric page does not grant download, storage, training, or republication rights. MVP accepts local/user-authorized audio and user-supplied/licensed lyrics; no scraper bypasses.
6. YouTube policies prohibit API clients from downloading/caching audiovisual content and separating audio/video components ([policies](https://developers.google.com/youtube/terms/developer-policies)). Do not model YouTube as `URL -> download -> stems` without separate authorization/legal review.
7. Composition/lyrics and sound recording are separate rights layers ([Copyright Office](https://www.copyright.gov/register/pa-sr.html)).
8. Timestamps/chords and full lyric text carry different risks. Default to deleting source/stems after processing and keep sharing/export policy separate.
9. Each model manifest records name, revision, SHA-256, source, code/weight licenses, training-data statement, accepted-use terms, and review date.

## 9. Implementation stages

### Stage 0 — measurable research spike

- canonical WAV/timebase and typed timed JSON;
- 20–50 authorized tracks with manual annotations;
- baseline beats and chroma chord intervals;
- Qwen3/WhisperX on mix versus vocals, plus deterministic reconciliation;
- WCSR, boundary, runtime, and failure-slice report.

### Stage 1 — useful open-source MVP

- local file playback, waveform, tempo/key, beat-synchronous `maj/min/N` chords;
- user-supplied lyrics, forced line/word alignment, manual anchor editor;
- deterministic chord-to-word fusion;
- timed JSON and ChordPro, with transpose/capo as presentation transforms;
- confidence/unknown states and reproducible CLI.

### Stage 2 and beyond

- measured separation ensembles, richer vocabulary/inversions, sections/downbeats;
- language pronunciation adapters and repeated-chorus handling;
- corrections only as explicitly consented data, never an automatic training corpus;
- benchmark newer chord models, add batch/cache/model registry and CPU/GPU profiles;
- extension APIs, alternative renderers, and explicit share/privacy policy.

## 10. Decisions still required

- exact parity scope versus core synchronized chords plus user lyrics;
- local/user-authorized inputs versus separately reviewed external integrations;
- user-supplied or licensed lyric provider policy;
- permissive versus AGPL product license;
- local CPU, self-hosted GPU, or hosted SaaS deployment;
- WCSR, p90 boundary, languages/genres, and abstention targets;
- timed JSON plus ChordPro public notation policy;
- LLM disabled in MVP and limited later to schema-constrained mapping suggestions.

## 11. Proposed research acceptance criteria

- a license-compatible, version-pinned MVP stack with model manifests;
- reproducible rights-clean comparisons of mix/no-vocals, DSP/BTC, and forced-aligner alternatives;
- WCSR, boundary, coverage, runtime, and raw per-track results;
- proof that reconciliation never adds/removes reference words without explicit edit;
- deterministic ChordPro from identical analysis JSON;
- visible low-confidence/unmatched regions;
- legal review of ingestion, lyric storage/export, weights, and datasets before hosting.

## 12. Full and synchronized lyric providers

> Verified against official API documentation, product pages, and terms on 2026-08-12. An open-source code license does not grant rights to provider content; code and content contracts remain separate.

| Provider | Capability | Timing | Contract implications | Recommendation |
|---|---|---|---|---|
| **LRCLIB** | Free API without registration/key; `plainLyrics` and `syncedLyrics`; MIT server can be self-hosted ([docs](https://lrclib.net/docs), [repo](https://github.com/tranxuanthang/lrclib)) | Line-start LRC, no documented word sync | Requires identifying `User-Agent`, sequential requests, batch delay, and `429` handling. No catalog-wide lyric license was found. | Best free best-effort v1 lookup with provenance and project-local storage; realign to the analyzed recording. Do not treat it as licensed catalog redistribution. |
| **Genius public API** | Song/search metadata and Genius URL, not full lyric text ([Songs](https://docs.genius.com/#songs-h2), [Search](https://docs.genius.com/#search-h2)) | None | HTML extraction is scraping; public terms do not establish full-text/cache/export rights. | Metadata/link resolver only without a written partner agreement. |
| **Musixmatch Pro** | Lyrics body, line-synced subtitle, and Scale-plan rich sync ([lyrics](https://docs.musixmatch.com/api-reference/lyrics-catalog/track-lyrics-get), [subtitle](https://docs.musixmatch.com/api-reference/lyrics-catalog/track-subtitle-get), [rich sync](https://docs.musixmatch.com/api-reference/lyrics-catalog/track-richsync-get)) | Line and rich character/voice offsets | Territorial restrictions, attribution/tracking, and restrictive default terms. Storage, offline/export, algorithm use, and self-hosted clients require explicit contract coverage ([terms](https://about.musixmatch.com/apiterms)). | Strongest technical candidate only after a written agreement covers every Open Chords use case. |
| **LyricFind** | Licensed Lyric Display product ([products](https://www.lyricfind.com/products)) | Static, line, and word-by-word | No public self-serve API/cache/export/pricing terms; partner sales required. | Commercial comparison candidate after written proposal and legal review. |

Do not make one external catalog mandatory. The autonomous path remains `user-supplied lyrics or STT draft -> forced alignment`; provider text, keys, and caches never enter Git, release artifacts, or a shared public database. Design a `LyricsProvider` adapter with LRCLIB as best-effort lookup, Genius as metadata/link only, and commercial providers enabled only after written contractual approval. Territory or rights failures must fall back to user-supplied text, never scraping.

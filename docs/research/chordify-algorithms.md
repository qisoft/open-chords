# OpenChordify: алгоритмы и open-source стек

> Исследовательский вход для будущего `wayfinder:research` ticket. Состояние источников проверено 2026-08-12. Это техническое исследование, не юридическое заключение.

## Краткий вывод

Аналог Chordify технически реализуем как конвейер из независимых задач MIR (Music Information Retrieval), а не как одна LLM:

```text
licensed/local audio -> canonical WAV/timebase
  |-> optional source separation -> accompaniment -> beats/downbeats + chords/key/sections
  `-> vocals -> singing ASR -> reference-lyrics reconciliation -> forced word alignment
                                      |
                       chord intervals + word intervals
                                      |
                         deterministic placement -> ChordPro
```

STT можно использовать для получения **чернового текста и временных якорей**, но обычная речевая ASR не должна быть единственным источником точных таймингов пения. Практически более устойчивый путь: отделить вокал, получить черновик ASR, детерминированно сопоставить его с предоставленным пользователем эталонным текстом, затем выполнить forced alignment эталонных слов к вокалу. Forced alignment по определению принимает уже известную орфографическую транскрипцию и генерирует её временное выравнивание ([MFA user guide](https://montreal-forced-aligner.readthedocs.io/en/v3.4.1/user_guide/index.html#what-is-forced-alignment)).

Для первого работающего релиза рекомендуется: Demucs/Spleeter как опциональный preprocessing; `librosa` + Chordino либо собственный chroma/template baseline для beat-synchronous аккордов; Whisper/WhisperX для кандидатов слов; динамическое программирование для сопоставления с эталоном; ChordPro как экспорт. Нейросетевой chord recognizer BTC и All-In-One structure analyzer следует проверять отдельным benchmark до включения.

## 1. Общая модель данных и единая шкала времени

Все анализаторы должны писать не отрисованный текст, а события в одной временной шкале:

```json
{
  "audio": {"sample_rate": 44100, "duration_s": 213.42, "time_origin_s": 0},
  "beats": [{"at_s": 0.431, "bar_beat": 1, "confidence": 0.91}],
  "chords": [{"start_s": 12.120, "end_s": 14.084, "symbol": "G:maj", "confidence": 0.78}],
  "words": [{"start_s": 12.305, "end_s": 12.721, "text": "hello", "source": "forced", "confidence": 0.84}],
  "sections": [{"start_s": 11.98, "end_s": 36.10, "label": "verse"}]
}
```

Сначала следует декодировать источник в канонический PCM WAV и дальше не менять decoder/time origin: автор All-In-One наблюдал между MP3-декодерами смещение около 20–40 мс и рекомендует WAV для точных задач, тогда как обычное окно допуска beat evaluation составляет 70 мс ([официальный README All-In-One](https://github.com/mir-aidj/all-in-one#concerning-mp3-files)). Необходимо сохранять sample-accurate origin, а секунды вычислять как `sample_index / sample_rate`.

Внутренний chord symbol лучше хранить в формализованном виде Harte/mir_eval, отдельно от пользовательского отображения (`G:maj(6)/5`, root, quality, extensions, bass): `mir_eval` документирует парсинг и несколько словарей сравнения вместо объявления одного «правильного» сравнения ([mir_eval chord API](https://mir-eval.readthedocs.io/latest/api/chord.html)).

## 2. Аккорды и их тайминги

### 2.1. Классический DSP baseline

Проверяемая цепочка:

1. harmonic/percussive separation или accompaniment stem;
2. STFT/CQT -> chroma/HPCP (энергия 12 pitch classes независимо от октавы);
3. сглаживание chroma;
4. разбиение по beat-интервалам;
5. сопоставление агрегированного chroma с шаблонами аккордов;
6. temporal decoding (штраф частых переключений, HMM/Viterbi или медианный фильтр);
7. merge одинаковых соседних интервалов и confidence/abstention.

Essentia подтверждает обе основные операции: `ChordsDetection` выбирает наиболее подходящую major/minor triad из HPCP, а `ChordsDetectionBeats` оценивает аккорд между соседними beats по медиане chroma либо первому кадру ([Essentia.js API](https://mtg.github.io/essentia.js/docs/api/Essentia.html#ChordsDetection), [beat-synchronous variant](https://mtg.github.io/essentia.js/docs/api/Essentia.html#ChordsDetectionBeats)). Это хороший алгоритмический reference, но сама Essentia распространяется под AGPL-3.0; её README прямо указывает AGPL и наличие коммерческой лицензии ([официальный репозиторий](https://github.com/MTG/essentia#license)). Для permissive open-source продукта безопаснее реализовать небольшой baseline на NumPy/librosa либо изолировать Essentia как отдельный AGPL-compatible deployment после юридического решения.

Chordino/NNLS Chroma — зрелый Vamp-плагин для chord extraction; проект описывает NNLS chroma и Chordino как open-source harmony/chord extraction ([официальная страница Vamp](https://www.vamp-plugins.org/nnls-chroma/)). Перед поставкой нужно проверить лицензию конкретного source tarball/бинарника и его зависимостей: наличие open source само по себе не означает permissive-лицензию.

Плюсы DSP baseline: CPU, объяснимость, отсутствие весов и простой confidence. Минусы: ограниченный словарь, sensitivity к настройке/басу/мелодии, частые ложные смены. MVP разумно ограничить `N + 12 major + 12 minor`, а sus/7/inversions добавить лишь после измерения; MIREX именно поэтому оценивает несколько проекций словаря, а WCSR считает долю длительности правильного перекрытия ([MIREX Audio Chord Estimation](https://music-ir.org/mirex/wiki/2025%3AAudio_Chord_Estimation#Evaluation)).

### 2.2. Нейросетевой recognizer

BTC (Bi-directional Transformer for Chord Recognition) принимает CQT, использует двунаправленный self-attention для long-range context и выдаёт chord `.lab` intervals; официальный код содержит major/minor и large-vocabulary режимы ([официальный README](https://github.com/jayg996/BTC-ISMIR19#using-btc--recognizing-chords-from-files-in-audio-directory)), а статья сообщает, что attention формирует адаптивное receptive field и long-term зависимости ([ISMIR paper](https://archives.ismir.net/ismir2019/paper/000075.pdf)). Код MIT ([LICENSE](https://github.com/jayg996/BTC-ISMIR19/blob/master/LICENSE)), но репозиторий старый (PyTorch >=1.0), не включает copyrighted audio datasets и не документирует отдельную лицензию готовых checkpoints; README подтверждает, что аудио Isophonics/Robbie Williams/UsPop2002 не распространяется из-за copyright ([Data section](https://github.com/jayg996/BTC-ISMIR19#data)). Следовательно, код допустим как исследовательский кандидат, но воспроизводимость весов и training-data provenance — release blocker.

Нейросетевой output всё равно следует привязать к beat grid: либо декодировать frame probabilities с beat-aware transition penalty, либо snap change point к ближайшему beat только если расстояние меньше порога. Нельзя безусловно snap-ить все границы: anticipations и mid-beat changes музыкально допустимы.

### 2.3. Source separation перед chord recognition

Demucs v4 разделяет drums, bass, vocals и other; HT Demucs сочетает waveform/spectrogram domains и Transformer, заявляя 9.0 dB SDR на MUSDB HQ, но официальный Meta-репозиторий больше не поддерживается ([официальный README](https://github.com/facebookresearch/demucs#demucs-music-source-separation)). Код MIT ([LICENSE](https://github.com/facebookresearch/demucs/blob/main/LICENSE)); README также говорит о тренировке на MUSDB HQ плюс дополнительном наборе 800 песен, поэтому provenance/model-weight redistribution надо зафиксировать отдельно от лицензии кода.

Spleeter предлагает готовые 2-, 4- и 5-stem модели и MIT-код, но последний release в официальном репозитории датирован 2021 годом; авторы отдельно предупреждают получать разрешение правообладателей для copyrighted material ([официальный README](https://github.com/deezer/spleeter#license), [disclaimer](https://github.com/deezer/spleeter#disclaimer)).

Разделение полезно, но не гарантирует улучшение: artifacts могут удалить chord tones. Нужен A/B benchmark `mix` против `no-vocals` и, возможно, ensemble. Для chord features полезны `other + bass`, для beats — drums/full mix, для lyrics — vocals. Не нужно запускать тяжёлое separation до измерения выигранного WCSR/word-boundary error.

## 3. Beat, downbeat, tempo, key и структура

### Варианты

| Задача | Лёгкий baseline | Модель-кандидат | Лицензия/риск |
|---|---|---|---|
| beat/tempo | `librosa.beat.beat_track`: dynamic-programming beat tracker ([API](https://librosa.org/doc/0.11.0/generated/librosa.beat.beat_track.html)) | All-In-One либо BeatNet | librosa ISC ([LICENSE](https://github.com/librosa/librosa/blob/main/LICENSE.md)); BeatNet repo заявляет CC-BY-4.0 ([repo](https://github.com/mjhydri/BeatNet)); отдельно проверить веса |
| downbeat/meter | эвристика accent/bass по beats, только как baseline | All-In-One: joint beats/downbeats | All-In-One MIT ([LICENSE](https://github.com/mir-aidj/all-in-one/blob/main/LICENSE)), но используются Demucs и pretrained weights |
| key | агрегированный HPCP/chroma + 24 major/minor profile correlations | Essentia `KeyExtractor` вычисляет HPCP и применяет `Key` ([docs](https://essentia.upf.edu/reference/std_KeyExtractor.html)) | Essentia AGPL/commercial; собственная profile implementation проще лицензировать |
| sections | self-similarity/recurrence + novelty/spectral clustering; MSAF собирает такие алгоритмы ([docs](https://msaf.readthedocs.io/en/latest/)) | All-In-One functional labels | MSAF/library and dataset licenses проверить отдельно; labels style-dependent |

All-In-One одним MIT-пакетом выдаёт BPM, beats, downbeats, boundaries и labels `intro/outro/break/bridge/inst/solo/verse/chorus`; frame activations имеют 100 fps ([официальный README](https://github.com/mir-aidj/all-in-one#all-in-one-music-structure-analyzer), [advanced output](https://github.com/mir-aidj/all-in-one#advanced-usage-for-research)). Это наиболее цельный кандидат для post-MVP structure track, но 10 functional classes не универсальная истина, а inference включает demixed stems. Его следует сравнить с простым baseline на лицензионно чистом evaluation corpus.

Madmom имеет сильные beat/downbeat reference implementations, но source code BSD, а включённые модели/данные CC BY-NC-SA 4.0 ([официальный License section](https://github.com/CPJKU/madmom#license)); поэтому готовые модели нельзя молча включать в продукт, допускающий commercial use.

## 4. Текст песни: STT, эталон и forced alignment

### 4.1. Что даёт STT

OpenAI Whisper — multilingual general-purpose **speech** recognition model; whole-file transcription обрабатывается скользящими 30-секундными окнами, а код и веса MIT ([официальный README](https://github.com/openai/whisper#python-usage), [license](https://github.com/openai/whisper#license)). Он полезен для определения языка, черновой последовательности токенов и грубых сегментных якорей, но его speech-domain documentation не подтверждает качество на singing vocals.

WhisperX добавляет VAD, batch inference и phoneme forced alignment через language-specific wav2vec2 для word timestamps; проект BSD-2-Clause ([официальный README](https://github.com/m-bain/whisperX), [LICENSE](https://github.com/m-bain/whisperX/blob/main/LICENSE)). Его собственные ограничения: символы вне словаря могут остаться без timing, нужен alignment model для языка, overlapping speech обрабатывается плохо ([limitations](https://github.com/m-bain/whisperX#limitations)). Лицензия каждого скачиваемого wav2vec2/Hugging Face alignment model должна храниться в model manifest отдельно от BSD-лицензии orchestration-кода.

Более новый singing-aware кандидат — Qwen3-ASR: официальный Apache-2.0 репозиторий заявляет распознавание speech, music и songs, а `Qwen3-ForcedAligner-0.6B` возвращает начала/концы слов или символов для 11 языков, но ограничивает один alignment input пятью минутами ([официальный репозиторий Qwen3-ASR](https://github.com/QwenLM/Qwen3-ASR), [technical report](https://arxiv.org/abs/2601.21337)). Это перспективный вариант для MVP spike, но заявленная поддержка песен не доказывает точность границ на melisma: forced-aligner нужно отдельно сравнить с WhisperX на sung-word annotations. NVIDIA NeMo Forced Aligner — ещё один Apache-2.0 backend, принимающий reference text и выдающий token/word/segment CTM; официальная документация указывает, что он протестирован только на английском ([NFA docs](https://docs.nvidia.com/nemo/speech/nightly/tools/nemo_forced_aligner.html)). `torchaudio.functional.forced_align` не следует брать как основу нового продукта: API официально deprecated и запланирован к удалению ([TorchAudio docs](https://docs.pytorch.org/audio/stable/generated/torchaudio.functional.forced_align.html)).

Вывод: STT-only режим возможен, когда reference lyrics отсутствует, но UI должен маркировать текст как распознанный и позволять правку. Когда пользователь предоставляет корректный текст, ASR нельзя позволять переписывать его; она становится evidence для alignment.

### 4.2. Рекомендуемый reference-lyrics pipeline

1. Demucs/Spleeter создаёт `vocals.wav`; сохранить также full mix как fallback.
2. Whisper/WhisperX выдаёт ASR tokens с coarse timestamps и confidence.
3. Нормализовать обе строки **без потери исходника**: Unicode normalization, casefold, punctuation-free comparison, language-specific number/abbreviation alternatives.
4. Найти монотонное sequence alignment ASR-токенов и reference-токенов динамическим программированием (weighted Levenshtein/Needleman–Wunsch): match/substitution/insertion/deletion; запрет перестановки времени.
5. Для совпавших островов перенести ASR anchors; каждую неизвестную область ограничить соседними anchors.
6. Запустить forced aligner на reference lyrics внутри секций/строк; MFA описывает alignment как `audio + orthographic transcript + pronunciation dictionary -> word/phone timings` ([MFA guide](https://montreal-forced-aligner.readthedocs.io/en/v3.4.1/user_guide/index.html#what-is-forced-alignment)).
7. Проверить монотонность, `start <= end`, попадание в bounds, coverage и длительность; низкоуверенные слова/строки отдать на ручную правку.

MFA особенно полезен при собственном pronunciation dictionary, но acoustic model обучен на речи, а не на распевах; melisma (несколько нот на слог), backing vocals и протяжные гласные требуют benchmark. Хорошая fallback-политика: сохранить line timing при ненадёжном word timing, а не выдумывать точные границы.

### 4.3. Роль LLM без галлюцинаций

LLM не должна генерировать «правильный текст песни», ставить timestamps или менять порядок слов. Допустимая ограниченная роль — предложить **индексы соответствий** между двумя уже данными token arrays, варианты нормализации и reason codes.

Контракт результата:

```json
{
  "links": [{"reference_ids": [41, 42], "asr_ids": [39], "kind": "normalized_match"}],
  "unmatched_reference_ids": [43],
  "unmatched_asr_ids": [],
  "notes": [{"reference_id": 43, "reason": "no_audio_evidence"}]
}
```

Ограничения должны проверяться обычным кодом: все IDs существуют; каждый ID используется не более одного раза; links монотонны; строковые значения берутся только из enum; модель не возвращает новый lyric text или time. JSON Schema задаёт vocabulary для structural validation ([JSON Schema 2020-12 specification](https://json-schema.org/draft/2020-12/json-schema-core)), но schema-valid output всё ещё может быть семантически неверным, поэтому DP alignment остаётся source of truth, а LLM suggestion принимается только если улучшает заранее заданную cost function и не нарушает anchors.

Для MVP LLM вообще не нужна: weighted edit-distance с language adapters воспроизводим, дешёв и audit-friendly. LLM стоит включать позже только на сложных `many-to-one` случаях (`gonna` ↔ `going to`), сохраняя input hashes, mapping и validator result.

## 5. Размещение аккордов над словами

Пусть chord event начинается в `t_c`, а word intervals имеют `[s_i, e_i)`. Детерминированная политика:

1. если `t_c` попадает внутрь слова, вставить аккорд перед этим словом (опционально хранить `intra_word_offset_s`, но не разрывать написание);
2. иначе привязать к первому слову с `s_i >= t_c`, если расстояние меньше настраиваемого `max_lead_s`;
3. если смена происходит в паузе и следующего слова близко нет, создать отдельный beat/chord-only slot;
4. несколько смен до одного слова сохранить в отдельной chord line/grid, а не потерять;
5. tie-break: сначала chord containing word start, затем ближайший предыдущий change; никогда не сортировать по тексту.

Рекомендуемый канонический экспорт — ChordPro: официальный проект определяет текстовый формат lead sheets с lyrics/chords и reference implementation ([официальный сайт](https://chordpro.org/)); его формат ставит chord token в квадратных скобках непосредственно в lyric line ([cheat sheet](https://www.chordpro.org/chordpro/chordpro_cheat_sheet/)). Например:

```chordpro
{title: Example}
{start_of_verse}
[G]Hello [D/F#]world, this is [Em7]aligned
{end_of_verse}
```

ChordPro хранит семантический anchor, а renderer строит привычную строку аккордов над текстом; нельзя хранить пробелы от визуальной раскладки как source of truth, потому что proportional fonts, transposition и локализация ломают колонки. Внутренний timed JSON должен оставаться богаче ChordPro: стандартный inline token не кодирует секунды. Для timed export можно дополнительно выдавать WebVTT: W3C определяет timed text cues, payload и timestamps ([WebVTT Recommendation](https://www.w3.org/TR/webvtt1/)), но chord/word association остаётся доменной схемой OpenChordify.

## 6. Сравнение и рекомендуемый стек

| Компонент | MVP | Альтернатива/этап 2 | Почему |
|---|---|---|---|
| decode/timebase | FFmpeg -> fixed WAV | native decoders с parity tests | исключить decoder offsets до fusion |
| separation | выключено по умолчанию; A/B Spleeter 2-stem | Demucs 4-stem | Spleeter проще/быстрее; Demucs обычно богаче по stems, но тяжелее и unmaintained upstream |
| beats | librosa DP tracker | All-In-One | permissive и простой baseline; joint model после benchmark |
| chords | chroma + beat aggregation + templates + Viterbi | BTC ensemble | объяснимый baseline, permissive собственная реализация; BTC требует provenance и modernization |
| key | chroma profile correlation | learned classifier | key — вспомогательная prior, не должен насильно менять chord roots |
| sections | repetition/novelty baseline или пропустить | All-In-One labels | не блокирует главную value proposition |
| ASR | Qwen3-ASR/ForcedAligner против WhisperX baseline на vocals | singing-specific fine-tune | Apache-2.0 против MIT/BSD code; веса и singing boundary accuracy измерить отдельно |
| reference alignment | DP + WhisperX/MFA forced alignment | constrained LLM mapping assist | детерминизм и отсутствие нового copyrighted text |
| representation | timed JSON + ChordPro | WebVTT/JAMS/MusicXML adapters | JSON сохраняет timings; ChordPro интероперабелен для музыкантов |

## 7. Benchmark и критерии готовности

Нельзя выбирать модели по demo. Нужен versioned evaluation set из аудио, которое проект вправе хранить и обрабатывать, с экспертными chord intervals и word timings.

- **Chords:** `mir_eval.chord.evaluate`, минимум `root`, `majmin`, `triads`, `sevenths`, WCSR и segmentation score; библиотека описывает duration-weighted accuracy и interval merging ([mir_eval API](https://mir-eval.readthedocs.io/latest/api/chord.html)). Отдельно change-boundary median/p90 error.
- **Beat/downbeat:** precision/recall/F-measure с заявленной tolerance; не смешивать beat и downbeat.
- **Lyrics:** WER/CER для ASR; word-boundary mean/median/p90 absolute error; coverage `% reference words with valid timing`; отдельные line-start errors.
- **Fusion/display:** `% chord changes assigned to correct word/space`, chord-only slots preserved, deterministic golden ChordPro.
- **Robustness slices:** languages, male/female vocals, rap, melisma, choir/overlap, instrumental intros, rubato/live recordings, non-440 tuning, key changes, dense jazz chords.
- **Performance:** real-time factor CPU/GPU, peak RAM/VRAM, cold model download, per-track energy/cost.

Минимальный quality gate должен содержать не только среднее: p90 boundary error, abstention rate и failure taxonomy. Любой этап обязан уметь вернуть `unknown/low_confidence`; это лучше ложной точности.

Первый открытый alignment benchmark — JamendoLyrics MultiLang: dataset card описывает 79 Creative Commons песен на английском, французском, немецком и испанском с word start/end annotations для automatic lyrics alignment ([официальный dataset card](https://huggingface.co/datasets/jamendolyrics/jamendolyrics/blob/main/README.md)). DALI даёт line/word/note-level annotations, но официальный репозиторий распространяет dataset под CC BY-NC-SA 4.0, поэтому он годится для non-commercial research comparison, но не должен попадать в distributable/product training assets без принятия NC-ограничения ([DALI repository](https://github.com/gabolsgabs/DALI), [dataset record](https://zenodo.org/records/3576083)).

## 8. Лицензии, copyright и эксплуатационные риски

1. **Разделять четыре лицензии:** application code, dependency code, model weights и training/evaluation data. MIT/BSD orchestration не «очищает» веса или датасет.
2. **Essentia:** AGPL-3.0 либо коммерческая лицензия ([official licensing](https://github.com/MTG/essentia/blob/master/Essentia%20Licensing.txt)); архитектурное решение требуется до linking/service deployment.
3. **Madmom:** BSD-код, но pretrained models/data CC BY-NC-SA 4.0 ([repo license section](https://github.com/CPJKU/madmom#license)); NC несовместим с неограниченным коммерческим применением.
4. **BTC:** MIT-код, но audio training data не распространяется по copyright ([official Data section](https://github.com/jayg996/BTC-ISMIR19#data)); не объявлять checkpoint «чистым», пока нет model card/provenance.
5. **Audio и lyrics:** пользовательский доступ к треку/странице не даёт проекту права скачивать, хранить, обучаться или публиковать производный полный текст. Spleeter прямо возлагает обязанность получить разрешение правообладателей ([disclaimer](https://github.com/deezer/spleeter#disclaimer)). MVP должен принимать local/user-authorized audio и user-supplied/licensed lyrics; не включать scraper/download обходы.
6. **YouTube не является бесплатным audio backend:** официальные Developer Policies запрещают API clients скачивать/кешировать YouTube audiovisual content и отдельно запрещают разделять, изолировать или модифицировать audio/video components ([YouTube API Services Developer Policies](https://developers.google.com/youtube/terms/developer-policies)). Интеграцию нельзя планировать как `URL -> download -> stems` без отдельного разрешённого источника и legal review.
7. **Композиция/lyrics и sound recording — разные rights layers:** US Copyright Office отдельно описывает musical composition (music и accompanying words) и sound recording ([официальная circular](https://www.copyright.gov/register/pa-sr.html)). Open-source код не даёт права распространять ни исходную запись, ни полный синхронизированный текст.
8. **Выходы:** timestamps/chords и полный lyric text имеют разные правовые риски. По умолчанию хранить hashes/analysis и удалять исходное аудио/stems после обработки; publishing/sharing lyrics сделать отдельной политикой.
9. **Модельный manifest:** имя/revision/sha256, source URL, code license, weight license, training-data statement, accepted-use terms, date reviewed.

## 9. Этапы реализации

### Этап 0 — измеримый research spike

- канонический WAV/timebase и typed timed-JSON schema;
- 20–50 разрешённых треков с ручными annotations;
- baseline beats + chroma chord intervals;
- Qwen3-ASR/ForcedAligner и WhisperX на mix против vocals; DP reconciliation с предоставленным reference;
- отчёт WCSR, word-boundary errors, runtime и failure slices.

### Этап 1 — полезный open-source MVP

- upload/local file, playback, waveform, tempo/key, beat-synchronous `maj/min/N` chords;
- user-supplied lyrics, forced word/line alignment, ручной редактор anchors;
- deterministic chord-to-word fusion;
- timed JSON + ChordPro export, transpose/capo как presentation transform;
- confidence/unknown states и reproducible CLI.

### Этап 2 — parity expansion

- A/B/ensemble separation, richer chord vocabulary, inversions;
- All-In-One sections/downbeats и loop by section;
- multi-language pronunciation adapters, repeated chorus handling;
- editor feedback as explicitly consented correction data, not automatic training corpus.

### Этап 3 — качество и масштаб

- benchmark BTC/новых chord models против baseline;
- batch jobs/cache/model registry; CPU/GPU profiles;
- public extension API, alternative renderers and share/privacy policy.

## 10. Подтверждённые факты и решения пользователя

### Подтверждено первичными источниками

- beat-synchronous HPCP/chroma может напрямую выдавать chord labels и strength; Essentia имеет reference algorithms для обоих вариантов ([API](https://mtg.github.io/essentia.js/docs/api/Essentia.html#ChordsDetectionBeats)).
- Whisper — multilingual speech ASR с MIT code/weights; WhisperX добавляет word timestamps через phoneme alignment и перечисляет language/dictionary limitations ([Whisper](https://github.com/openai/whisper), [WhisperX](https://github.com/m-bain/whisperX)).
- forced alignment предназначен для выравнивания **заданной** орфографической транскрипции, то есть концепция «эталонный lyric text + audio -> word times» корректна ([MFA](https://montreal-forced-aligner.readthedocs.io/en/v3.4.1/user_guide/index.html#what-is-forced-alignment)).
- ChordPro — официальный формат lead sheets с inline chord anchors; timed JSON нужен дополнительно ([ChordPro](https://chordpro.org/)).
- доступные open-source компоненты имеют существенно разные лицензии кода/весов/данных; особенно Essentia AGPL и madmom model NC restriction.

### Требует подтверждения пользователя / отдельного ticket decision

1. **Product scope:** точная Chordify feature parity или сначала core `audio -> synchronized chords + user lyrics`.
2. **Вход:** только local/user-authorized audio или интеграции с внешними URL; второе требует отдельной legal/ToS проверки каждого источника.
3. **Lyrics source:** только введённый/загруженный пользователем текст либо лицензированный provider; автоматический web lyrics retrieval не входит в предложенный MVP.
4. **Лицензия проекта:** permissive (предпочтительно Apache-2.0/MIT) или AGPL; выбор определяет допустимость Essentia integration.
5. **Deployment:** local-first CPU, self-hosted GPU или hosted SaaS; это меняет separation/model choices и privacy.
6. **Quality target:** требуемые WCSR и word-boundary p90, поддерживаемые языки/жанры и acceptable abstention.
7. **Notation:** ChordPro как canonical public export и внутренний timed JSON — подтвердить; MusicXML не нужен для lead-sheet MVP.
8. **LLM policy:** рекомендуется выключить в MVP и позже допустить только schema-constrained mapping suggestions без генерации lyric text/timestamps.

## 11. Предлагаемые acceptance criteria для `wayfinder:research`

- выбран лицензионно допустимый MVP stack с зафиксированными версиями и model manifest;
- на разрешённом benchmark воспроизводимо сравнены `mix/no-vocals`, DSP/BTC и Qwen3-ASR/WhisperX/MFA варианты;
- опубликованы WCSR + boundary/coverage/runtime metrics и raw per-track results;
- доказано, что reconciliation не создаёт/удаляет reference words без явного user edit;
- один и тот же analysis JSON детерминированно создаёт одинаковый ChordPro;
- low-confidence и unmatched regions видимы в UI/API;
- legal review охватывает audio ingestion, lyrics storage/export, weights и datasets до публичного хостинга.

## 12. Провайдеры полного и синхронизированного текста

> Проверено 2026-08-12 по опубликованным официальным API docs, product pages и terms. AGPL-лицензия кода OpenChordify не передаёт пользователям лицензию на полученный от провайдера текст: code license и content/data contract остаются независимыми слоями.

| Провайдер | Что реально доступно | Тайминги | Показ, кеш и экспорт | Вывод |
|---|---|---|---|---|
| **LRCLIB** | Официальный API бесплатен, не требует регистрации или API key и возвращает `plainLyrics` и `syncedLyrics`; поиск учитывает title, artist, album и duration ([официальная API-документация](https://lrclib.net/docs)). Сервер LRCLIB открыт под MIT и может быть развёрнут самостоятельно ([официальный репозиторий](https://github.com/tranxuanthang/lrclib)). | `syncedLyrics` использует LRC с началом каждой строки; документированного word-level/character-level sync нет. Эти строки можно использовать как anchors, а слова довыравнивать по конкретному YouTube-аудио. | API требует идентифицирующий `User-Agent`, последовательные запросы, задержку 200–500 мс при batch-операциях и соблюдение `429 Retry-After`. MIT относится к коду сервера; в просмотренных официальных docs/repository не обнаружена отдельная лицензия на весь пользовательский каталог lyrics, поэтому нельзя утверждать, что тексты разрешено перепубликовывать как открытую базу. | Лучший бесплатный best-effort provider для v1: встроить lookup по умолчанию, но помечать provenance, хранить локально только для пользовательского проекта и сохранять fallback на user-supplied text/STT. Не считать LRCLIB юридически эквивалентным лицензированному Musixmatch/LyricFind. |
| **Genius public API** | Документированные song/search resources возвращают данные о песне и Genius URL, но не поле с полным lyric text ([официальные API docs: Songs](https://docs.genius.com/#songs-h2), [Search](https://docs.genius.com/#search-h2)). Получение текста из HTML-страницы — scraping, а не API capability. | В опубликованном public API нет line- или word-timestamp endpoint. | Официальные [Terms](https://genius.com/static/terms) не дают из самого факта API-доступа отдельного подтверждения прав OpenChordify на полный текст, постоянный кеш, ChordPro/PDF export или повторное распространение. Публичной документации partner lyrics feed, SLA и цены обнаружить не удалось. | Использовать только как metadata/link resolver. Full/synced lyrics не строить на Genius без отдельного письменного partner agreement. |
| **Musixmatch Pro API** | `track.lyrics.get` действительно возвращает `lyrics_body`, copyright notice и tracking URLs ([официальный endpoint](https://docs.musixmatch.com/api-reference/lyrics-catalog/track-lyrics-get)). Это не только metadata/URL. | `track.subtitle.get` возвращает line-synced `subtitle_body` в LRC/DFXP и относится к Scale plan ([docs](https://docs.musixmatch.com/api-reference/lyrics-catalog/track-subtitle-get)); `track.richsync.get` также относится к Scale plan и даёт посимвольные offsets, concurrent voices и разбиение, достаточное для word-level UI ([docs](https://docs.musixmatch.com/api-reference/lyrics-catalog/track-richsync-get)). | Self-serve API требует соблюдать территориальные restrictions; если у Musixmatch нет права показа, body не возвращается ([content restrictions](https://docs.musixmatch.com/content-restrictions)). При показе нужны copyright, attribution/backlink и view tracking; опубликованный checklist также требует отключать copy/paste для web traffic из Японии ([implementation checklist](https://docs.musixmatch.com/checklist)). Базовые [API Terms](https://about.musixmatch.com/apiterms) дают non-sublicensable/non-transferable licence по умолчанию только для non-commercial use, требуют предварительного одобрения публичных страниц, запрещают monetisation без письменного разрешения, bulk download и использование данных с AI/ML/algorithm без предварительного письменного одобрения. Terms разрешают `store` только в рамках договора и закона, но не публикуют TTL или общее право на offline/export; offline catalog feed существует как отдельная Enterprise-интеграция и его состав зависит от контракта ([Catalog Feed](https://docs.musixmatch.com/enterprises/catalog-feed/overview)). | Технически это наиболее полный API-кандидат, но для OpenChordify нужен отдельный договор, явно разрешающий self-hosted/AGPL clients, server-side fetching, нужный кеш, forced alignment/LLM processing, display, ChordPro/PDF export и территории. Сам self-serve key этого не подтверждает. |
| **LyricFind partner product** | Официальный сайт предлагает лицензированный `Lyric Display`, но не публикует self-serve developer API contract ([products](https://www.lyricfind.com/products)). | `Lyric Display` заявлен в трёх форматах: static, line-by-line и word-by-word ([product page](https://www.lyricfind.com/products/lyric-display)). | Публичных условий API, cache/export rights, цен и совместимости с self-hosted AGPL на product page нет; сайт направляет на partner/sales contact ([contact](https://www.lyricfind.com/contact)). | Реальная коммерческая альтернатива Musixmatch, но только после письменного предложения и проверки договора. |

### Неизвестное, которое нельзя домыслить из публичных документов

- У Genius: существует ли сейчас отдельный partner feed с full/synced lyrics; разрешены ли display, cache, export и обработка алгоритмами; стоимость и территории. Нужен прямой ответ Genius/правообладателей.
- У Musixmatch: допустимые cache TTL/at-rest copies, экспорт полного текста пользователю, хранение derived word timings, использование provider text в forced aligner или LLM, а также модель ключей для множества независимых self-hosted инсталляций. Всё это нужно перечислить в order form/DPA/content licence; AGPL сам по себе ответа не даёт.
- У LyricFind: transport/API format, coverage, SLA, tracking/reporting, territory rules, cache/export/derived-data rights и разрешение self-hosted distribution. Нужен sales proposal и legal review.

### Рекомендация для Wayfinder

Не делать один внешний каталог обязательной зависимостью open-source MVP. Канонический автономный путь остаётся `user-supplied lyrics или STT draft -> forced alignment`; текст, ключи и provider cache не попадают в Git, release artifacts или общую публичную базу. Спроектировать `LyricsProvider` adapter и включать:

1. LRCLIB — бесплатный best-effort lookup по умолчанию, с line timestamps и обязательным повторным alignment к анализируемой версии записи;
2. Genius — только metadata и ссылка на оригинальную страницу;
3. Musixmatch — коммерческий full/synced provider spike **после** письменного подтверждения всех перечисленных use cases, включая algorithm/AI clause и ChordPro export;
4. LyricFind — параллельный sales quote для сравнения contractual rights, coverage и цены.

До договора UI не должен обещать автоматическое получение полного текста: отсутствие права/territory restriction должно штатно переходить в загрузку текста пользователем, а не в scraping другого сайта.

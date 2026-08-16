# Open Chords v1: факты о форматах экспорта и переносимом архиве

> Исследование для Wayfinder ticket `Fix export and print semantics`. Источники проверены 2026-08-16. Использованы только спецификации, официальная документация и исходный код реализаций. Документ фиксирует ограничения форматов и вопросы для решения, но не выбирает продуктовую политику. Раздел о правах не является юридическим заключением.

## Краткий итог

1. **ChordPro — переносимый lead-sheet format, но не timed-project format.** Он хорошо выражает аккорды, привязанные к слогам, секции, chord-only grids, повторяющиеся `key` / `time` / `tempo` directives и diagram definitions. Официальная спецификация не задаёт интервалы аккордов в секундах, идентичность beats/bars, confidence, provenance или историю правок ([ChordPro introduction](https://www.chordpro.org/chordpro/chordpro-introduction/), [directives](https://www.chordpro.org/chordpro/chordpro-directives/), [grid](https://www.chordpro.org/chordpro/directives-env_grid/)).
2. **У LRC не обнаружена каноническая нормативная спецификация.** На дату проверки в IANA media-type registry нет записи `lrc` или `lyrics`; FFmpeg документирует один практически важный line-timed dialect, а историческая реализация Kodi трактует дополнительные bracket timestamps внутри строки иначе. Поэтому line timing имеет de facto interoperability, но word timing и расширенные metadata нельзя считать переносимыми без явно названного профиля ([IANA registry](https://www.iana.org/assignments/media-types/media-types.xhtml), [FFmpeg LRC muxer](https://ffmpeg.org/ffmpeg-formats.html#lrc), [Kodi LRC behavior](https://kodi.wiki/view/Archive%3ACreate_LRC_karaoke_lyrics_files)).
3. **PDF фиксирует представление, но соответствие PDF, PDF/A и PDF/UA — разные утверждения.** PDF 2.0 задаёт переносимое электронное представление; PDF/A-4 — профиль для долгосрочного сохранения статического постраничного вида; PDF/UA-2 — правила построения доступного PDF. Ни один из этих стандартов сам по себе не сохраняет редактируемую музыкальную модель Open Chords ([ISO 32000-2:2020](https://www.iso.org/standard/75839.html), [ISO 19005-4:2020](https://www.iso.org/standard/71832.html), [ISO 14289-2:2024](https://www.iso.org/standard/82278.html)).
4. **Переносимый project archive требует собственного versioned semantic manifest.** BagIt даёт полезный официальный прецедент для полного file inventory, checksums, provenance metadata и различия между `complete` и `valid`; EPUB OCF — для ZIP container root, manifest, filename portability и ограниченного набора compression methods. Оба формата показывают, что целостность, семантическая совместимость и безопасность импорта — отдельные свойства ([RFC 8493](https://www.rfc-editor.org/rfc/rfc8493.html), [EPUB 3.3 OCF](https://www.w3.org/TR/epub-33/#sec-container-abstract)).
5. **Исключение Source audio не снимает вопрос прав на lyrics.** U.S. Copyright Office рассматривает underlying musical work, включая lyrics, и конкретную sound recording как отдельные охраняемые работы. Следовательно, archive/PDF/ChordPro без аудио всё ещё может содержать охраняемый lyric text ([Copyright Office: What Musicians Should Know](https://www.copyright.gov/engage/musicians/), [musical compositions and sound recordings](https://www.copyright.gov/register/pa-sr.html)).

## 1. Матрица представимости

В таблице `частично` означает, что формат может сохранить вид или выбранную проекцию, но не исходную семантику без собственного расширения.

| Данные Open Chords | ChordPro | LRC de facto | PDF/print | Portable archive |
|---|---|---|---|---|
| Lyrics text и line structure | Да, lyric lines | Да, text после line timestamp | Визуально; семантика зависит от tagging | Может хранить канонический документ |
| Chord identity / display spelling | Частично: chord token и parser properties | Нет стандартного поля | Визуально | Может хранить structured identity |
| Chord intervals в секундах | Нет стандартной конструкции | Нет chord model | Визуально, если напечатаны | Может хранить без потерь |
| Bars / beats / meter changes | Частично: grids и позиционные `time` directives | Нет | Визуально | Может хранить без потерь |
| Line timing | Нет | Да, start timestamp | Только напечатанные значения либо иной embedded semantic layer | Может хранить без потерь |
| Word timing | Нет | Диалекты расходятся | Только presentation / tagged text, не timed lyric model | Может хранить без потерь |
| Confidence / abstention / mismatch reasons | Нет стандартной модели | Нет стандартной модели | Может показать текстом, но не сохранить domain semantics | Может хранить без потерь |
| Machine output, user edit history, active view | Нет | Нет | Нет | Может хранить без потерь |
| Provenance, model versions, settings | Только free-form metadata/extensions, с потерей interoperability | Небольшой de facto metadata set | Document metadata или видимый текст, не project provenance graph | Может хранить manifest/provenance |
| Source audio | Не является частью формата | Отдельный media file | Может быть attachment в некоторых PDF profiles, но это отдельное решение | Может быть payload или явно отсутствовать |

Основание матрицы: официальный ChordPro описывает inline chord anchors, directives, grids и diagrams, но не time-coded events ([introduction](https://www.chordpro.org/chordpro/chordpro-introduction/), [directives](https://www.chordpro.org/chordpro/chordpro-directives/), [grid](https://www.chordpro.org/chordpro/directives-env_grid/), [`define`](https://www.chordpro.org/chordpro/directives-define/)); FFmpeg принимает LRC как один text/subtitle stream с line timestamps и ограниченным набором metadata ([muxer docs](https://ffmpeg.org/ffmpeg-formats.html#lrc), [decoder source](https://ffmpeg.org/doxygen/trunk/lrcdec_8c_source.html)); PDF/A-4 сохраняет static page-based representation и допускает attachments, а PDF/UA-2 направлен на programmatic access и textual representation ([ISO 19005-4](https://www.iso.org/standard/71832.html), [ISO 14289-2](https://www.iso.org/standard/82278.html)).

## 2. ChordPro

### 2.1. Что выражается официальным синтаксисом

- Chords помещаются в `[...]` прямо перед слогом, к которому относятся; renderer выводит chord над этим слогом. Это **семантический текстовый anchor**, а не timestamp ([ChordPro introduction](https://www.chordpro.org/chordpro/chordpro-introduction/)).
- Standard metadata directives включают `title`, `sorttitle`, `subtitle`, `artist`, `composer`, `lyricist`, `arranger`, `copyright`, `album`, `year`, `key`, `time`, `tempo`, `duration` и `capo`. Произвольные metadata names разрешены, но трактовка оставлена processing tools ([`meta` directive](https://www.chordpro.org/chordpro/directives-meta/)).
- `key`, `time` и `tempo` могут встречаться несколько раз и применяются с места появления. Это позволяет выразить изменения в линейной структуре lead sheet, но спецификация не связывает позицию directive с Project Time или стабильным ID bar/beat ([`key`](https://www.chordpro.org/chordpro/directives-key/), [`time`](https://www.chordpro.org/chordpro/directives-time/), [`tempo`](https://www.chordpro.org/chordpro/directives-tempo/)).
- Environments группируют sections; имена environments могут быть произвольными, а неизвестные environments должны обрабатываться как lyrics. Стандартные специальные случаи включают chorus, verse, bridge, tab и grid ([environment directives](https://www.chordpro.org/chordpro/directives-env/)).
- Chord-only `grid` делит cells bar lines; в официальном примере четыре cells соответствуют четырём beats measure. Grid поддерживает пустую cell `.`, несколько chords в cell через `~`, bar/repeat/volta symbols и `%`/`%%` measure repeats ([grid directive](https://www.chordpro.org/chordpro/directives-env_grid/)).
- `define` описывает fingering для string instruments и notes относительно root для keyboard instruments. Conditional directives допускают отдельные definitions, например, для guitar и ukulele ([`define`](https://www.chordpro.org/chordpro/directives-define/), [conditional directives](https://www.chordpro.org/chordpro/chordpro-directives/#conditional-directives)).

### 2.2. Chord vocabulary и деградация

ChordPro File Format намеренно не определяет исчерпывающий набор допустимых chord names. Reference implementation имеет strict и relaxed parsing; для transposition/diagrams требуется распознанный root и поддерживаемые chord properties. Нераспознанное содержимое brackets всё ещё может печататься, но теряет надёжную transposition/diagram semantics ([ChordPro chords](https://www.chordpro.org/chordpro/chordpro-chords/)).

Reference implementation:

- разбирает `root`, `qual`, `ext`, optional `bass` и поддерживает common, German, Roman, Nashville и другие note systems;
- перечисляет большой, но implementation-owned набор extensions;
- включает major/minor, augmented, diminished, suspended, added/extended и slash-bass forms; half-diminished встречается как `m7b5` и `h`/`h7`;
- сохраняет original `name` как fallback для unparsable chords, включая `NC`;
- нормализует альтернативные spellings в companion `*_canon` properties, например `Bes`, `Bb` и `B♭` к `Bb` ([ChordPro chords](https://www.chordpro.org/chordpro/chordpro-chords/), [`define` canonical representations](https://www.chordpro.org/chordpro/directives-define/#canonical-representations)).

Отсюда следуют не решения, а границы формата:

1. Structured Open Chords chord может быть **напечатан** как arbitrary token, даже если consumer не понимает его музыкальную структуру.
2. Для сохранения cross-tool transposition/diagram behavior нужен ограниченный совместимый chord spelling profile либо проверяемые `define` directives.
3. `N` / no-chord требует отдельного правила отображения: официальный parser упоминает fallback `NC`, но не объявляет единый domain value для no-chord ([`define` formatting note](https://www.chordpro.org/chordpro/directives-define/#formatting)).
4. Enharmonic display и canonical identity нельзя неявно смешивать: reference implementation отдельно хранит original и canonical properties ([canonical representations](https://www.chordpro.org/chordpro/directives-define/#canonical-representations)).

### 2.3. Extensions и interoperability

Application-specific directives с prefix `x_` должны игнорироваться consumers, которые их не поддерживают; рекомендуемый namespace следует после prefix. Это даёт безопасную точку расширения, но по определению не делает extension переносимым между consumers ([custom extensions](https://www.chordpro.org/chordpro/chordpro-directives/#custom-extensions)).

Кроме того, ChordPro прямо отделяет semantic hint directive от фактической formatter behavior: отображение, pagination, fonts и colours зависят от implementation/configuration. Полные names и explicit attributes считаются более robust/future-proof, а отдельная документация предупреждает, что многие внешние tools распознают `{title: ...}`, но не семантически эквивалентный `{meta: title ...}` ([directives overview](https://www.chordpro.org/chordpro/chordpro-directives/), [`title`](https://www.chordpro.org/chordpro/directives-title/)).

**Следствие для будущего loss contract:** один ChordPro файл не может одновременно гарантировать полный Open Chords round trip и максимальную совместимость с независимыми ChordPro tools. Если в нём будут собственные timings/provenance/edit directives, compliant consumers вправе их игнорировать.

## 3. LRC

### 3.1. Статус спецификации

В ходе исследования не найден authoritative owner specification, standards-track document или зарегистрированный LRC media type. В IANA registry, обновлённом 2026-08-14, поиск по `lrc` и `lyrics` не дал совпадений ([IANA Media Types](https://www.iana.org/assignments/media-types/media-types.xhtml)). Это не доказывает отсутствие всех исторических описаний, но означает, что нельзя ссылаться на IANA/IETF/W3C/ISO как на каноническую LRC grammar.

Надёжно цитируемые факты ниже относятся к конкретным implementations, а не ко «всем LRC players».

### 3.2. FFmpeg dialect

Официальная документация FFmpeg описывает LRC muxer так:

- input — один `subrip` или `text` subtitle stream;
- timestamp fractional precision настраивается от 1 до 6 digits, default — 2 digits (centiseconds);
- mapped metadata: `title`, `album`, `artist`, `author`, `creator`, `encoder`, `encoder_version` ([FFmpeg formats: LRC](https://ffmpeg.org/ffmpeg-formats.html#lrc)).

Writer source заменяет line breaks внутри metadata пробелами и предупреждает о lyric text, который начинается с `[`, потому что такой текст может быть ошибочно распознан как LRC syntax ([FFmpeg `lrcenc.c`](https://ffmpeg.org/doxygen/trunk/lrcenc_8c_source.html)). Это дополнительные serialization ambiguities, которые нельзя вывести только из расширения `.lrc`.

Текущий decoder source принимает leading bracket timestamp, допускает несколько leading timestamps для одной text payload, применяет global `[offset:...]`, создаёт text subtitle packet с start PTS и первоначально ставит `duration = -1`; очередь затем finalizes events ([FFmpeg `lrcdec.c`](https://ffmpeg.org/doxygen/trunk/lrcdec_8c_source.html)). Mapping коротких tags — `ti`, `al`, `ar`, `au`, `by`, `re`, `ve` — задан прямо в source ([FFmpeg `lrc.c`](https://ffmpeg.org/doxygen/trunk/lrc_8c_source.html)).

Это подтверждает representability line starts, но не даёт:

- explicit end timestamp для строки;
- token/word IDs и word intervals;
- language, confidence, alignment mismatch, source/provider rights или edit provenance в documented portable metadata set;
- формальной semantics для equal/duplicate timestamps, последней строки без следующего event и текста до первого timestamp.

### 3.3. Word-level dialects расходятся

Archived official Kodi guidance показывает другой behavior: timestamps могут стоять не только в начале line, но и между text fragments, причём Kodi использовал их для progressive character painting; пример содержит `[00:53.60]On a dark [00:54.85]desert highway[00:56.26]` ([Kodi LRC guide](https://kodi.wiki/view/Archive%3ACreate_LRC_karaoke_lyrics_files)). FFmpeg decoder, напротив, извлекает только последовательность **leading** timestamps и помещает остаток строки в text packet ([FFmpeg source](https://ffmpeg.org/doxygen/trunk/lrcdec_8c_source.html)).

Поэтому «enhanced LRC» нельзя использовать как неоговорённый синоним word-timed LRC: один consumer может интерпретировать внутренние bracket tags как karaoke timing, другой — оставить их частью text. Также встречается angle-bracket syntax в сторонних диалектах, но первичной нормативной спецификации для него в ходе исследования не обнаружено.

### 3.4. Неопределённости, требующие loss policy

Для детерминированного LRC export ticket должен закрыть как минимум следующие вопросы, не полагаясь на название формата:

- точная grammar line timestamp и разрешённая precision;
- rounding rule при переводе sample/project time в decimal timestamp;
- сортировка и поведение equal timestamps;
- start-only или start/end representation;
- empty/instrumental lines, unmatched lyric tokens и alignment mismatch;
- перенос нескольких voices/repeated lines;
- word timing: отказ, degradation до line starts или конкретный named dialect;
- metadata whitelist, UTF-8/BOM/newline policy;
- loss reporting вне LRC, поскольку documented FFmpeg tags не несут эти сведения.

Это список decision inputs, а не предложенные ответы.

## 4. PDF и печать

### 4.1. Три разных уровня утверждений

- ISO 32000-2:2020 определяет PDF 2.0 как форму представления электронных документов для обмена и просмотра независимо от environment, где документ создан, просматривается или печатается. Он не определяет конкретный UI, rendering implementation или validation method ([ISO 32000-2](https://www.iso.org/standard/75839.html)).
- ISO 19005-4:2020 (PDF/A-4) определяет использование PDF 2.0 для сохранения static visual representation page-based documents во времени и допускает включение иных типов content как embedded file/attachment ([ISO 19005-4](https://www.iso.org/standard/71832.html)).
- ISO 14289-2:2024 (PDF/UA-2) определяет, как строить accessible digital documents на PDF 2.0; стандарт подчёркивает programmatic access и textual representation, но не задаёт content-specific requirements для chord sheets ([ISO 14289-2](https://www.iso.org/standard/82278.html)).

Таким образом, «валидный PDF», «archival PDF» и «accessible PDF» — не взаимозаменяемые статусы. Совместное соответствие профилям возможно только после проверки требований каждого профиля; PDF Association публикует отдельные reference suites и best-practice materials для tagged PDF/PDF-UA ([PDF/UA reference suite](https://pdfa.org/resource/pdfua-reference-suite/), [Tagged PDF Best Practice Guide](https://pdfa.org/resource/tagged-pdf-best-practice-guide-syntax/)).

### 4.2. Accessibility facts, применимые к acceptance criteria

PDF/UA-2 является PDF-specific target. WCAG 2.2 дополнительно даёт проверяемые presentation criteria: text contrast минимум 4.5:1 для обычного текста, 3:1 для large text; content не должен зависеть только от images of text; information/relationships и meaningful sequence должны быть programmatically determinable ([WCAG 2.2](https://www.w3.org/TR/WCAG22/)). Эти web-content criteria не заменяют PDF/UA conformance, но могут выявлять дефекты самого визуального chord sheet.

Музыкальные особенности оставляют content-specific вопросы за пределами PDF/UA abstract: reading order между chord labels и lyrics, textual equivalent диаграмм, произношение chord symbols, различимость low-confidence states без одного цвета. Их нужно будет превратить в тестируемые product requirements; стандарты не выбирают presentation Open Chords автоматически.

### 4.3. Детерминированность печатного результата

ChordPro specification оставляет formatter behavior на усмотрение программы, а reference implementation позволяет менять fonts, sizes, colours, page/column breaks и configuration ([ChordPro directives](https://www.chordpro.org/chordpro/chordpro-directives/)). ISO PDF определяет file representation, но не исходный layout algorithm ([ISO 32000-2](https://www.iso.org/standard/75839.html)).

**Вывод из этих источников:** byte-stable или layout-stable PDF нельзя обещать только на основании одинакового ChordPro input. Такое обещание потребует зафиксированных renderer/version, fonts, locale, page geometry, diagram pack, line-breaking/pagination rules и metadata/time normalization, а затем отдельной visual/conformance validation. Это инженерный вывод, не требование ChordPro или ISO.

Для PDF/A validation существует industry-supported open-source veraPDF test suite под надзором PDF Association PDF Validation Technical Working Group; integrity семантического Project всё равно остаётся задачей source JSON/archive, а не PDF/A ([veraPDF test suite](https://pdfa.org/resource/verapdf-test-suite/)).

## 5. Portable Project Archive

### 5.1. BagIt как precedent для inventory и integrity

RFC 8493 определяет BagIt как filesystem hierarchy для arbitrary digital content с payload и metadata tag files. Каждый payload manifest должен перечислять каждый payload file ровно один раз с checksum; BagIt 1.0 tools обязаны поддерживать SHA-256 и SHA-512. `complete` означает наличие всех обязательных и перечисленных files, а `valid` дополнительно означает успешную проверку всех manifest checksums ([RFC 8493, sections 2–3](https://www.rfc-editor.org/rfc/rfc8493.html#section-2)).

Другие полезные свойства precedent:

- `bag-info.txt` имеет human-readable fields для description, date, external identifier и provenance, плюс допускает arbitrary metadata ([section 2.2.2](https://www.rfc-editor.org/rfc/rfc8493.html#section-2.2.2));
- custom tag files можно включать в tag manifest для integrity, но implementations обязаны иначе игнорировать их contents — extension integrity не равна semantic interoperability ([section 2.2.4](https://www.rfc-editor.org/rfc/rfc8493.html#section-2.2.4));
- checksums защищают от corruption, но стандарт прямо не обещает защиту от active attack; для неё требуются дополнительные measures, например signatures ([section 5.4](https://www.rfc-editor.org/rfc/rfc8493.html#section-5.4));
- manifest paths нельзя позволять использовать для доступа вне bag root; RFC отдельно приводит `/`, `..`, `~username`, Windows drive и namespace paths как attack cases ([section 5.1](https://www.rfc-editor.org/rfc/rfc8493.html#section-5.1));
- optional `fetch.txt` описывает удалённые payload holes, которые должны быть скачаны до проверки completeness, и создаёт отдельные URL/size security risks ([sections 2.2.3, 5.2–5.3](https://www.rfc-editor.org/rfc/rfc8493.html#section-2.2.3)).

BagIt — directory layout, а не ZIP serialization, и RFC прямо отличает его от ZIP/TAR. Поэтому он является precedent для manifest semantics, а не автоматическим выбором extension/container Open Chords ([RFC 8493 purpose](https://www.rfc-editor.org/rfc/rfc8493.html#section-1.1)).

### 5.2. EPUB OCF как precedent для ZIP container

EPUB 3.3 Open Container Format определяет единый root, обязательный `META-INF`, package manifest и ZIP representation. OCF ограничивает ZIP entries stored/Deflate methods, требует UTF-8 filenames и запрещает ZIP-level encryption; processor должен rigorously проверять size и validity получаемых данных ([EPUB 3.3 OCF structure](https://www.w3.org/TR/epub-33/#sec-container-abstract), [ZIP requirements](https://www.w3.org/TR/epub-33/#sec-zip-container-zipreqs), [media-type security considerations](https://www.w3.org/TR/epub-33/#app-media-type)).

OCF также:

- ограничивает filename characters/lengths и требует uniqueness после Unicode canonical normalization и full case folding, чтобы уменьшить cross-platform ambiguity ([file paths and names](https://www.w3.org/TR/epub-33/#sec-container-filenames));
- задаёт root URL semantics, при которых `..` от root остаётся root, чтобы ссылки не «утекали» из container ([URLs in OCF](https://www.w3.org/TR/epub-33/#sec-container-iri));
- запрещает `file:` URLs в publication как security и interoperability risk ([file URLs](https://www.w3.org/TR/epub-33/#sec-file-urls));
- отделяет package manifest от optional rights, signatures, encryption и container metadata files ([`META-INF`](https://www.w3.org/TR/epub-33/#sec-container-metainf)).

Это precedents, а не основание называть project archive EPUB.

Ещё один официальный packaging precedent — ECMA-376 Part 2 Open Packaging Conventions: ZIP package состоит из typed parts, package-level metadata и explicit relationships между parts. OPC полезен как пример отделения physical container от logical graph, но он ориентирован на Office Open XML и не задаёт музыкальную project semantics ([ECMA-376](https://ecma-international.org/publications-and-standards/standards/ecma-376/)).

### 5.3. Semantic manifest, schema и canonical bytes

RFC 8259 требует unique object names для предсказуемой interoperability, UTF-8 при обмене между системами и запрещает полагаться на member order: JSON libraries различаются в том, показывают ли order callers. Он также отмечает, что exact agreement между implementations для integers гарантировано только в диапазоне `[-(2^53)+1, (2^53)-1]` ([RFC 8259, sections 4, 6 and 8.1](https://www.rfc-editor.org/rfc/rfc8259.html)). JSON Schema Draft 2020-12 предоставляет официальный vocabulary для structural validation, но schema validation не определяет byte serialization ([JSON Schema 2020-12](https://json-schema.org/draft/2020-12)).

Если checksum/signature должен зависеть от JSON **содержания**, а не от случайного whitespace/property order, RFC 8785 определяет JSON Canonicalization Scheme с invariant primitive serialization и deterministic recursive property sorting. RFC имеет Informational status, не IETF Standards Track ([RFC 8785](https://www.rfc-editor.org/rfc/rfc8785.html)).

Для provenance W3C PROV-DM даёт domain-neutral distinction между entities, generating/using activities, responsible agents и derivations/revisions. Это conceptual interoperability precedent; применение полной PROV serialization не обязательно и остаётся отдельным решением ([W3C PROV-DM](https://www.w3.org/TR/prov-dm/), [PROV-O](https://www.w3.org/TR/prov-o/)).

### 5.4. Намеренно отсутствующее аудио

BagIt считает listed-but-missing payload признаком incomplete package; remote holes в `fetch.txt` всё равно являются требуемым payload до completeness check ([RFC 8493 complete/valid](https://www.rfc-editor.org/rfc/rfc8493.html#section-3), [`fetch.txt`](https://www.rfc-editor.org/rfc/rfc8493.html#section-2.2.3)).

**Следствие для собственного archive manifest:** «Source audio намеренно не включено», «external dependency», «redacted по privacy/rights policy» и «required file повреждён/потерян» должны быть различимыми состояниями. Если omitted audio просто отсутствует из списка required payload, checksum validation не объяснит получателю, было ли отсутствие намеренным. Точная schema этих состояний — продуктовый вопрос.

Тот же вопрос применим к models/dictionaries, provider-fetched lyrics, generated PDF и rebuildable caches: manifest должен позволить отличить retained authoritative content от derived, external, optional и deliberately omitted content, иначе completeness и reproducibility будут смешаны.

## 6. Lyrics rights и provenance

U.S. Copyright Office формулирует две отдельные works:

- musical work — underlying composition и accompanying lyrics;
- sound recording — конкретная fixation performance/production.

Они обычно принадлежат и лицензируются отдельно; для использования чужой работы обычно нужно public-domain status, permission/license либо применимое statutory limitation/exception ([Copyright Office musician guidance](https://www.copyright.gov/engage/musicians/), [registration distinction](https://www.copyright.gov/register/pa-sr.html)).

Из этого следуют границы утверждений, которые может делать export manifest:

1. Исключение `.wav`/media bytes подтверждает отсутствие копии sound recording в archive, но ничего само по себе не говорит о праве распространять полный lyrics text.
2. ChordPro `{copyright: ...}` и arbitrary metadata могут перенести notice, но официальный ChordPro оставляет интерпретацию metadata processing tools; metadata не является доказательством licence grant ([ChordPro `meta`](https://www.chordpro.org/chordpro/directives-meta/)).
3. Provenance (`provider`, source URL/ID, retrieved/edited revision, user-supplied status) отвечает на вопрос происхождения данных; rights basis/permission и redistribution scope — отдельные сведения. W3C PROV также различает derivation/attribution/history от правовой авторизации ([PROV-DM](https://www.w3.org/TR/prov-dm/)).
4. PDF, ChordPro, LRC и archive — разные формы фиксации/копии; смена container не устраняет rights layer lyrics.

Dublin Core Metadata Terms формализует это различие на уровне metadata vocabulary: `source` — связанный ресурс, из которого описываемый ресурс derived; `rights` — сведения о правах; `license` — legal document, дающий официальное разрешение. Поэтому source/provider URI не является license assertion ([DCMI `source`](https://www.dublincore.org/specifications/dublin-core/dcmi-terms/terms/source/), [`rights`](https://www.dublincore.org/specifications/dublin-core/dcmi-terms/terms/rights/), [`license`](https://www.dublincore.org/specifications/dublin-core/dcmi-terms/terms/license/)).

Какие rights assertions пользователь может или должен дать, какие provider terms разрешают export, и разрешено ли переносить provider-fetched lyrics в archive требуют отдельной policy/legal review; стандарты форматов ответа не дают.

## 7. Нерешённые вопросы для decision ticket

Исследование сужает решение до следующих явных контрактов:

### Open Chords JSON

- Является ли export snapshot только Effective Timeline или включает selected Analysis Revision, Edit Layer и Active View?
- Какая schema/version/migration compatibility обещана внешним consumers?
- Нужен ли canonical byte representation или достаточно semantic equality после parse?
- Какие clocks сохраняются авторитетно: samples/project time, seconds, bars/beats; какие являются derived views?
- Как кодируются abstention, `N`, unmatched lyrics и deliberate omissions без conflation?

### ChordPro

- Какой minimum compatibility profile выбран для независимых tools?
- Какие chord spellings гарантируют transposition/diagrams, а какие экспортируются только как visible fallback?
- Как Chord Events проецируются на lyric anchors и grids при mid-beat changes, unmetered regions, multiple chords per beat и отсутствии lyrics?
- Нужны ли `x_open_chords_*` extensions, и считается ли их игнорирование нормальной loss или ошибкой?
- Включаются ли instrument-specific `define` directives или diagrams остаются только в PDF?

### LRC

- Какой named dialect и exact grammar поддерживаются?
- Только line timing или конкретный word-timing extension?
- Какие rounding/order/end-time правила делают output воспроизводимым?
- Когда LRC недоступен: нет Lyrics Alignment, только partial/mismatched alignment, либо недостаточная confidence?
- Где находится machine-readable loss report, поскольку сам LRC его надёжно не переносит?

### PDF/print

- Какой conformance target заявляется: обычный PDF, PDF/A variant, PDF/UA variant или проверяемая комбинация?
- Какие page sizes, fonts, locales, chord spellings, diagram packs и pagination rules входят в deterministic render profile?
- Какой tagged reading order и textual alternative нужны для chords, grids и instrument diagrams?
- Должен ли PDF содержать attached Open Chords JSON, либо остаётся чистым presentation artifact?

### Portable Project Archive

- Каковы media type/extension, magic/version marker и schema compatibility policy?
- Как files инвентаризируются и хешируются; что значит complete, valid, authentic и reproducible?
- Как кодируются authoritative, derived, external, optional и deliberately omitted artifacts?
- Как импорт ограничивает paths, links, compression algorithms, expanded bytes/file count/nesting и active content?
- Хранятся ли Source identity/provenance без media; допускаются ли remote fetch instructions?
- Какие lyrics/provenance/rights fields экспортируются, а какие provider data должны быть omitted/redacted?

## 8. Primary-source index

### ChordPro

- [Introduction and inline chord anchors](https://www.chordpro.org/chordpro/chordpro-introduction/)
- [Directives, extensions and conditional directives](https://www.chordpro.org/chordpro/chordpro-directives/)
- [Chord parsing and supported notation](https://www.chordpro.org/chordpro/chordpro-chords/)
- [`meta`](https://www.chordpro.org/chordpro/directives-meta/), [`key`](https://www.chordpro.org/chordpro/directives-key/), [`time`](https://www.chordpro.org/chordpro/directives-time/), [`tempo`](https://www.chordpro.org/chordpro/directives-tempo/)
- [Sections/environments](https://www.chordpro.org/chordpro/directives-env/), [grids](https://www.chordpro.org/chordpro/directives-env_grid/), [diagram definitions](https://www.chordpro.org/chordpro/directives-define/)

### LRC implementations and registry

- [IANA Media Types Registry](https://www.iana.org/assignments/media-types/media-types.xhtml)
- [FFmpeg LRC muxer documentation](https://ffmpeg.org/ffmpeg-formats.html#lrc)
- [FFmpeg LRC decoder source](https://ffmpeg.org/doxygen/trunk/lrcdec_8c_source.html) and [metadata mapping source](https://ffmpeg.org/doxygen/trunk/lrc_8c_source.html)
- [FFmpeg LRC writer source](https://ffmpeg.org/doxygen/trunk/lrcenc_8c_source.html)
- [Archived official Kodi LRC behavior](https://kodi.wiki/view/Archive%3ACreate_LRC_karaoke_lyrics_files)

### PDF and accessibility

- [ISO 32000-2:2020 — PDF 2.0](https://www.iso.org/standard/75839.html)
- [ISO 19005-4:2020 — PDF/A-4](https://www.iso.org/standard/71832.html)
- [ISO 14289-2:2024 — PDF/UA-2](https://www.iso.org/standard/82278.html)
- [WCAG 2.2](https://www.w3.org/TR/WCAG22/)
- [PDF Association reference resources](https://pdfa.org/resources)

### Archive, JSON and provenance

- [RFC 8493 — BagIt 1.0](https://www.rfc-editor.org/rfc/rfc8493.html)
- [EPUB 3.3 — Open Container Format](https://www.w3.org/TR/epub-33/#sec-container-abstract)
- [ECMA-376 Part 2 — Open Packaging Conventions](https://ecma-international.org/publications-and-standards/standards/ecma-376/)
- [RFC 8259 — JSON](https://www.rfc-editor.org/rfc/rfc8259.html)
- [RFC 8785 — JSON Canonicalization Scheme](https://www.rfc-editor.org/rfc/rfc8785.html)
- [JSON Schema Draft 2020-12](https://json-schema.org/draft/2020-12)
- [W3C PROV-DM](https://www.w3.org/TR/prov-dm/) and [PROV-O](https://www.w3.org/TR/prov-o/)
- [Dublin Core Metadata Terms](https://www.dublincore.org/specifications/dublin-core/dcmi-terms/)

### Rights

- [U.S. Copyright Office: What Musicians Should Know about Copyright](https://www.copyright.gov/engage/musicians/)
- [U.S. Copyright Office: Musical Compositions and Sound Recordings](https://www.copyright.gov/register/pa-sr.html)

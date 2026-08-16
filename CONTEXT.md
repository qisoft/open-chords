# Open Chords

Open Chords turns one selected range of a user-authorized recording into a locally stored, editable, timed musical project for playback, practice, and export.

## Language

**Project**:
A local single-user workspace for one selected time range of one media source, containing machine analysis, user edits, provenance, and practice state. Projects remain independent even when they share the same Source and Project Range.
_Avoid_: Song, track, document

**Project Library**:
The one active local collection that authoritatively stores Projects and their revisions, provenance, settings, and allowed derived artifacts while referring to Source media outside the Library. Portable Project Archives, caches, and rebuildable indexes are not the Library.
_Avoid_: Account, cloud library, project index, media folder

**Library Trash**:
The recoverable 30-day holding state for deleted Projects and their owned artifacts. Trashed Projects retain references needed for restoration but are excluded from the active Project Library.
_Avoid_: Permanent deletion, system trash, archive

**Source**:
A stable local record for the media from which Project ranges are selected. Local-file Sources are identified by content fingerprint and YouTube Sources by provider plus canonical video ID; one Source may be shared by multiple Projects and is not stored inside a portable archive by default.
_Avoid_: File path, URL, upload, song

**Source Locator**:
One of the replaceable locations through which Open Chords can currently access and verify a Source, such as a local file path or an original YouTube URL. A Source may have several Locators; each may change or become invalid without changing Source identity.
_Avoid_: Source ID, canonical identity

**Source Fingerprint**:
The full SHA-256 content identity of a local Source or acquired media representation, used to confirm exact equality independently of filename and location.
_Avoid_: Fast hash, file metadata, Source Locator

**Source Snapshot**:
An immutable record of one acquired representation of a Source, including its byte and canonical-audio fingerprints, duration, acquisition provenance, and observed metadata. Multiple Snapshots may belong to one YouTube Source when its delivered media changes.
_Avoid_: Source, cache entry, latest download

**Source Metadata Observation**:
A timestamped, provider-attributed observation of mutable Source metadata such as title, uploader, thumbnail, and declared duration. It neither defines Source identity nor rewrites earlier Source Snapshots.
_Avoid_: Source identity, Project title, metadata truth

**Acquisition Job**:
The bounded operation that obtains one representation of one canonical public YouTube video, validates it, and terminates its network domain before publishing a Source Snapshot or handing media to offline analysis.
_Avoid_: Download, Analysis Job, YouTube playback

**Acquisition Attempt**:
One isolated execution of an Acquisition Job with its own workspace, manifest, budgets, and terminal outcome. Failed or cancelled Attempts retain only safe provenance for seven days and never partial media or an unpublished Source Snapshot.
_Avoid_: Retry continuation, partial download, Source Snapshot

**Extractor Worker**:
The contained, credential-free acquisition participant that runs the pinned YouTube extractor without direct IP-network access and can see only its packaged tools and disposable workspace.
_Avoid_: Sidecar, downloader process, Network Broker

**Acquisition Network Broker**:
The sole networked participant in an Acquisition Job, enforcing the versioned endpoint, redirect, DNS, TLS, request, and resource policy for every transfer requested by the Extractor Worker.
_Avoid_: Proxy setting, generic fetch, Extractor Worker

**Acquisition Budget Profile**:
The release-versioned set of hard network, time, storage, memory, CPU, and process ceilings enforced consistently across an Acquisition Job and identified in its provenance.
_Avoid_: User preference, metadata estimate, adaptive limit

**Offline Media Cache**:
An explicitly enabled, removable local copy of a Project Range from a verified Source Snapshot, used for offline playback or reanalysis without becoming part of the Project or changing Source identity. It remains until explicit removal or loss/corruption rather than being silently evicted by recency.
_Avoid_: Source, Project data, temporary job audio, archive content

**Model Store**:
The global content-addressed collection of installed, immutable analyzer models and dictionaries shared across Projects. Projects and archives reference exact artifacts but do not contain the Store.
_Avoid_: Project data, model cache, application bundle

**Model Artifact**:
One immutable data-only model, dictionary, or calibration dependency identified by exact version, content hash, source, license, model card, and compatible runtime. A newer Artifact never silently substitutes for one named by a Recipe.
_Avoid_: Latest model, executable plugin, Model Store

**Unavailable Source**:
A Source for which no current Locator yields its verified content. It retains its identity and Projects rather than being replaced by whatever occupies an old location.
_Avoid_: Deleted Project, changed Source

**Project Range**:
The immutable contiguous interval of a Source analyzed by one Project. Choosing another interval creates another Project; multiple Projects may refer to the same long Source.
_Avoid_: Clip, song split

**Source Time**:
A position in the original Source used to locate a Project Range and synchronize external playback. It is not the canonical coordinate for musical events.
_Avoid_: Timeline time, analysis time

**Project Time**:
The canonical sample-frame coordinate relative to the start of a Project Range. Timed entities use half-open intervals in Project Time; seconds are derived for display and external playback.
_Avoid_: Seconds, player time, Source Time

**Analysis Revision**:
An immutable machine-produced set of musical observations for a Project Range, including confidence, provenance, model versions, and settings. A Project may retain multiple Analysis Revisions and designate one as active.
_Avoid_: Analysis, final result, truth

**Reviewable Revision**:
A successfully published Analysis Revision that is available for comparison but has not replaced the Project's current Active View. Activating it is an explicit durable choice and does not transfer existing edits automatically.
_Avoid_: Candidate output, latest analysis, pending save

**Analysis Recipe**:
The immutable, content-identified declaration of canonical audio, requested capabilities, pipeline graph, component/model/calibration artifacts, settings, seeds, and resource profile for one analysis result.
_Avoid_: User preset, mutable job settings, Analysis Manifest

**Analysis Preset**:
A release-supported, versioned product choice that materializes into a complete Analysis Recipe. It names only packaged and validated pipeline options rather than exposing arbitrary analyzer internals or executable/model paths.
_Avoid_: Analysis Recipe, plugin configuration, command-line arguments

**Analysis Resource Profile**:
A release-versioned, content-identified set of CPU, memory, workspace, process, backend, checkpoint, and deadline policies used by an Analysis Recipe. Eco, Balanced, and Fast profiles express bounded execution trade-offs without changing themselves at runtime.
_Avoid_: Adaptive tuning, arbitrary process priority, Acquisition Budget Profile

**Analysis Job**:
The durable intent to produce one Analysis Revision for one Project Range and verified Source Snapshot using one fixed Analysis Recipe. It may remain blocked or retryable and own several immutable Attempts; it terminates only by accepting one result or explicit abandonment.
_Avoid_: Analysis Revision, sidecar session, Alignment Job

**Analysis Job Key**:
The identity of one logical analysis request: Project, verified Source Snapshot or canonical-audio fingerprint, and Analysis Recipe hash. An existing nonterminal or successful Job with the same Key is reused instead of duplicating work.
_Avoid_: Attempt ID, queue position, Analysis Revision ID

**Analysis Attempt**:
One execution of an Analysis Job with its own lifecycle, runtime evidence, stage outcomes, and immutable terminal state. A failed, cancelled, or interrupted Attempt may leave its Job retryable but never becomes an Analysis Revision.
_Avoid_: Retry continuation, Analysis Revision, Acquisition Attempt

**Analysis Stage Outcome**:
The technical terminal result of one Recipe stage: completed, completed with musical abstentions, cancelled, failed, or skipped by the Recipe. Technical failure is never represented as low confidence or musical abstention.
_Avoid_: Assertion State, partial Analysis Revision, progress message

**Analysis Failure**:
A stable, redacted classification of why an Analysis Job could not publish a Revision, identifying the affected stage, retryability, and next action without converting technical failure into musical uncertainty.
_Avoid_: Abstention, warning, raw exception

**Analysis Checkpoint**:
A completed, main-validated, content-addressed non-media stage artifact reusable only when its exact upstream inputs and Recipe subgraph still match. Reusing a Checkpoint starts a new Attempt rather than resuming process state.
_Avoid_: Partial Analysis Revision, temporary audio, process snapshot

**Timeline Entity**:
An identified machine-produced or user-authored section, meter region, bar, beat, chord event, or lyric interval in a Musical Timeline. Machine identity is scoped to one Analysis Revision and never implies identity across revisions.
_Avoid_: Array item, timestamp, annotation

**Assertion State**:
The status of a machine observation as asserted, low-confidence, or abstained, accompanied by named evidence and reason codes. An abstention is unknown evidence and is distinct from the musical value `N`; user-authored assertions carry no invented machine confidence.
_Avoid_: Confidence percentage, valid flag

**Confidence Calibration**:
A versioned, content-identified mapping from one analyzer task and score scale to assertion thresholds or calibrated probabilities established on declared benchmark evidence. Calibrations are not shared implicitly between capabilities, classes, or analyzers.
_Avoid_: Raw score, universal confidence, UI percentage

**Analysis Manifest**:
The immutable portable provenance record for an Analysis Revision, containing its identity-bearing Recipe and accepted output hashes plus producing reproducibility conditions, stage outcomes, and warnings without volatile or private machine data.
_Avoid_: Attempt Record, log, environment dump, metadata bag

**Analysis Evidence**:
The immutable, bounded, schema-valid machine observations and named score data retained with an Analysis Revision to explain its assertions without preserving source audio, arbitrary tool state, or debug output.
_Avoid_: Analysis Revision, temporary feature dump, diagnostic log

**Attempt Record**:
The non-portable, seven-day operational evidence for one Analysis Attempt, including its identity, timestamps, platform/resource measurements, retry history, diagnostics, and terminal reason. It does not affect Analysis Revision identity or replace permanent Analysis Manifest provenance.
_Avoid_: Analysis Manifest, Analysis Revision, diagnostic log

**Edit Layer**:
The nondestructive user-authored changes based on one specific Analysis Revision, with undo and reset semantics that preserve machine output. Moving edits to another Analysis Revision is an explicit operation whose conflicts remain visible.
_Avoid_: Corrected analysis, overwrite, merged result

**Edit Transaction**:
An atomic, ordered set of typed user operations in an Edit Layer. Transactions form an append-only history; undo and redo select a history position rather than mutating machine output.
_Avoid_: Patch file, autosave snapshot, mutation

**Musical Timeline**:
The ordered musical entities expressed in Project Time, including sections, meters, bars, beats, chord events, and optional lyric word intervals for a Project Range.
_Avoid_: Chord sheet, waveform

**Bar**:
A contiguous metered interval in Project Time containing an ordered set of Beats. A Bar may be complete, a pickup, or truncated; meter changes occur only between Bars.
_Avoid_: Measure boundary, downbeat interval

**Full-Bar Chord Event**:
A Chord Event whose interval exactly spans one complete Bar. Full-bar duration is derived from that Bar's meter (for example, three quarter-note beats in 3/4 or six eighth-note beats in 6/8) and must not be presented as a whole-note duration.
_Avoid_: Whole-note chord, fixed 4/4 duration, whole duration

**Beat**:
An ordered pulse belonging to exactly one Bar. The first Beat of a Bar has the downbeat role; downbeat is not an independent Timeline Entity.
_Avoid_: Beat timestamp, independent downbeat

**Tempo View**:
A deterministic interpretation of Beat spacing as local or smoothed beats per minute. It is derived from the Bar grid and cannot independently override Beat positions.
_Avoid_: Tempo Track, canonical BPM

**Unmetered Region**:
A Project Time interval outside a reliable Bar grid where timed content remains valid using seconds-derived presentation fallback.
_Avoid_: Missing timeline, silence

**Section Region**:
A non-overlapping Project Time interval in the flat Section Track. Section Regions cover the Project Range and may carry a semantic label, a neutral label, or `unknown`; repeated regions remain distinct occurrences.
_Avoid_: Nested section, playlist chapter

**Key Region**:
A non-overlapping Project Time interval in the Key Track containing a structured tonic and mode assertion or `unknown`. Key Regions describe sounding pitch independently of transpose, capo, and enharmonic display preferences.
_Avoid_: Key string, transposed key

**Chord Event**:
A non-overlapping Project Time interval with a structured chord symbol or explicit `N`, plus confidence and provenance. Chord Events collectively cover the full Project Range independently of the Bar grid.
_Avoid_: Chord label, chord-at-beat

**Chord Identity**:
The normalized musical structure of a chord: root, quality, extensions, additions, alterations, omissions, and optional bass. Enharmonic spelling and display text do not change Chord Identity.
_Avoid_: Chord string, diagram name

**Reference Lyrics**:
The user-selected lyrical text supplied as evidence of the expected words, represented by a Lyrics Document and never generated or rewritten from audio. It may differ from the performed recording and is not treated as ground truth.
_Avoid_: Transcript, ASR output, canonical truth

**Lyrics Document**:
An immutable revision of Reference Lyrics obtained from an allowed provider, YouTube subtitles, or the user, preserving original text, line structure, language, and provenance. Text correction creates another Lyrics Document rather than mutating an alignment.
_Avoid_: Transcript, generated lyrics, aligned lyrics

**Lyrics Token Occurrence**:
One ordered token occurrence in a Lyrics Document, identified independently of its text so repeated words and lines remain distinct. It may receive one Project Time interval or remain unmatched in a Lyrics Alignment.
_Avoid_: Unique word, word string, array position

**Lyrics Alignment**:
The relationship between one Lyrics Document, one Analysis Revision, and available Project Time intervals for its token occurrences. Tokens may remain unmatched; alignment never rewrites the Lyrics Document.
_Avoid_: Timed lyrics document, transcript

**Alignment Job**:
A bounded offline job that relates one Lyrics Document to one existing Analysis Revision and publishes one Lyrics Alignment or a retryable failure. It is independent of the Analysis Job and never changes either input.
_Avoid_: Analysis stage, STT job, lyric correction

**Alignment Mismatch**:
A Reference Lyrics region for which the audio evidence does not support a reliable timing assignment and which therefore requires visibility or manual correction.
_Avoid_: Hallucination, missing lyric

**Lyrics Anchor**:
A user-authored constraint relating a boundary or span in a Lyrics Document to Project Time for alignment or manual correction. It stays separate from machine timing evidence and is scoped to the same Lyrics Document and Analysis Revision.
_Avoid_: Machine word timing, lyric rewrite, global marker

**Beginner View**:
A deterministic presentation derived from the Original chord vocabulary, including simplification and capo suggestions without changing stored Chord Events.
_Avoid_: Beginner analysis, easy chords

**Open Chords JSON Snapshot**:
A versioned deterministic semantic export of one immutable Active View snapshot, carrying Original Chord Identities, declared presentation transforms, its Effective Timeline, selected lyrics and alignment, safe provenance, and user-authorship attribution without edit history, Source media, or practice state.
_Avoid_: Portable Project Archive, Project Library backup, raw analysis dump

**ChordPro Projection**:
A deterministic compatibility-first lead-sheet projection of an Active View using standard ChordPro constructs, preserving exact chord text without silent simplification while explicitly reporting timing, confidence, provenance, and history losses.
_Avoid_: Canonical Project format, lossless export, Open Chords extension format

**LRC Projection**:
A line-timed projection containing only validated monotonic lyric-line onsets; unmatched lines are omitted and reported rather than assigned invented timestamps.
_Avoid_: Lyrics Alignment, word-timed canonical export, complete lyrics document

**PDF/Print Projection**:
An accessible, self-contained rendering of one Active View under a versioned layout profile with fixed fonts, locale, page geometry, pagination rules, and one deduplicated valid chord-diagram set for the selected instrument. It makes no PDF/A or PDF/UA conformance claim unless separately validated.
_Avoid_: Project backup, editable source, archival-conformance claim

**Export Receipt**:
The Project-owned record of one completed export, identifying the immutable Active View snapshot, export profile, output hash and location, and every reported omission or degradation without becoming an extra sidecar deliverable.
_Avoid_: Exported document, audit log, provenance manifest

**Portable Project Archive**:
A versioned, hash-manifested package of a complete Project and its retained non-derived history, with safe provenance and external model requirements. Source media is excluded by default; an explicit functional option may include only the verified Project Range.
_Avoid_: Open Chords JSON snapshot, Project Library backup, public share

**Project Revision**:
A schema-valid persisted revision of a Project created by save or migration. Migration produces a new Project Revision and preserves a recoverable prior revision rather than rewriting the only copy in place.
_Avoid_: Analysis Revision, autosave file

**Project Head**:
The durably committed reference to the current validated Project Revision. A mutation is not saved or acknowledged until the Head atomically identifies its complete persisted result.
_Avoid_: Renderer state, latest file, unsaved draft

**Imported Project Copy**:
A newly identified Project created when an otherwise valid Portable Project Archive conflicts with a different local history bearing the same Project identity. It preserves the imported history and origin identity as provenance without merging either Project.
_Avoid_: Merged Project, duplicate, overwritten Project

**Active View**:
The explicit selection of Analysis Revision, Edit Layer history position, optional Lyrics Document and Lyrics Alignment, and presentation settings used to materialize the current Effective Timeline.
_Avoid_: Latest state, project head

**Effective Timeline**:
The deterministic materialization of an Active View used by playback, practice, rendering, and export. It is derived state rather than another editable copy of the Musical Timeline.
_Avoid_: Final analysis, flattened project

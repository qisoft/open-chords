# Open Chords

Open Chords turns one selected range of a user-authorized recording into a locally stored, editable, timed musical project for playback, practice, and export.

## Language

**Project**:
A local single-user workspace for one selected time range of one media source, containing machine analysis, user edits, provenance, and practice state.
_Avoid_: Song, track, document

**Source**:
The local media file or YouTube video from which a Project range is selected. A Source is not stored inside a portable archive by default.
_Avoid_: Upload, song

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

**Timeline Entity**:
An identified machine-produced or user-authored section, meter region, bar, beat, chord event, or lyric interval in a Musical Timeline. Machine identity is scoped to one Analysis Revision and never implies identity across revisions.
_Avoid_: Array item, timestamp, annotation

**Assertion State**:
The status of a machine observation as asserted, low-confidence, or abstained. An abstention is unknown evidence and is distinct from the musical value `N`; user-authored assertions carry no invented machine confidence.
_Avoid_: Confidence percentage, valid flag

**Analysis Manifest**:
The immutable provenance record for an Analysis Revision, identifying its source material, canonical timebase, analyzer stages, artifacts, models, settings, versions, hashes, outcomes, and reproducibility conditions without exposing private machine paths.
_Avoid_: Log, environment dump, metadata bag

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

**Lyrics Document**:
An immutable revision of Reference Lyrics obtained from an allowed provider, YouTube subtitles, or the user, preserving original text, line structure, language, and provenance. Text correction creates another Lyrics Document rather than mutating an alignment.
_Avoid_: Transcript, generated lyrics, aligned lyrics

**Lyrics Alignment**:
The relationship between one Lyrics Document, one Analysis Revision, and available Project Time intervals for its token occurrences. Tokens may remain unmatched; alignment never rewrites the Lyrics Document.
_Avoid_: Timed lyrics document, transcript

**Alignment Mismatch**:
A Reference Lyrics region for which the audio evidence does not support a reliable timing assignment and which therefore requires visibility or manual correction.
_Avoid_: Hallucination, missing lyric

**Beginner View**:
A deterministic presentation derived from the Original chord vocabulary, including simplification and capo suggestions without changing stored Chord Events.
_Avoid_: Beginner analysis, easy chords

**Portable Project Archive**:
An export containing the Project's analysis, edits, metadata, and provenance, excluding Source audio unless the user explicitly opts in.
_Avoid_: Backup with audio, public share

**Project Revision**:
A schema-valid persisted revision of a Project created by save or migration. Migration produces a new Project Revision and preserves a recoverable prior revision rather than rewriting the only copy in place.
_Avoid_: Analysis Revision, autosave file

**Active View**:
The explicit selection of Analysis Revision, Edit Layer history position, optional Lyrics Document and Lyrics Alignment, and presentation settings used to materialize the current Effective Timeline.
_Avoid_: Latest state, project head

**Effective Timeline**:
The deterministic materialization of an Active View used by playback, practice, rendering, and export. It is derived state rather than another editable copy of the Musical Timeline.
_Avoid_: Final analysis, flattened project

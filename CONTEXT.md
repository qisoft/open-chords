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
The contiguous interval of a Source analyzed by one Project. Multiple Projects may refer to different ranges of the same long Source.
_Avoid_: Clip, song split

**Analysis**:
The immutable machine-produced musical observations for a Project Range, including confidence, provenance, model versions, and settings.
_Avoid_: Final result, truth

**Edit Layer**:
The nondestructive user-authored changes applied over an Analysis, with undo and reset semantics that preserve the original Analysis.
_Avoid_: Corrected analysis, overwrite

**Musical Timeline**:
The shared timebase containing sections, meters, bars, beats, chord events, and optional lyric word intervals for a Project Range.
_Avoid_: Chord sheet, waveform

**Chord Event**:
A time interval with a structured chord symbol or `N` for no asserted chord, plus confidence and provenance.
_Avoid_: Chord label

**Reference Lyrics**:
Lyrics obtained from an allowed provider, YouTube subtitles, or the user and used as fixed text input to alignment. Alignment may time or flag the text but does not rewrite it.
_Avoid_: Transcript, generated lyrics

**Alignment Mismatch**:
A Reference Lyrics region for which the audio evidence does not support a reliable timing assignment and which therefore requires visibility or manual correction.
_Avoid_: Hallucination, missing lyric

**Beginner View**:
A deterministic presentation derived from the Original chord vocabulary, including simplification and capo suggestions without changing stored Chord Events.
_Avoid_: Beginner analysis, easy chords

**Portable Project Archive**:
An export containing the Project's analysis, edits, metadata, and provenance, excluding Source audio unless the user explicitly opts in.
_Avoid_: Backup with audio, public share
